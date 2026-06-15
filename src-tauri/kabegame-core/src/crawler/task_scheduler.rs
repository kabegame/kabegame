use crate::crawler::downloader::{
    get_default_images_dir, resolve_crawl_output_dir, ActiveDownloadInfo, DownloadQueue,
};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::plugin::{check_min_app_version, PluginManager, VarDefinition, VarOption};
use crate::schedule_sync::on_crawl_task_reached_terminal;
use crate::settings::Settings;
use crate::storage::tasks::TaskStatus;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tokio::task::JoinHandle;
use url::Url;

/// 任务 worker 协程数量上限（与设置「同时运行任务数」1~10 一致；实际并发由 `wait_for_task_slot` 与设置共同限制）。
pub const MAX_TASK_WORKER_LOOPS: usize = 10;

/// 首次进入 WebView 爬虫时的 page_label（ctx.pageLabel 的初始值）。
#[cfg(not(target_os = "android"))]
const INITIAL_PAGE_LABEL: &str = "initial";

#[cfg(not(target_os = "android"))]
use crate::crawler::webview::{
    crawler_window_state, get_webview_handler, pathbuf_to_string, JsTaskContext,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlTaskRequest {
    /// 数据库任务记录 id；run_task 通过它从 Storage 读取完整 TaskInfo
    pub task_id: String,
    /// 可选：直接从指定 .kgpg 文件运行（用于插件编辑器/临时插件）
    #[serde(default)]
    pub plugin_file_path: Option<String>,
}

/// 一次状态跳转附带的元数据（时间戳、错误信息）。
pub struct TaskTransition {
    pub start_time: Option<u64>,
    pub end_time: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct TaskScheduler {
    // 下载队列
    download_queue: Arc<DownloadQueue>,
    queue_tx: mpsc::UnboundedSender<CrawlTaskRequest>,
    queue_rx: Arc<Mutex<mpsc::UnboundedReceiver<CrawlTaskRequest>>>,
    running_workers: Arc<AtomicUsize>,
    page_stacks: Arc<PageStackStore>,
    /// 有任务结束或「同时运行任务数」设置变更时唤醒，避免等待槽位时忙等。
    task_slot_notify: Arc<Notify>,
    /// 待取消的任务列表
    pub canceled_tasks: Arc<RwLock<HashSet<String>>>,
}

#[derive(Debug, Clone)]
pub struct PageStackEntry {
    pub url: String,
    pub html: String,
    /// 最后一次成功 HTTP 响应头（小写名；同名多值用 `, ` 拼接），Rhai `current_headers()` 读取。
    pub headers: HashMap<String, String>,
    pub page_label: String,
    pub page_state: serde_json::Value,
}

pub type PageStack = Arc<StdMutex<Vec<PageStackEntry>>>;

pub struct PageStackStore {
    stacks: RwLock<HashMap<String, PageStack>>,
}

impl PageStackStore {
    pub fn new() -> Self {
        Self {
            stacks: RwLock::new(HashMap::new()),
        }
    }

    pub async fn create_stack(&self, task_id: &str) -> PageStack {
        let stack = Arc::new(StdMutex::new(Vec::new()));
        let mut guard = self.stacks.write().await;
        guard.insert(task_id.to_string(), Arc::clone(&stack));
        stack
    }

    pub async fn get_stack(&self, task_id: &str) -> Option<PageStack> {
        let guard = self.stacks.read().await;
        guard.get(task_id).cloned()
    }

    pub fn get_stack_sync(&self, task_id: &str) -> Option<PageStack> {
        tokio::runtime::Handle::current().block_on(self.get_stack(task_id))
    }

    pub async fn remove_stack(&self, task_id: &str) {
        let mut guard = self.stacks.write().await;
        guard.remove(task_id);
    }
}

// 全局 TaskScheduler 单例
static TASK_SCHEDULER: OnceLock<TaskScheduler> = OnceLock::new();

impl TaskScheduler {
    pub fn new(download_queue: Arc<DownloadQueue>) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel();
        let s = Self {
            download_queue,
            queue_tx,
            queue_rx: Arc::new(Mutex::new(queue_rx)),
            running_workers: Arc::new(AtomicUsize::new(0)),
            page_stacks: Arc::new(PageStackStore::new()),
            task_slot_notify: Arc::new(Notify::new()),
            canceled_tasks: Arc::new(RwLock::new(HashSet::new()))
        };
        s
    }

    pub async fn start_workers(&self, count: usize) {
        for _ in 0..count {
            let download_queue = Arc::clone(&self.download_queue);
            let queue_rx = Arc::clone(&self.queue_rx);
            let running = Arc::clone(&self.running_workers);
            let scheduler = self.clone();
            tokio::spawn(async move {
                worker_loop(scheduler, download_queue, queue_rx, running).await;
            });
        }
    }

    /// 入队一个任务：
    /// - 若有空闲 task worker，会很快被取走并进入 running
    /// - 若当前 10 个 worker 都忙，则任务保持 pending 并排队等待
    pub fn enqueue(&self, req: CrawlTaskRequest) -> Result<(), String> {
        // 先保证 DB 状态为 pending（创建任务默认是Pending，但这里做幂等兜底）
        let storage = Storage::global();
        // let emitter = GlobalEmitter::global();
        let _ = persist_task_status(storage, &req.task_id, TaskStatus::Pending, None, None, None);
        GlobalEmitter::global().emit_task_changed(&req.task_id, json!({ "status": "pending" }));

        self.queue_tx
            .send(req)
            .map_err(|e| format!("Failed to enqueue task: {}", e))
    }

    /// 获取当前正在下载的任务列表
    pub async fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        self.download_queue.get_active_downloads().await
    }

    /// 提交新任务
    pub fn submit_task(&self, req: CrawlTaskRequest) -> Result<String, String> {
        self.enqueue(req.clone())?;
        Ok(req.task_id)
    }

    /// 取消任务（标记取消 + 唤醒等待中的下载）
    pub async fn cancel_task(&self, task_id: &str) {
        // 这里用active_downloads，存在竞态：不在该列表，但即将进入该列表的下载
        self.download_queue.cancel_task_downloads(task_id).await;
        self.canceled_tasks.write().await.insert(task_id.into());
        self.download_queue.capacity_notify.notify_waiters(); // 唤醒被阻塞的 download() 调用，让它们检查取消状态
    }

    pub async fn is_task_canceled(&self, task_id: &str) -> bool {
        self.canceled_tasks.read().await.contains(task_id)
    }

    /// 同步版本，供非 async 上下文调用（内部 block_on）。
    pub fn is_task_canceled_blocking(&self, task_id: &str) -> bool {
        tokio::runtime::Handle::current().block_on(self.is_task_canceled(task_id))
    }

    #[allow(dead_code)]
    pub fn running_worker_count(&self) -> usize {
        self.running_workers.load(Ordering::Relaxed)
    }

    /// 失败图片重试：spawn 异步任务入队，立即返回；可在等待容量期间 `cancel_retry_failed_image` abort。
    pub async fn retry_failed_image(&self, failed_id: i64) -> Result<(), String> {
        let storage = Storage::global();
        let item = Storage::get_task_failed_image_by_id(failed_id)?
            .ok_or_else(|| "失败图片记录不存在".to_string())?;

        let task_opt = storage
            .get_task(&item.task_id)?;

        let images_dir = task_opt
            .clone()
            .and_then(|t| 
                t.output_dir.as_deref().map(std::path::PathBuf::from)
            )
            .unwrap_or_else(|| get_default_images_dir());

        let start_time = if item.order > 0 {
            item.order as u64
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        };

        let url = Url::parse(&item.url).map_err(|e| format!("Invalid URL: {}", e))?;
        let task_opt_for_headers = task_opt.clone();
        let retry_headers = item
            .header_snapshot
            .filter(|headers| !headers.is_empty())
            .unwrap_or_else(|| task_opt_for_headers
                .and_then(
                    |t| {
                        t.http_headers.clone()
                    }).unwrap_or_default()
                );

        let output_album_id = task_opt.clone().and_then(|t| 
            t.output_album_id.clone()
        );

        self.download_queue.download_image_retry(
            failed_id,
            url,
            images_dir,
            item.plugin_id,
            item.task_id,
            start_time,
            output_album_id,
            retry_headers,
            item.metadata_id,
            item.display_name,
        ).await
    }

    /// 批量重试（前端已按插件筛选）；跳过已有 handle 的 id。
    pub async fn retry_failed_images(&self, failed_ids: &[i64]) -> Result<Vec<i64>, String> {
        let mut retried = Vec::new();
        for &id in failed_ids {
            if self.retry_failed_image(id).await.is_ok() {
                retried.push(id);
            }
        }
        Ok(retried)
    }

    // 取消重试图片
    pub async fn cancel_retry_failed_image(&self, failed_id: i64) -> bool {
        self.download_queue.cancel_retried_download(failed_id).await
    }

    pub async fn cancel_retry_failed_images(&self, failed_ids: &[i64]) {
        for &id in failed_ids {
            self.download_queue.cancel_retried_download(id).await;
        }
    }

    pub async fn set_download_concurrency(&self) {
        self.download_queue
            .set_desired_concurrency_from_settings()
            .await;
        self.download_queue.notify_all_waiting();
    }

    /// 写入「同时运行任务数」设置后调用即可（不阻塞）。缩容由运行中任务结束自然释放槽位；增大会唤醒等待中的 worker。
    pub fn set_task_concurrency(&self) {
        self.task_slot_notify.notify_waiters();
    }

    /// 初始化全局 TaskScheduler（必须在首次使用前调用）
    pub fn init_global(download_queue: Arc<DownloadQueue>) -> Result<(), String> {
        let scheduler = Self::new(download_queue);
        TASK_SCHEDULER
            .set(scheduler)
            .map_err(|_| "TaskScheduler already initialized".to_string())?;
        Ok(())
    }

    /// 获取全局 TaskScheduler 引用
    pub fn global() -> &'static TaskScheduler {
        TASK_SCHEDULER
            .get()
            .expect("TaskScheduler not initialized. Call TaskScheduler::init_global() first.")
    }

    /// 获取 DownloadQueue（用于需要 DownloadQueue 的地方）
    pub fn download_queue(&self) -> Arc<DownloadQueue> {
        Arc::clone(&self.download_queue)
    }

    /// 获取页面栈存储（task_id -> 页面栈）
    pub fn page_stacks(&self) -> Arc<PageStackStore> {
        Arc::clone(&self.page_stacks)
    }

    /// 启动下载 worker（先根据设置设置并发数并 spawn 对应数量，避免 total_workers 仍为 0 时 spawn 0 个 worker）
    pub async fn start_download_workers_async(&self) {
        // 启动时清理上次残留下的溢写临时文件
        crate::crawler::downloader::clear_downloads_temp_dir().await;
        let dq = self.download_queue();
        dq.set_desired_concurrency_from_settings().await;
        dq.notify_all_waiting();
    }

    /// 校验并执行一次任务状态跳转：FSM 合法才持久化 + 终态钩子 + 发事件。
    /// 非法跳转：warn 记录 `current -> next`，不改不发，返回 false。
    pub fn transition(&self, task_id: &str, next: TaskStatus, t: TaskTransition) -> bool {
        let storage = Storage::global();
        let Ok(Some(mut task)) = storage.get_task(task_id) else {
            return false;
        };
        let current = task.status;
        if !current.can_transition_to(next) {
            eprintln!("[Task FSM] reject {task_id}: {current:?} -> {next:?}");
            return false;
        }
        task.status = next;
        if t.start_time.is_some() {
            task.start_time = t.start_time;
        }
        if t.end_time.is_some() {
            task.end_time = t.end_time;
        }
        if t.error.is_some() {
            task.error = t.error;
        }
        if next == TaskStatus::Completed {
            task.progress = 100.0;
        }
        if storage.update_task(task).is_err() {
            return false;
        }
        if next.is_terminal() {
            on_crawl_task_reached_terminal(task_id);
        }
        GlobalEmitter::global().emit_task_status_from_storage(task_id);
        true
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn persist_task_status(
    storage: &Storage,
    task_id: &str,
    status: TaskStatus,
    start_time: Option<u64>,
    end_time: Option<u64>,
    error: Option<String>,
) -> Result<(), String> {
    let Some(mut task) = storage.get_task(task_id)? else {
        return Ok(());
    };

    task.status = status;
    if start_time.is_some() {
        task.start_time = start_time;
    }
    if end_time.is_some() {
        task.end_time = end_time;
    }
    if error.is_some() {
        task.error = error;
    }
    storage.update_task(task)?;
    if status.is_terminal() {
        on_crawl_task_reached_terminal(task_id);
    }
    Ok(())
}

/// 按当前「同时运行任务数」设置占用槽位（`running` +1）；若已满则等待直至有任务结束或设置增大。
async fn wait_for_task_slot(running: &Arc<AtomicUsize>, notify: &Arc<Notify>) {
    loop {
        let max = Settings::global().get_max_concurrent_tasks().clamp(1, 10) as usize;
        let r = running.load(Ordering::Acquire);
        if r < max {
            if running
                .compare_exchange_weak(r, r + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return;
            }
            continue;
        }
        let notified = notify.notified();
        tokio::pin!(notified);
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(Duration::from_millis(1000)) => {}
        }
    }
}

