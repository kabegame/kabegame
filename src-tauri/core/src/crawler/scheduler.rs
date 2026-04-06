use crate::crawler::downloader::{get_default_images_dir, ActiveDownloadInfo, DownloadQueue};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::plugin::{check_min_app_version, PluginManager, VarDefinition, VarOption};
use crate::schedule_sync::on_crawl_task_reached_terminal;
use crate::settings::Settings;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use tokio::task::JoinHandle;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::runtime::Handle;
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
    pub plugin_id: String,
    pub task_id: String,
    pub output_dir: Option<String>,
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub http_headers: Option<HashMap<String, String>>,
    pub output_album_id: Option<String>,
    /// 可选：直接从指定 .kgpg 文件运行（用于插件编辑器/临时插件）
    #[serde(default)]
    pub plugin_file_path: Option<String>,
    #[serde(default)]
    pub run_config_id: Option<String>,
    #[serde(default = "default_trigger_source")]
    pub trigger_source: String,
}

fn default_trigger_source() -> String {
    "manual".to_string()
}

#[derive(Clone)]
pub struct TaskScheduler {
    // PluginManager 现在是全局单例，不需要存储
    download_queue: Arc<DownloadQueue>,
    queue_tx: mpsc::UnboundedSender<CrawlTaskRequest>,
    queue_rx: Arc<Mutex<mpsc::UnboundedReceiver<CrawlTaskRequest>>>,
    running_workers: Arc<AtomicUsize>,
    page_stacks: Arc<PageStackStore>,
    /// 有任务结束或「同时运行任务数」设置变更时唤醒，避免等待槽位时忙等。
    task_slot_notify: Arc<Notify>,
    /// 失败图片重试：每条记录一个 tokio 任务，可在入队等待期间 abort。
    download_handles: Arc<Mutex<HashMap<i64, JoinHandle<()>>>>,
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

    pub fn create_stack(&self, task_id: &str) -> PageStack {
        let stack = Arc::new(StdMutex::new(Vec::new()));
        let mut guard = self.stacks.write().unwrap_or_else(|e| e.into_inner());
        guard.insert(task_id.to_string(), Arc::clone(&stack));
        stack
    }

    pub fn get_stack(&self, task_id: &str) -> Option<PageStack> {
        let guard = self.stacks.read().unwrap_or_else(|e| e.into_inner());
        guard.get(task_id).cloned()
    }

