use crate::crawler::task_scheduler::PageStack;
use crate::emitter::GlobalEmitter;
#[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
use crate::plugin::vfs::PluginVfs;
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
    pub fs_handle: u64,
    #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
    pub vfs: Arc<PluginVfs>,
    progress: StdMutex<f64>,
    headers: StdMutex<HashMap<String, String>>,
    pub page_stack: PageStack,
    webview: StdMutex<Option<WebviewSession>>,
}

impl Task {
    /// 保留给现有测试辅助代码的便捷构造器；生产注册路径使用 `try_new` 传播 VFS 错误。
    pub fn new(
        task_id: String,
        params: TaskParams,
        http_headers: Option<HashMap<String, String>>,
    ) -> Self {
        match Self::try_new(task_id, params, http_headers) {
            Ok(task) => task,
            Err(error) => panic!("Task construction failed: {error}"),
        }
    }

    pub fn try_new(
        task_id: String,
        params: TaskParams,
        http_headers: Option<HashMap<String, String>>,
    ) -> Result<Self, String> {
        let fs_handle = random_fs_handle();
        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        let vfs = create_plugin_vfs(&task_id, &params.plugin.id, fs_handle)?;

        Ok(Self {
            task_id,
            params,
            cancel: CancellationToken::new(),
            fs_handle,
            #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
            vfs,
            progress: StdMutex::new(0.0),
            headers: StdMutex::new(http_headers.unwrap_or_default()),
            page_stack: Arc::new(StdMutex::new(Vec::new())),
            webview: StdMutex::new(None),
        })
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

    /// 页面栈顶当前 HTML（V8 `Kabegame.currentHtml()`）。
    pub fn current_page_html(&self) -> Option<String> {
        self.with_stack_top(|entry| entry.html.clone())
    }

    /// 页面栈顶最后一次响应头（V8 `Kabegame.currentHeaders()`）。
    pub fn current_page_headers(&self) -> Option<HashMap<String, String>> {
        self.with_stack_top(|entry| entry.headers.clone())
    }

    /// 写入一行图片 metadata。plugin_id 与 packed 版本由本任务参数盖章
    /// （应用维护，插件不可传入）；WebView `downloadImage` 与 V8 ops 共用此入口。
    pub fn insert_image_metadata(&self, value: &Value) -> Result<i64, String> {
        Storage::global().insert_image_metadata_row(
            value,
            &self.params.plugin.id,
            self.params.plugin_version(),
        )
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

/// UUID v4 由系统随机源生成；将两半异或可保留完整 64 位随机输出。
fn random_fs_handle() -> u64 {
    let (high, low) = uuid::Uuid::new_v4().as_u64_pair();
    high ^ low
}

#[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
fn create_plugin_vfs(
    task_id: &str,
    plugin_id: &str,
    fs_handle: u64,
) -> Result<Arc<PluginVfs>, String> {
    PluginVfs::new(fs_handle, plugin_id)
        .map(Arc::new)
        .map_err(|error| {
            format!(
                "Failed to initialize plugin VFS for task {task_id} (plugin {plugin_id}): {error}"
            )
        })
}