async fn worker_loop(
    scheduler: TaskScheduler,
    download_queue: Arc<DownloadQueue>,
    queue_rx: Arc<Mutex<mpsc::UnboundedReceiver<CrawlTaskRequest>>>,
    running: Arc<AtomicUsize>,
) {
    let storage = Storage::global();

    loop {
        let req = {
            let mut rx = queue_rx.lock().await;
            rx.recv().await
        };

        let Some(req) = req else {
            continue;
        };

        // 若任务已取消（排队期间），直接 canceled
        if scheduler.is_task_canceled(&req.task_id).await {
            let end = now_ms();
            scheduler.transition(
                &req.task_id,
                TaskStatus::Canceled,
                TaskTransition {
                    start_time: None,
                    end_time: Some(end),
                    error: Some("Task canceled".to_string()),
                },
            );
            continue;
        }

        wait_for_task_slot(&running, &scheduler.task_slot_notify).await;

        // running
        let start = now_ms();
        scheduler.transition(
            &req.task_id,
            TaskStatus::Running,
            TaskTransition {
                start_time: Some(start),
                end_time: None,
                error: None,
            },
        );

        let page_stacks = scheduler.page_stacks();
        page_stacks.create_stack(&req.task_id).await;
        let res = run_task(&storage, Arc::clone(&download_queue), &req).await;
        let mut keep_page_stack = false;

        match res {
            Ok(TaskOutcome::Completed) => {
                let end = now_ms();
                if scheduler.is_task_canceled(&req.task_id).await {
                    scheduler.transition(
                        &req.task_id,
                        TaskStatus::Canceled,
                        TaskTransition {
                            start_time: None,
                            end_time: Some(end),
                            error: Some("Task canceled".to_string()),
                        },
                    );
                    // 清理canceled_tasks
                    scheduler.canceled_tasks.write().await.retain(|d| *d != req.task_id);
                } else {
                    scheduler.transition(
                        &req.task_id,
                        TaskStatus::Completed,
                        TaskTransition {
                            start_time: None,
                            end_time: Some(end),
                            error: None,
                        },
                    );
                }
            }
            Ok(TaskOutcome::HandedOffToWebView) => {
                keep_page_stack = true;
                GlobalEmitter::global().emit_task_log(
                    &req.task_id,
                    "info",
                    &task_log_i18n("taskLogSchedulerJsHandoff", json!({})),
                );
            }
            Err(e) => {
                let is_canceled = scheduler.is_task_canceled(&req.task_id).await;
                let end = now_ms();
                let next = if is_canceled {
                    scheduler.canceled_tasks.write().await.retain(|d| *d != req.task_id);
                    TaskStatus::Canceled
                } else {
                    TaskStatus::Failed
                };
                scheduler.transition(
                    &req.task_id,
                    next,
                    TaskTransition {
                        start_time: None,
                        end_time: Some(end),
                        error: Some(e),
                    },
                );
            }
        }
        if !keep_page_stack {
            page_stacks.remove_stack(&req.task_id).await;
        }

        running.fetch_sub(1, Ordering::Relaxed);
        scheduler.task_slot_notify.notify_one();
    }
}