    pub fn remove_stack(&self, task_id: &str) {
        let mut guard = self.stacks.write().unwrap_or_else(|e| e.into_inner());
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
            download_handles: Arc::new(Mutex::new(HashMap::new())),
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
        // 先保证 DB 状态为 pending（前端也会写，但这里做幂等兜底）
        let storage = Storage::global();
        // let emitter = GlobalEmitter::global();
        let _ = persist_task_status(storage, &req.task_id, "pending", None, None, None);
        GlobalEmitter::global().emit_task_changed(
            &req.task_id,
            json!({ "status": "pending" }),
        );

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

    #[allow(dead_code)]
    pub fn running_worker_count(&self) -> usize {
        self.running_workers.load(Ordering::Relaxed)
    }

    /// 取消任务（标记取消 + 唤醒等待中的下载）
    pub async fn cancel_task(&self, task_id: &str) {
        self.download_queue.cancel_task(task_id).await;
    }

    /// 失败图片重试：spawn 异步任务入队，立即返回；可在等待容量期间 `cancel_retry_failed_image` abort。
    pub async fn retry_failed_image(&self, failed_id: i64) -> Result<(), String> {
        let storage = Storage::global();
        let item = storage
            .get_task_failed_image_by_id(failed_id)?
            .ok_or_else(|| "失败图片记录不存在".to_string())?;

        let task = storage
            .get_task(&item.task_id)?
            .ok_or_else(|| "任务不存在".to_string())?;

        let images_dir = task
            .output_dir
            .as_deref()
            .map(std::path::PathBuf::from)
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
        let retry_headers = item
            .header_snapshot
            .filter(|headers| !headers.is_empty())
            .unwrap_or_else(|| task.http_headers.unwrap_or_default());

        let plugin_id = item.plugin_id.clone();
        let task_id = item.task_id.clone();
        let output_album_id = task.output_album_id.clone();
        let metadata_id = item.metadata_id;

        let mut handles = self.download_handles.lock().await;
        if handles.contains_key(&failed_id) {
            return Err("该失败记录已在重试队列中".to_string());
        }

        let dq = Arc::clone(&self.download_queue);
        let dh = Arc::clone(&self.download_handles);
        let join = tokio::spawn(async move {
            let res = dq
                .download_image_retry(
                    failed_id,
                    url,
                    images_dir,
                    plugin_id,
                    task_id,
                    start_time,
                    output_album_id,
                    retry_headers,
                    metadata_id,
                )
                .await;
            let mut g = dh.lock().await;
            g.remove(&failed_id);
            if let Err(e) = res {
                eprintln!("[retry_failed_image] {}", e);
            }
        });
        handles.insert(failed_id, join);
        Ok(())
    }

    /// 批量重试（前端已按插件筛选）；跳过已有 handle 的 id。
    pub async fn retry_failed_images(&self, failed_ids: &[i64]) -> Result<Vec<i64>, String> {
        let mut retried = Vec::new();
        for &id in failed_ids {
            if self.download_handles.lock().await.contains_key(&id) {
                continue;
            }
            if self.retry_failed_image(id).await.is_ok() {
                retried.push(id);
            }
        }
        Ok(retried)
    }

    pub async fn cancel_retry_failed_image(&self, failed_id: i64) {
        if let Some(h) = self.download_handles.lock().await.remove(&failed_id) {
            h.abort();
        }
    }

    pub async fn cancel_retry_failed_images(&self, failed_ids: &[i64]) {
        let mut map = self.download_handles.lock().await;
        for &id in failed_ids {
            if let Some(h) = map.remove(&id) {
                h.abort();
            }
        }
    }

    pub async fn set_download_concurrency(&self) {
        self.download_queue.set_desired_concurrency_from_settings().await;
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
        let dq = self.download_queue();
        dq.set_desired_concurrency_from_settings().await;
        dq.notify_all_waiting();
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
    status: &str,
    start_time: Option<u64>,
    end_time: Option<u64>,
    error: Option<String>,
) -> Result<(), String> {
    let Some(mut task) = storage.get_task(task_id)? else {
        return Ok(());
    };

    task.status = status.to_string();
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
    if matches!(
        status,
        "completed" | "failed" | "canceled" | "cancelled"
    ) {
        on_crawl_task_reached_terminal(task_id);
    }
    Ok(())
}

/// 按当前「同时运行任务数」设置占用槽位（`running` +1）；若已满则等待直至有任务结束或设置增大。
async fn wait_for_task_slot(running: &Arc<AtomicUsize>, notify: &Arc<Notify>) {
    loop {
        let max = Settings::global()
            .get_max_concurrent_tasks()
            .await
            .unwrap_or(2)
            .clamp(1, 10) as usize;
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
        if download_queue.is_task_canceled(&req.task_id).await {
            let end = now_ms();
            let e = "Task canceled".to_string();
            let _ = persist_task_status(
                &storage,
                &req.task_id,
                "canceled",
                None,
                Some(end),
                Some(e.clone()),
            );
            GlobalEmitter::global().emit_task_changed(
                &req.task_id,
                json!({
                    "status": "canceled",
                    "endTime": end,
                    "error": e,
                }),
            );
            continue;
        }

        wait_for_task_slot(&running, &scheduler.task_slot_notify).await;

        // running
        let start = now_ms();
        let _ = persist_task_status(&storage, &req.task_id, "running", Some(start), None, None);
        GlobalEmitter::global().emit_task_changed(
            &req.task_id,
            json!({
                "status": "running",
                "startTime": start,
            }),
        );

        let page_stacks = scheduler.page_stacks();
        page_stacks.create_stack(&req.task_id);
        let res = run_task(&storage, Arc::clone(&download_queue), &req).await;
        let mut keep_page_stack = false;

        match res {
            Ok(TaskOutcome::Completed) => {
                let end = now_ms();
                if download_queue.is_task_canceled(&req.task_id).await {
                    let e = "Task canceled".to_string();
                    let _ = persist_task_status(
                        &storage,
                        &req.task_id,
                        "canceled",
                        None,
                        Some(end),
                        Some(e.clone()),
                    );
                    GlobalEmitter::global().emit_task_changed(
                        &req.task_id,
                        json!({
                            "status": "canceled",
                            "endTime": end,
                            "error": e,
                        }),
                    );
                } else {
                    let _ = persist_task_status(
                        &storage,
                        &req.task_id,
                        "completed",
                        None,
                        Some(end),
                        None,
                    );
                    GlobalEmitter::global().emit_task_changed(
                        &req.task_id,
                        json!({
                            "status": "completed",
                            "progress": 100,
                            "endTime": end,
                        }),
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
                let is_canceled = e.contains("Task canceled");
                let end = now_ms();
                let status = if is_canceled { "canceled" } else { "failed" };

                let _ = persist_task_status(
                    &storage,
                    &req.task_id,
                    status,
                    None,
                    Some(end),
                    Some(e.clone()),
                );
                GlobalEmitter::global().emit_task_changed(
                    &req.task_id,
                    json!({
                        "status": status,
                        "endTime": end,
                        "error": e,
                    }),
                );
            }
        }
        if !keep_page_stack {
            page_stacks.remove_stack(&req.task_id);
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
    // PluginManager 现在是全局单例，不需要传递
    // Settings 现在是全局单例，不需要传递
    download_queue: Arc<DownloadQueue>,
    // emitter 现在是全局单例，不需要传递
    req: &CrawlTaskRequest,
) -> Result<TaskOutcome, String> {
    let plugin_manager = PluginManager::global();
    GlobalEmitter::global().emit_task_log(
        &req.task_id,
        "info",
        &task_log_i18n(
            "taskLogSchedulerStart",
            json!({ "pluginId": req.plugin_id, "taskId": req.task_id }),
        ),
    );

    // 内置本地导入：不运行 Rhai，直接执行内置例程
    if req.plugin_id == "local-import" {
        crate::crawler::local_import::run_builtin_local_import(
            &req.task_id,
            req.user_config.clone(),
            req.output_album_id.clone(),
            &*download_queue,
        )
        .await?;
        return Ok(TaskOutcome::Completed);
    }

    // 两种运行模式：
    // 1) 已安装插件：通过 plugin_id 查找并运行
    // 2) 临时插件文件：通过 plugin_file_path 读取 manifest/config 并运行（不要求安装）
    let (plugin, plugin_file_path) = plugin_manager
        .resolve_plugin_for_task_request(&req.plugin_id, req.plugin_file_path.as_deref())
        .await?;
    if let Some(ref min_ver) = plugin.min_app_version {
        check_min_app_version(env!("CARGO_PKG_VERSION"), min_ver)?;
    }
    // 如果指定了输出目录，使用指定目录；否则使用默认下载目录（若配置）或回退到 Storage 的 images_dir
    let images_dir = if let Some(ref dir) = req.output_dir {
        PathBuf::from(dir)
    } else {
        match Settings::global().get_default_download_dir().await {
            Ok(Some(dir)) => PathBuf::from(dir),
            _ => storage.get_images_dir(),
        }
    };

    let plugin_file = if let Some(path) = plugin_file_path.as_ref() {
        path.clone()
    } else {
        crate::plugin::find_plugin_kgpg_path(&plugin.id)
            .ok_or_else(|| format!("插件 {} 未找到", plugin.id))?
    };
    let rhai_script = plugin_manager.read_plugin_script(&plugin_file)?;
    #[cfg(not(target_os = "android"))]
    let js_script = plugin_manager.read_plugin_js_script(&plugin_file)?;

    // merged_config：默认值 -> 用户覆盖 -> checkbox 规范化（与 crawl_images 保持一致）
    let user_cfg = req.user_config.clone().unwrap_or_default();
    let var_defs = if let Some(path) = plugin_file_path.as_ref() {
        plugin_manager.get_plugin_vars_from_file(path)?
    } else {
        plugin_manager
            .get_plugin_vars(&plugin.id)
            .await?
            .unwrap_or_default()
    };
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
            output_album_id: req.output_album_id.clone(),
            http_headers: req.http_headers.clone().unwrap_or_default(),
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
    let output_album_id = req.output_album_id.clone();
    let http_headers = req.http_headers.clone();

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
fn build_effective_user_config(
    plugin_id: &str,
    user_config: Option<HashMap<String, serde_json::Value>>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let plugin_manager = crate::plugin::PluginManager::global();
    let user_cfg = user_config.unwrap_or_default();

    // 读取插件变量定义（config.json 的 var）
    let var_defs: Vec<VarDefinition> = Handle::current().block_on(plugin_manager
        .get_plugin_vars(plugin_id))?
        .unwrap_or_default();

    Ok(build_effective_user_config_from_var_defs(
        &var_defs, user_cfg,
    ))
}

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

/// 查找插件文件
pub fn find_plugin_file(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            // 插件 ID = 插件文件名（不含扩展名）
            let file_name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if file_name == plugin_id {
                return Ok(path);
            }
        }
    }

    Err(format!("Plugin file not found for {}", plugin_id))
}
