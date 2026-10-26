use crate::crawler::task_scheduler::PageStack;
use crate::emitter::GlobalEmitter;
#[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
use crate::plugin::vfs::{InputMount, PluginVfs};
use crate::plugin::Plugin;
use crate::storage::Storage;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{mpsc, oneshot};
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
    pub is_dry_run: bool,
    /// CLI `--freeze-template` 时冻结的插件描述模板，盖进本任务写入的每行 metadata。
    pub frozen_template: Option<Arc<str>>,
    /// 冻结时解析出的只读输入挂载；`Task::try_new` 会把它交给 VFS 并把 config 改写成虚拟路径。
    #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
    pub inputs: Vec<InputMount>,
}

impl TaskParams {
    pub fn plugin_version(&self) -> u32 {
        self.plugin.version_packed
    }

    pub fn base_url(&self) -> &str {
        &self.plugin.base_url
    }

    /// 下载是否交给本任务的 CEF 窗口执行（保留浏览器 Cookie / 登录态）。
    /// 普通插件看静态脚本类型；builtin `webpage` 看每次任务选择的后端。
    pub fn uses_webview_transport(&self) -> bool {
        self.plugin.script.is_webview()
            || crate::crawler::webpage::is_webview_task(&self.plugin.id, &self.config)
    }
}

