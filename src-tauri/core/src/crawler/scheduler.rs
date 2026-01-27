use crate::crawler::downloader::{get_default_images_dir, ActiveDownloadInfo, DownloadQueue};
use crate::emitter::GlobalEmitter;
use crate::plugin::{PluginManager, VarDefinition, VarOption};
use crate::settings::Settings;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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
}

#[derive(Clone)]
pub struct TaskScheduler {
    // PluginManager 现在是全局单例，不需要存储
    download_queue: Arc<DownloadQueue>,
    queue: Arc<(Mutex<VecDeque<CrawlTaskRequest>>, Condvar)>,
    running_workers: Arc<AtomicUsize>,
}

// 全局 TaskScheduler 单例
static TASK_SCHEDULER: OnceLock<TaskScheduler> = OnceLock::new();

impl TaskScheduler {
    pub fn new(download_queue: Arc<DownloadQueue>) -> Self {
        let s = Self {
            download_queue,
            queue: Arc::new((Mutex::new(VecDeque::new()), Condvar::new())),
            running_workers: Arc::new(AtomicUsize::new(0)),
        };
        // 写死创建10个worker
        s
    }

    pub async fn start_workers(&self, count: usize) {
        for _ in 0..count {
            let download_queue = Arc::clone(&self.download_queue);
            let queue = Arc::clone(&self.queue);
            let running = Arc::clone(&self.running_workers);
            // worker_loop 是阻塞函数（使用 Condvar::wait），必须在 blocking 线程池中运行
            // 因为 rhai 是单线程，不能在tokio上下文中运行
            tokio::task::spawn_blocking(move || worker_loop(download_queue, queue, running));
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
        GlobalEmitter::global().emit_task_status(
            &req.task_id,
            "pending",
            None,
            None,
            None,
            None,
            None,
        );

        let (m, cv) = &*self.queue;
        let mut guard = m.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.push_back(req);
        cv.notify_one();
        Ok(())
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

    /// 应用启动时恢复队列：
    /// - pending：直接重新入队
    /// - running：认为上次运行被中断，改成 pending 并重新入队（避免永久卡死）
    pub fn restore_pending_tasks(&self) -> Result<usize, String> {
        let storage = Storage::global();
        let tasks = storage.get_all_tasks()?;
        let mut restored = 0usize;

        for t in tasks {
            if t.status == "pending" || t.status == "running" {
                if t.status == "running" {
                    let mut tt = t.clone();
                    tt.status = "pending".to_string();
                    tt.error = Some("上次运行中断，已重新排队".to_string());
                    tt.end_time = None;
                    let _ = storage.update_task(tt);
                }

                self.enqueue(CrawlTaskRequest {
                    plugin_id: t.plugin_id,
                    task_id: t.id,
                    output_dir: t.output_dir,
                    user_config: t.user_config,
                    http_headers: t.http_headers,
                    output_album_id: t.output_album_id,
                    plugin_file_path: None,
                })?;
                restored += 1;
            }
        }

        Ok(restored)
    }

    #[allow(dead_code)]
    pub fn running_worker_count(&self) -> usize {
        self.running_workers.load(Ordering::Relaxed)
    }

    /// 取消任务（标记取消 + 唤醒等待中的下载）
    pub async fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        self.download_queue.cancel_task(task_id).await
    }

    /// 失败图片重试：在 daemon 侧直接复用 DownloadQueue
    pub fn retry_failed_image(&self, failed_id: i64) -> Result<(), String> {
        let storage = Storage::global();
        let item = storage
            .get_task_failed_image_by_id(failed_id)?
            .ok_or_else(|| "失败图片记录不存在".to_string())?;

        // 标记一次尝试（清空 last_error）
        let _ = storage.update_task_failed_image_attempt(failed_id, "");

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

        tokio::runtime::Handle::current().block_on(self.download_queue.download_image(
            item.url,
            images_dir,
            item.plugin_id,
            item.task_id,
            start_time,
            task.output_album_id,
            task.http_headers.unwrap_or_default(),
        ))
    }

    pub fn set_download_concurrency(&self, desired: u32) {
        self.download_queue.set_desired_concurrency(desired);
        self.download_queue.notify_all_waiting();
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

    /// 启动解压缩 worker
    pub async fn start_decompression_worker(&self) {
        use crate::crawler::decompression::decompression_worker_loop;
        let dq = self.download_queue();
        let dq = dq.clone();
        tokio::spawn(async move { 
            decompression_worker_loop(dq).await 
        });
    }

    /// 启动 dispatcher loop
    pub async fn start_dispatcher_loop(&self) {
        use crate::crawler::downloader::dispatcher_loop;
        let dq = self.download_queue();
        let dq = dq.clone();
        tokio::spawn(async move { 
            dispatcher_loop(dq).await 
        });
    }

    /// 启动下载 worker
    pub async fn start_download_workers_async(&self) {
        let dq = self.download_queue();
        let initial_workers = dq.pool.total_workers.load(std::sync::atomic::Ordering::Relaxed);
        dq.start_download_workers(initial_workers);
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
    Ok(())
}

fn worker_loop(
    download_queue: Arc<DownloadQueue>,
    queue: Arc<(Mutex<VecDeque<CrawlTaskRequest>>, Condvar)>,
    running: Arc<AtomicUsize>,
) {
    // 每个 task worker 线程初始化一次 Rhai Engine，并在多任务之间复用
    let mut rhai_runtime =
        crate::plugin::rhai::RhaiCrawlerRuntime::new(Arc::clone(&download_queue));

    let storage = Storage::global();

    loop {
        let req = {
            let (m, cv) = &*queue;
            let mut guard = match m.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            while guard.is_empty() {
                guard = match cv.wait(guard) {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
            }
            guard.pop_front()
        };

        let Some(req) = req else { continue };

        // 若任务已取消（排队期间），直接 canceled
        if tokio::runtime::Handle::current().block_on(download_queue.is_task_canceled(&req.task_id))
        {
            let end = now_ms();
            let e = "Task canceled".to_string();
            GlobalEmitter::global().emit_task_error(&req.task_id, &e);
            let _ = persist_task_status(
                &storage,
                &req.task_id,
                "canceled",
                None,
                Some(end),
                Some(e.clone()),
            );
            GlobalEmitter::global().emit_task_status(
                &req.task_id,
                "canceled",
                None,
                None,
                Some(end),
                Some(e.as_str()),
                None,
            );
            continue;
        }

        running.fetch_add(1, Ordering::Relaxed);

        // running
        let start = now_ms();
        let _ = persist_task_status(&storage, &req.task_id, "running", Some(start), None, None);
        GlobalEmitter::global().emit_task_status(
            &req.task_id,
            "running",
            None,
            Some(start),
            None,
            None,
            None,
        );

        let res = run_task(
            &storage,
            Arc::clone(&download_queue),
            &req,
            &mut rhai_runtime,
        );

        match res {
            Ok(_) => {
                let end = now_ms();
                if tokio::runtime::Handle::current()
                    .block_on(download_queue.is_task_canceled(&req.task_id))
                {
                    let e = "Task canceled".to_string();
                    #[cfg(feature = "ipc-server")]
                    GlobalEmitter::global().emit_task_error(&req.task_id, &e);
                    let _ = persist_task_status(
                        &storage,
                        &req.task_id,
                        "canceled",
                        None,
                        Some(end),
                        Some(e.clone()),
                    );
                    GlobalEmitter::global().emit_task_status(
                        &req.task_id,
                        "canceled",
                        None,
                        None,
                        Some(end),
                        Some(e.as_str()),
                        None,
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
                    GlobalEmitter::global().emit_task_status(
                        &req.task_id,
                        "completed",
                        None,
                        None,
                        Some(end),
                        None,
                        None,
                    );
                }
            }
            Err(e) => {
                let is_canceled = e.contains("Task canceled");
                let end = now_ms();
                let status = if is_canceled { "canceled" } else { "failed" };

                GlobalEmitter::global().emit_task_error(&req.task_id, &e);

                let _ = persist_task_status(
                    &storage,
                    &req.task_id,
                    status,
                    None,
                    Some(end),
                    Some(e.clone()),
                );
                GlobalEmitter::global().emit_task_status(
                    &req.task_id,
                    status,
                    None,
                    None,
                    Some(end),
                    Some(e.as_str()),
                    None,
                );
            }
        }

        running.fetch_sub(1, Ordering::Relaxed);
    }
}

fn run_task(
    storage: &Storage,
    // PluginManager 现在是全局单例，不需要传递
    // Settings 现在是全局单例，不需要传递
    download_queue: Arc<DownloadQueue>,
    // emitter 现在是全局单例，不需要传递
    req: &CrawlTaskRequest,
    rhai_runtime: &mut crate::plugin::rhai::RhaiCrawlerRuntime,
) -> Result<(), String> {
    let plugin_manager = PluginManager::global();
    GlobalEmitter::global().emit_task_log(
        &req.task_id,
        "info",
        &format!(
            "TaskScheduler: 开始执行任务（pluginId={}, taskId={}）",
            req.plugin_id, req.task_id
        ),
    );

    // 两种运行模式：
    // 1) 已安装插件：通过 plugin_id 查找并运行
    // 2) 临时插件文件：通过 plugin_file_path 读取 manifest/config 并运行（不要求安装）
    let (plugin, plugin_file_path) = plugin_manager
        .resolve_plugin_for_task_request(&req.plugin_id, req.plugin_file_path.as_deref())?;

    // 如果指定了输出目录，使用指定目录；否则使用默认下载目录（若配置）或回退到 Storage 的 images_dir
    // 注意：run_task 是同步函数，但需要调用 async getter，这里使用 block_on
    let images_dir = if let Some(ref dir) = req.output_dir {
        PathBuf::from(dir)
    } else {
        let handle = tokio::runtime::Handle::try_current();
        match handle {
            Ok(handle) => match handle.block_on(Settings::global().get_default_download_dir()) {
                Ok(Some(dir)) => PathBuf::from(dir),
                _ => storage.get_images_dir(),
            },
            Err(_) => storage.get_images_dir(),
        }
    };

    // 读取脚本
    let script_content = if let Some(path) = plugin_file_path.as_ref() {
        plugin_manager
            .read_plugin_script(path)?
            .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?
    } else {
        let plugins_dir = plugin_manager.get_plugins_directory();
        let plugin_file = find_plugin_file(&plugins_dir, &plugin.id)?;
        plugin_manager
            .read_plugin_script(&plugin_file)?
            .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?
    };

    // merged_config：默认值 -> 用户覆盖 -> checkbox 规范化（与 crawl_images 保持一致）
    let user_cfg = req.user_config.clone().unwrap_or_default();
    let var_defs = if let Some(path) = plugin_file_path.as_ref() {
        plugin_manager.get_plugin_vars_from_file(path)?
    } else {
        plugin_manager
            .get_plugin_vars(&plugin.id)?
            .unwrap_or_default()
    };
    let merged_config = build_effective_user_config_from_var_defs(&var_defs, user_cfg);

    // 确保 Rhai runtime 绑定的是当前 daemon 的 DownloadQueue
    *rhai_runtime = crate::plugin::rhai::RhaiCrawlerRuntime::new(download_queue);

    crate::plugin::rhai::execute_crawler_script_with_runtime(
        rhai_runtime,
        &plugin,
        &images_dir,
        &plugin.id,
        &req.task_id,
        &script_content,
        merged_config,
        req.output_album_id.clone(),
        req.http_headers.clone(),
    )
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
    let var_defs: Vec<VarDefinition> = plugin_manager
        .get_plugin_vars(plugin_id)?
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
        // options/list/其它：保持原样；若无值则给一个可用的空值，避免变量缺失
        "options" => match value {
            Some(v) => v,
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
