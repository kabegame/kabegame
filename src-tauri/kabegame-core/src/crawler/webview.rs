use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{oneshot, watch, Mutex};
use tokio::time::{timeout, Duration};

use crate::storage::tasks::TaskStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsTaskContext {
    pub task_id: String,
    pub plugin_id: String,
    /// 运行中插件的 packed 版本（每字节一段），metadata 写入盖章用；应用维护，插件不可读写。
    #[serde(default)]
    pub plugin_version: u32,
    pub crawl_js: String,
    pub merged_config: HashMap<String, Value>,
    pub base_url: String,
    pub current_url: Option<String>,
    pub page_label: String,
    pub page_state: Option<Value>,
    /// 整个任务上下文状态，由爬虫脚本通过 updateState 持久化，ctx.state 读取
    pub state: Option<Value>,
    pub resume_mode: String,
    pub images_dir: String,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
}

#[derive(Default)]
pub struct JsTaskPatch {
    pub current_url: Option<String>,
    pub page_label: Option<String>,
    pub page_state: Option<Value>,
    pub state: Option<Value>,
    pub resume_mode: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskCompletion {
    pub status: TaskStatus,
    pub error: Option<String>,
}

pub struct CrawlerSession {
    context: Mutex<JsTaskContext>,
    page_ready_tx: watch::Sender<bool>,
    page_ready_rx: watch::Receiver<bool>,
    script_dispatched: AtomicBool,
    completion: Mutex<Option<oneshot::Sender<TaskCompletion>>>,
}

impl CrawlerSession {
    pub fn new(
        context: JsTaskContext,
        completion_tx: oneshot::Sender<TaskCompletion>,
    ) -> Self {
        let (page_ready_tx, page_ready_rx) = watch::channel(false);
        Self {
            context: Mutex::new(context),
            page_ready_tx,
            page_ready_rx,
            script_dispatched: AtomicBool::new(false),
            completion: Mutex::new(Some(completion_tx)),
        }
    }

    pub async fn get_context(&self) -> Option<JsTaskContext> {
        Some(self.context.lock().await.clone())
    }

    pub fn try_get_context(&self) -> Option<JsTaskContext> {
        self.context.try_lock().ok().map(|ctx| ctx.clone())
    }

    pub async fn patch_context_for_task(
        &self,
        task_id: &str,
        patch: JsTaskPatch,
    ) -> Result<(), String> {
        let mut context = self.context.lock().await;
        if context.task_id != task_id {
            return Err("Crawler session belongs to another task".to_string());
        }

        if let Some(url) = patch.current_url {
            context.current_url = Some(url);
        }
        if let Some(label) = patch.page_label {
            context.page_label = label;
        }
        if let Some(state) = patch.page_state {
            context.page_state = Some(state);
        }
        if let Some(state) = patch.state {
            context.state = Some(state);
        }
        if let Some(mode) = patch.resume_mode {
            context.resume_mode = mode;
        }
        Ok(())
    }

    pub fn set_page_ready(&self, ready: bool) {
        let _ = self.page_ready_tx.send(ready);
        if !ready {
            self.script_dispatched.store(false, Ordering::Release);
        }
    }

    pub fn try_dispatch_script(&self) -> bool {
        !self.script_dispatched.swap(true, Ordering::AcqRel)
    }

    pub async fn wait_page_ready(&self) -> Result<(), String> {
        if *self.page_ready_rx.borrow() {
            return Ok(());
        }
        let mut rx = self.page_ready_rx.clone();
        timeout(Duration::from_secs(30), rx.wait_for(|ready| *ready))
            .await
            .map_err(|_| "Wait crawler page ready timed out".to_string())?
            .map_err(|_| "Crawler page ready channel closed".to_string())?;
        Ok(())
    }

    pub async fn complete(&self, status: TaskStatus, error: Option<String>) {
        let mut guard = self.completion.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(TaskCompletion { status, error });
        }
    }
}

#[async_trait]
pub trait CrawlerWebViewHandler: Send + Sync + 'static {
    async fn create_task_window(&self, task_id: &str, base_url: &str) -> Result<(), String>;
    async fn destroy_task_window(&self, task_id: &str) -> Result<(), String>;
}

static CRAWLER_SESSIONS: OnceLock<Mutex<HashMap<String, Arc<CrawlerSession>>>> = OnceLock::new();
static CRAWLER_WEBVIEW_HANDLER: OnceLock<Arc<dyn CrawlerWebViewHandler>> = OnceLock::new();

pub fn crawler_sessions() -> &'static Mutex<HashMap<String, Arc<CrawlerSession>>> {
    CRAWLER_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn register_session(
    task_id: &str,
    context: JsTaskContext,
) -> Result<(Arc<CrawlerSession>, oneshot::Receiver<TaskCompletion>), String> {
    let (completion_tx, completion_rx) = oneshot::channel();
    let session = Arc::new(CrawlerSession::new(context, completion_tx));
    let mut sessions = crawler_sessions().lock().await;
    if sessions.contains_key(task_id) {
        return Err(format!("Crawler session already exists for task {}", task_id));
    }
    sessions.insert(task_id.to_string(), Arc::clone(&session));
    Ok((session, completion_rx))
}

pub async fn get_session(task_id: &str) -> Option<Arc<CrawlerSession>> {
    crawler_sessions().lock().await.get(task_id).cloned()
}

pub fn try_get_session_context(task_id: &str) -> Option<JsTaskContext> {
    crawler_sessions()
        .try_lock()
        .ok()?
        .get(task_id)
        .and_then(|session| session.try_get_context())
}

pub async fn remove_session(task_id: &str) -> Option<Arc<CrawlerSession>> {
    crawler_sessions().lock().await.remove(task_id)
}

pub fn crawler_window_label(task_id: &str) -> String {
    format!("crawler-{task_id}")
}

pub fn task_id_from_crawler_label(label: &str) -> Option<&str> {
    label.strip_prefix("crawler-").filter(|id| !id.is_empty())
}

pub fn set_webview_handler(handler: Arc<dyn CrawlerWebViewHandler>) -> Result<(), String> {
    CRAWLER_WEBVIEW_HANDLER
        .set(handler)
        .map_err(|_| "Crawler webview handler already initialized".to_string())
}

pub fn get_webview_handler() -> Option<Arc<dyn CrawlerWebViewHandler>> {
    CRAWLER_WEBVIEW_HANDLER.get().cloned()
}

pub fn pathbuf_to_string(path: &PathBuf) -> String {
    path.to_string_lossy().to_string()
}