pub struct WebviewSession {
    pub completion: Option<oneshot::Sender<TaskResult>>,
    /// WebView 心跳(bootstrap.js 每 60s invoke crawl_heartbeat);
    /// run_task 的看门狗 120s 未收到即判窗口无响应结束任务。
    pub heartbeat: mpsc::UnboundedSender<()>,
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
    /// 本任务下载并发上限，0 表示跟随全局；运行中可实时调整。
    max_downloads: AtomicU32,
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
        mut params: TaskParams,
        http_headers: Option<HashMap<String, String>>,
    ) -> Result<Self, String> {
        let fs_handle = random_fs_handle();
        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        let inputs = std::mem::take(&mut params.inputs);
        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        let vfs = create_plugin_vfs(&task_id, &params.plugin.id, fs_handle, inputs)?;
        // V8 的 `custom.<key>` 与 WebView 的 vars 都取自 `params.config`，
        // 改写成虚拟路径后两端都只能看到 VFS 内的只读路径。
        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        for key in vfs.input_keys() {
            if let Some(virtual_path) = vfs.input_virtual_path(key) {
                params.config.insert(
                    key.to_string(),
                    Value::String(virtual_path.to_string_lossy().into_owned()),
                );
            }
        }

        Ok(Self {
            task_id,
            params,
            cancel: CancellationToken::new(),
            fs_handle,
            #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
            vfs,
            progress: StdMutex::new(0.0),
            headers: StdMutex::new(http_headers.unwrap_or_default()),
            max_downloads: AtomicU32::new(0),
            page_stack: Arc::new(StdMutex::new(Vec::new())),
            webview: StdMutex::new(None),
        })
    }

    /// freeze 时注入任务记录里的初始值；保留原构造器签名供测试辅助代码使用。
    pub fn with_max_concurrent_downloads(self, limit: Option<u32>) -> Self {
        self.max_downloads
            .store(limit.unwrap_or(0), Ordering::Relaxed);
        self
    }

    pub fn max_concurrent_downloads(&self) -> Option<u32> {
        match self.max_downloads.load(Ordering::Relaxed) {
            0 => None,
            limit => Some(limit),
        }
    }

    /// 先持久化，再更新运行时字段并广播差量，避免内存与数据库状态分叉。
    pub fn set_max_concurrent_downloads(&self, limit: Option<u32>) -> Result<(), String> {
        Storage::global().set_task_max_concurrent_downloads(&self.task_id, limit)?;
        self.max_downloads
            .store(limit.unwrap_or(0), Ordering::Relaxed);
        GlobalEmitter::global().emit_task_changed(
            &self.task_id,
            serde_json::json!({ "maxConcurrentDownloads": limit }),
        );
        Ok(())
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

    /// 写入一行图片 metadata。plugin_id、packed 版本与冻结模板由本任务参数盖章
    /// （应用维护，插件不可传入）；WebView `downloadImage` 与 V8 ops 共用此入口。
    pub fn insert_metadata(
        &self,
        value: &Value,
        search_terms: Option<Vec<String>>,
    ) -> Result<i64, String> {
        if self.params.is_dry_run {
            return Ok(0);
        }
        Storage::global().insert_metadata_row(
            value,
            &self.params.plugin.id,
            self.params.plugin_version(),
            self.params.frozen_template.as_deref(),
            search_terms,
        )
    }

    /// 空跑跳过一次下载 / 导入：复用 `dedup_count` 计数（空跑下语义为「跳过」），
    /// 并推送计数 diff，前端与 CLI 沿用去重计数的展示通路。
    pub fn record_dry_run_skip(&self) {
        if let Ok(n) = Storage::global().increment_task_dedup_count(&self.task_id) {
            GlobalEmitter::global().emit_task_image_counts(
                &self.task_id,
                None,
                None,
                None,
                Some(n),
            );
        }
    }

    pub fn with_stack_top<T>(
        &self,
        f: impl FnOnce(&crate::crawler::task_scheduler::PageStackEntry) -> T,
    ) -> Option<T> {
        let guard = self.page_stack.lock().unwrap();
        guard.last().map(f)
    }

    pub fn begin_webview_session(
        &self,
    ) -> Result<(oneshot::Receiver<TaskResult>, mpsc::UnboundedReceiver<()>), String> {
        let (completion_tx, completion_rx) = oneshot::channel();
        let (heartbeat_tx, heartbeat_rx) = mpsc::unbounded_channel();
        let mut guard = self.webview.lock().unwrap();
        if guard.is_some() {
            return Err(format!(
                "Crawler session already exists for task {}",
                self.task_id
            ));
        }
        *guard = Some(WebviewSession {
            completion: Some(completion_tx),
            heartbeat: heartbeat_tx,
            state: Value::Object(serde_json::Map::new()),
        });
        Ok((completion_rx, heartbeat_rx))
    }

    /// WebView 心跳上报(crawl_heartbeat 命令)。会话不存在或接收端已结束时静默忽略。
    pub fn heartbeat_webview(&self) {
        let guard = self.webview.lock().unwrap();
        if let Some(session) = guard.as_ref() {
            let _ = session.heartbeat.send(());
        }
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
    inputs: Vec<InputMount>,
) -> Result<Arc<PluginVfs>, String> {
    PluginVfs::new(fs_handle, plugin_id)
        .map(|vfs| Arc::new(vfs.with_inputs(inputs)))
        .map_err(|error| {
            format!(
                "Failed to initialize plugin VFS for task {task_id} (plugin {plugin_id}): {error}"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::vfs::{InputKind, InputMount};
    use std::path::Path;

    fn test_plugin() -> Plugin {
        serde_json::from_value(serde_json::json!({
            "id": "input-mount-test",
            "name": "Input Mount Test",
            "description": "",
            "version": "1.0.0",
            "baseUrl": "https://example.com",
            "sizeBytes": 0,
            "config": {},
            "scriptType": "v8",
        }))
        .expect("valid plugin")
    }

    #[test]
    fn dry_run_insert_metadata_returns_zero_without_storage_write() {
        crate::app_paths::AppPaths::init_for_tests();
        let run = Task::new(
            "task-dry-run-metadata-test".to_string(),
            TaskParams {
                plugin: Arc::new(test_plugin()),
                images_dir: PathBuf::new(),
                output_album_id: None,
                config: HashMap::new(),
                is_dry_run: true,
                frozen_template: None,
                #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
                inputs: Vec::new(),
            },
            None,
        );

        assert_eq!(
            run.insert_metadata(&serde_json::json!({ "title": "ignored" }), None),
            Ok(0)
        );
    }

    #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
    #[test]
    fn try_new_mounts_inputs_and_rewrites_config_to_virtual_paths() {
        crate::app_paths::AppPaths::init_for_tests();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("a.png");
        std::fs::write(&source, b"png").unwrap();

        let mut config = HashMap::new();
        config.insert(
            "src".to_string(),
            Value::String(source.to_string_lossy().into_owned()),
        );
        config.insert("tag".to_string(), Value::String("keep".to_string()));

        let run = Task::try_new(
            "task-input-mount-test".to_string(),
            TaskParams {
                plugin: Arc::new(test_plugin()),
                images_dir: PathBuf::new(),
                output_album_id: None,
                config,
                is_dry_run: false,
                frozen_template: None,
                inputs: vec![InputMount {
                    key: "src".to_string(),
                    kind: InputKind::File {
                        host: source.clone(),
                        name: "a.png".to_string(),
                    },
                }],
            },
            None,
        )
        .unwrap();

        let virtual_path = format!("/{}/input/src/a.png", run.fs_handle);
        assert_eq!(
            run.params.config.get("src").and_then(Value::as_str),
            Some(virtual_path.as_str())
        );
        // 非路径变量原样保留。
        assert_eq!(
            run.params.config.get("tag").and_then(Value::as_str),
            Some("keep")
        );
        // VFS 已挂载且可按虚拟路径读回同一份内容。
        assert_eq!(run.vfs.input_keys(), ["src"]);
        assert_eq!(
            run.vfs
                .host_path_for_read(Path::new(&virtual_path))
                .unwrap(),
            source
        );
    }
}
