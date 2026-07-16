use crate::crawler::task_scheduler::PageStack;
use crate::emitter::GlobalEmitter;
use crate::plugin::Plugin;
use crate::storage::Storage;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq)]
pub enum TaskError {
    Canceled,
    Other(String),
}

pub type TaskResult = Result<(), TaskError>;

/// 提交入队时冻结的运行参数。
pub struct TaskParams {
    pub plugin: Arc<Plugin>,
    pub images_dir: PathBuf,
    pub output_album_id: Option<String>,
    pub config: HashMap<String, Value>,
}

impl TaskParams {
    pub fn plugin_version(&self) -> u32 {
        self.plugin.version_packed
    }

    pub fn base_url(&self) -> &str {
        &self.plugin.base_url
    }
}

pub struct WebviewSession {
    pub completion: Option<oneshot::Sender<TaskResult>>,
    pub state: Value,
}

pub struct Task {
    pub task_id: String,
    pub params: TaskParams,
    pub cancel: CancellationToken,
    progress: StdMutex<f64>,
    headers: StdMutex<HashMap<String, String>>,
    pub page_stack: PageStack,
    webview: StdMutex<Option<WebviewSession>>,
}

impl Task {
    pub fn new(
        task_id: String,
        params: TaskParams,
        http_headers: Option<HashMap<String, String>>,
    ) -> Self {
        Self {
            task_id,
            params,
            cancel: CancellationToken::new(),
            progress: StdMutex::new(0.0),
            headers: StdMutex::new(http_headers.unwrap_or_default()),
            page_stack: Arc::new(StdMutex::new(Vec::new())),
            webview: StdMutex::new(None),
        }
    }

    pub fn add_progress(&self, delta: f64) -> f64 {
        let progress = {
            let mut guard = self.progress.lock().unwrap();
            *guard = (*guard + delta).clamp(0.0, 99.9);
            *guard
        };

        let storage = Storage::global();
        if let Ok(Some(mut task)) = storage.get_task(&self.task_id) {
            task.progress = progress;
            let _ = storage.update_task(task);
        }
        GlobalEmitter::global().emit_task_progress(&self.task_id, progress);
        progress
    }

    pub fn set_progress(&self, progress: f64) -> f64 {
        let progress = progress.clamp(0.0, 100.0);
        {
            let mut guard = self.progress.lock().unwrap();
            *guard = progress;
        }
        let storage = Storage::global();
        if let Ok(Some(mut task)) = storage.get_task(&self.task_id) {
            task.progress = progress;
            let _ = storage.update_task(task);
        }
        GlobalEmitter::global().emit_task_progress(&self.task_id, progress);
        progress
    }

    pub fn set_header(&self, name: String, value: String) -> Result<(), String> {
        {
            let mut headers = self.headers.lock().unwrap();
            headers.insert(name, value);
            self.persist_headers_locked(&headers)?;
        }
        Ok(())
    }

    pub fn del_header(&self, name: &str) -> Result<(), String> {
        {
            let mut headers = self.headers.lock().unwrap();
            headers.remove(name);
            self.persist_headers_locked(&headers)?;
        }
        Ok(())
    }

    pub fn merge_headers(
        &self,
        extra: Option<HashMap<String, String>>,
        cookie: Option<String>,
    ) -> Result<HashMap<String, String>, String> {
        let merged = {
            let mut headers = self.headers.lock().unwrap();
            if let Some(extra) = extra {
                for (k, v) in extra {
                    headers.insert(k, v);
                }
            }
            if let Some(cookie) = cookie {
                headers.insert("Cookie".to_string(), cookie);
            }
            self.persist_headers_locked(&headers)?;
            headers.clone()
        };
        Ok(merged)
    }

    pub fn headers_snapshot(&self) -> HashMap<String, String> {
        self.headers.lock().unwrap().clone()
    }

    pub fn current_page_url(&self) -> Option<String> {
        self.with_stack_top(|entry| entry.url.clone())
    }

    pub fn with_stack_top<T>(
        &self,
        f: impl FnOnce(&crate::crawler::task_scheduler::PageStackEntry) -> T,
    ) -> Option<T> {
        let guard = self.page_stack.lock().unwrap();
        guard.last().map(f)
    }

    pub fn begin_webview_session(&self) -> Result<oneshot::Receiver<TaskResult>, String> {
        let (completion_tx, completion_rx) = oneshot::channel();
        let mut guard = self.webview.lock().unwrap();
        if guard.is_some() {
            return Err(format!(
                "Crawler session already exists for task {}",
                self.task_id
            ));
        }
        *guard = Some(WebviewSession {
            completion: Some(completion_tx),
            state: Value::Object(serde_json::Map::new()),
        });
        Ok(completion_rx)
    }

    pub fn complete_webview(&self, result: TaskResult) -> bool {
        let tx = {
            let mut guard = self.webview.lock().unwrap();
            guard.as_mut().and_then(|session| session.completion.take())
        };
        if let Some(tx) = tx {
            let _ = tx.send(result);
            true
        } else {
            false
        }
    }

    pub fn webview_state(&self) -> Value {
        let guard = self.webview.lock().unwrap();
        guard
            .as_ref()
            .map(|session| session.state.clone())
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
    }

    pub fn set_webview_state(&self, state: Value) -> Value {
        let mut guard = self.webview.lock().unwrap();
        if let Some(session) = guard.as_mut() {
            session.state = state.clone();
        }
        state
    }

    fn persist_headers_locked(&self, headers: &HashMap<String, String>) -> Result<(), String> {
        let storage = Storage::global();
        let Some(mut task) = storage.get_task(&self.task_id)? else {
            return Ok(());
        };
        task.http_headers = Some(headers.clone());
        storage.update_task(task)
    }
}