#[derive(Debug, Clone, Copy)]
enum TaskOutcome {
    Completed,
    HandedOffToWebView,
}

async fn run_task(
    storage: &Storage,
    download_queue: Arc<DownloadQueue>,
    req: &CrawlTaskRequest,
) -> Result<TaskOutcome, String> {
    let task = storage
        .get_task(&req.task_id)?
        .ok_or_else(|| format!("任务记录不存在: {}", req.task_id))?;

    let plugin_manager = PluginManager::global();
    GlobalEmitter::global().emit_task_log(
        &req.task_id,
        "info",
        &task_log_i18n(
            "taskLogSchedulerStart",
            json!({ "pluginId": task.plugin_id, "taskId": req.task_id }),
        ),
    );

    // 内置本地导入：不运行 Rhai，直接执行内置例程
    if task.plugin_id == "local-import" {
        crate::crawler::local_import::run_builtin_local_import(
            &req.task_id,
            task.user_config.clone(),
            task.output_album_id.clone(),
        )
        .await?;
        return Ok(TaskOutcome::Completed);
    }

    // 两种运行模式：
    // 1) 已安装插件：通过 plugin_id 查找并运行
    // 2) TODO: 临时插件文件：通过 plugin_file_path 读取 manifest/config 并运行（不要求安装）
    let (plugin, _plugin_file_path) = plugin_manager
        .resolve_plugin_for_task_request(&task.plugin_id, req.plugin_file_path.as_deref())
        .await?;
    if let Some(ref min_ver) = plugin.min_app_version {
        check_min_app_version(env!("CARGO_PKG_VERSION"), min_ver)?;
    }
    let images_dir = resolve_crawl_output_dir(task.output_dir.as_deref());

    // 从 Plugin 结构读取脚本和变量定义（已在 parse_kgpg 阶段加载到内存）
    let rhai_script = plugin.rhai_script.clone();
    #[cfg(not(target_os = "android"))]
    let js_script = plugin.js_script.clone();

    // merged_config：默认值 -> 用户覆盖 -> checkbox 规范化（与 crawl_images 保持一致）
    let user_cfg = task.user_config.clone().unwrap_or_default();
    let var_defs = plugin.var_defs.clone();
    let merged_config = build_effective_user_config_from_var_defs(&var_defs, user_cfg);

    #[cfg(not(target_os = "android"))]
    if let Some(crawl_js) = js_script {
        let state = crawler_window_state();
        let context = JsTaskContext {
            task_id: req.task_id.clone(),
            plugin_id: plugin.id.clone(),
            crawl_js,
            merged_config,
            base_url: plugin.base_url.clone(),
            current_url: None,
            page_label: INITIAL_PAGE_LABEL.to_string(),
            page_state: Some(serde_json::Value::Object(serde_json::Map::new())),
            state: Some(serde_json::Value::Object(serde_json::Map::new())),
            resume_mode: INITIAL_PAGE_LABEL.to_string(),
            images_dir: pathbuf_to_string(&images_dir),
            output_album_id: task.output_album_id.clone(),
            http_headers: task.http_headers.clone().unwrap_or_default(),
        };

        state.assign_task(context).await?;
        let Some(handler) = get_webview_handler() else {
            let _ = state.release_task(&req.task_id).await;
            return Err("Crawler webview handler is not initialized".to_string());
        };

        let base_url = if plugin.base_url.trim().is_empty() {
            "about:blank".to_string()
        } else {
            plugin.base_url.clone()
        };

        if let Err(e) = handler.setup_js_task(&req.task_id, &base_url).await {
            let _ = state.release_task(&req.task_id).await;
            return Err(e);
        }

        return Ok(TaskOutcome::HandedOffToWebView);
    }

    let rhai_script = rhai_script
        .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?;
    let plugin_for_exec = plugin.clone();
    let task_id = req.task_id.clone();
    let merged_config_for_exec = merged_config;
    let output_album_id = task.output_album_id.clone();
    let http_headers = task.http_headers.clone();

    tokio::task::spawn_blocking(move || {
        let mut rhai_runtime = crate::plugin::rhai::RhaiCrawlerRuntime::new(download_queue);
        crate::plugin::rhai::execute_crawler_script_with_runtime(
            &mut rhai_runtime,
            &plugin_for_exec,
            &images_dir,
            &plugin_for_exec.id,
            &task_id,
            &rhai_script,
            merged_config_for_exec,
            output_album_id,
            http_headers,
        )
    })
    .await
    .map_err(|e| format!("Task worker join error: {}", e))??;

    Ok(TaskOutcome::Completed)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CrawlResult {
    pub total: usize,
    pub downloaded: usize,
    pub images: Vec<ImageData>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub url: String,
    #[serde(rename = "localPath")]
    pub local_path: String,
    pub metadata: Option<HashMap<String, String>>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
}

/// 读取插件变量定义，合并默认值与用户配置，并对部分类型进行规范化（尤其是 checkbox）。
// fn build_effective_user_config(
//     plugin_id: &str,
//     user_config: Option<HashMap<String, serde_json::Value>>,
// ) -> Result<HashMap<String, serde_json::Value>, String> {
//     let plugin_manager = crate::plugin::PluginManager::global();
//     let user_cfg = user_config.unwrap_or_default();

//     // 读取插件变量定义（config.json 的 var）
//     let var_defs: Vec<VarDefinition> = Handle::current().block_on(plugin_manager
//         .get_plugin_vars(plugin_id))?
//         .unwrap_or_default();

//     Ok(build_effective_user_config_from_var_defs(
//         &var_defs, user_cfg,
//     ))
// }

/// 将变量定义（var_defs）的默认值与用户配置合并，并对部分类型做规范化。
///
/// 说明：
/// - 该函数不依赖 AppHandle，便于在 CLI/插件编辑器等场景复用（由调用方自行读取 var_defs）。
pub fn build_effective_user_config_from_var_defs(
    var_defs: &[VarDefinition],
    user_cfg: HashMap<String, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    // 先按 var_defs 填满所有变量（默认值 -> 用户值覆盖）
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
    for def in var_defs {
        let user_value = user_cfg.get(&def.key).cloned();
        let default_value = def.default.clone();
        let normalized = normalize_var_value(def, user_value.or(default_value));
        merged.insert(def.key.clone(), normalized);
    }

    // 再把 user_cfg 中那些不在 var_defs 里的键也注入（保持兼容扩展变量）
    for (k, v) in user_cfg {
        if !merged.contains_key(&k) {
            merged.insert(k, v);
        }
    }

    merged
}

fn extract_option_variables(options: &Option<Vec<VarOption>>) -> Vec<String> {
    match options {
        None => Vec::new(),
        Some(opts) => opts
            .iter()
            .filter_map(|o| match o {
                VarOption::String(s) => Some(s.clone()),
                VarOption::Item { variable, .. } => Some(variable.clone()),
            })
            .collect(),
    }
}

/// 将变量值规范化，确保脚本侧不会出现"变量不存在"或类型完全不匹配。
/// - checkbox：无论输入是 ["a","b"] 还是 {a:true,b:false}，都输出对象 { option: bool }
fn normalize_var_value(def: &VarDefinition, value: Option<serde_json::Value>) -> serde_json::Value {
    let t = def.var_type.as_str();
    match t {
        "checkbox" => {
            let vars = extract_option_variables(&def.options);
            let mut obj = serde_json::Map::new();
            for k in &vars {
                obj.insert(k.clone(), serde_json::Value::Bool(false));
            }

            match value {
                Some(serde_json::Value::Object(m)) => {
                    for (k, v) in m {
                        let b = match v {
                            serde_json::Value::Bool(b) => b,
                            serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                            serde_json::Value::String(s) => s == "true" || s == "1",
                            _ => false,
                        };
                        obj.insert(k, serde_json::Value::Bool(b));
                    }
                }
                Some(serde_json::Value::Array(arr)) => {
                    for it in arr {
                        if let serde_json::Value::String(s) = it {
                            obj.insert(s, serde_json::Value::Bool(true));
                        }
                    }
                }
                Some(serde_json::Value::String(s)) => {
                    obj.insert(s, serde_json::Value::Bool(true));
                }
                _ => {
                    // 无值：保持全 false（或由 config.json default 已经传入）
                }
            }
            serde_json::Value::Object(obj)
        }
        "int" => match value {
            Some(serde_json::Value::Number(n)) => {
                serde_json::Value::Number(serde_json::Number::from(n.as_i64().unwrap_or(0)))
            }
            Some(serde_json::Value::String(s)) => {
                serde_json::Value::Number(serde_json::Number::from(s.parse::<i64>().unwrap_or(0)))
            }
            Some(serde_json::Value::Bool(b)) => {
                serde_json::Value::Number(serde_json::Number::from(if b { 1 } else { 0 }))
            }
            _ => serde_json::Value::Number(serde_json::Number::from(0)),
        },
        "float" => match value {
            Some(serde_json::Value::Number(n)) => serde_json::Value::Number(
                serde_json::Number::from_f64(n.as_f64().unwrap_or(0.0)).unwrap(),
            ),
            Some(serde_json::Value::String(s)) => serde_json::Value::Number(
                serde_json::Number::from_f64(s.parse::<f64>().unwrap_or(0.0)).unwrap(),
            ),
            Some(serde_json::Value::Bool(b)) => serde_json::Value::Number(
                serde_json::Number::from_f64(if b { 1.0 } else { 0.0 }).unwrap(),
            ),
            _ => serde_json::Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        },
        "boolean" => match value {
            Some(serde_json::Value::Bool(b)) => serde_json::Value::Bool(b),
            Some(serde_json::Value::Number(n)) => {
                serde_json::Value::Bool(n.as_i64().unwrap_or(0) != 0)
            }
            Some(serde_json::Value::String(s)) => serde_json::Value::Bool(s == "true" || s == "1"),
            _ => serde_json::Value::Bool(false),
        },
        // options/list/string/其它：保持原样；若无值则给一个可用的空值，避免变量缺失
        "options" => match value {
            Some(v) => v,
            None => serde_json::Value::String(String::new()),
        },
        "string" | "date" => match value {
            Some(serde_json::Value::String(s)) => serde_json::Value::String(s),
            Some(v) => serde_json::Value::String(v.to_string()),
            None => serde_json::Value::String(String::new()),
        },
        "list" => match value {
            Some(serde_json::Value::Array(arr)) => serde_json::Value::Array(arr),
            Some(v) => v,
            None => serde_json::Value::Array(vec![]),
        },
        _ => value.unwrap_or(serde_json::Value::Null),
    }
}
