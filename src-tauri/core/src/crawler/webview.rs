use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsTaskContext {
    pub task_id: String,
    pub plugin_id: String,
    pub crawl_js: String,
    pub merged_config: HashMap<String, Value>,
    pub base_url: String,
    pub current_url: Option<String>,
    pub page_label: String,
    pub page_state: Option<Value>,
    pub resume_mode: String,
    pub images_dir: String,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
}

struct JsTaskSlot {
    context: JsTaskContext,
    _permit: OwnedSemaphorePermit,
}

#[derive(Default)]
pub struct JsTaskPatch {
    pub current_url: Option<String>,
    pub page_label: Option<String>,
    pub page_state: Option<Value>,
    pub resume_mode: Option<String>,
}

pub struct CrawlerWindowState {
    semaphore: Arc<Semaphore>,
    current_task: Mutex<Option<JsTaskSlot>>,
    page_ready_tx: watch::Sender<bool>,
    page_ready_rx: watch::Receiver<bool>,
    script_dispatched: AtomicBool,
}

impl CrawlerWindowState {
    pub fn new() -> Self {
        let (page_ready_tx, page_ready_rx) = watch::channel(false);
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
            current_task: Mutex::new(None),
            page_ready_tx,
            page_ready_rx,
            script_dispatched: AtomicBool::new(false),
        }
    }

    pub async fn assign_task(&self, context: JsTaskContext) -> Result<(), String> {
        let permit = Arc::clone(&self.semaphore)
            .acquire_owned()
            .await
            .map_err(|_| "Crawler window semaphore closed".to_string())?;
        let mut guard = self.current_task.lock().await;
        *guard = Some(JsTaskSlot {
            context,
            _permit: permit,
        });
        let _ = self.page_ready_tx.send(false);
        Ok(())
    }

    pub async fn get_context(&self) -> Option<JsTaskContext> {
        self.current_task
            .lock()
            .await
            .as_ref()
            .map(|slot| slot.context.clone())
    }

    pub fn try_get_context(&self) -> Option<JsTaskContext> {
        self.current_task
            .try_lock()
            .ok()?
            .as_ref()
            .map(|slot| slot.context.clone())
    }

    pub async fn patch_context_for_task(
        &self,
        task_id: &str,
        patch: JsTaskPatch,
    ) -> Result<(), String> {
        let mut guard = self.current_task.lock().await;
        let Some(slot) = guard.as_mut() else {
            return Err("Crawler window is idle".to_string());
        };
        if slot.context.task_id != task_id {
            return Err("Crawler window is occupied by another task".to_string());
        }

        if let Some(url) = patch.current_url {
            slot.context.current_url = Some(url);
        }
        if let Some(label) = patch.page_label {
            slot.context.page_label = label;
        }
        if let Some(state) = patch.page_state {
            slot.context.page_state = Some(state);
        }
        if let Some(mode) = patch.resume_mode {
            slot.context.resume_mode = mode;
        }
        Ok(())
    }

    pub async fn release_task(&self, task_id: &str) -> bool {
        let mut guard = self.current_task.lock().await;
        let should_release = guard
            .as_ref()
            .map(|slot| slot.context.task_id == task_id)
            .unwrap_or(false);
        if should_release {
            *guard = None;
            let _ = self.page_ready_tx.send(false);
            return true;
        }
        false
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
}

#[async_trait]
pub trait CrawlerWebViewHandler: Send + Sync + 'static {
    async fn setup_js_task(&self, task_id: &str, base_url: &str) -> Result<(), String>;
}

static CRAWLER_WINDOW_STATE: OnceLock<CrawlerWindowState> = OnceLock::new();
static CRAWLER_WEBVIEW_HANDLER: OnceLock<Arc<dyn CrawlerWebViewHandler>> = OnceLock::new();

pub fn crawler_window_state() -> &'static CrawlerWindowState {
    CRAWLER_WINDOW_STATE.get_or_init(CrawlerWindowState::new)
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
