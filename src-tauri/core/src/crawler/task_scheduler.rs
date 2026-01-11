use crate::crawler::DownloadQueue;
use crate::plugin::PluginManager;
use crate::settings::Settings;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlTaskRequest {
    pub plugin_id: String,
    pub task_id: String,
    pub output_dir: Option<String>,
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    pub output_album_id: Option<String>,
    /// 可选：直接从指定 .kgpg 文件运行（用于插件编辑器/临时插件）
    #[serde(default)]
    pub plugin_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusEvent {
    pub task_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct TaskScheduler {
    app: AppHandle,
    queue: Arc<(Mutex<VecDeque<CrawlTaskRequest>>, Condvar)>,
    running_workers: Arc<AtomicUsize>,
}

impl TaskScheduler {
    pub fn new(app: AppHandle) -> Self {
        let s = Self {
            app: app.clone(),
            queue: Arc::new((Mutex::new(VecDeque::new()), Condvar::new())),
            running_workers: Arc::new(AtomicUsize::new(0)),
        };
        s.start_workers(10);
        s
    }

    fn start_workers(&self, count: usize) {
        for _ in 0..count {
            let app = self.app.clone();
            let queue = Arc::clone(&self.queue);
            let running = Arc::clone(&self.running_workers);
            std::thread::spawn(move || worker_loop(app, queue, running));
        }
    }

    /// 入队一个任务：
    /// - 若有空闲 task worker，会很快被取走并进入 running
    /// - 若当前 10 个 worker 都忙，则任务保持 pending 并排队等待
    pub fn enqueue(&self, req: CrawlTaskRequest) -> Result<(), String> {
        // 先保证 DB 状态为 pending（前端也会写，但这里做幂等兜底）
        let _ = persist_task_status(&self.app, &req.task_id, "pending", None, None, None);
        emit_task_status(&self.app, &req.task_id, "pending", None, None, None);

        let (m, cv) = &*self.queue;
        let mut guard = m.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.push_back(req);
        cv.notify_one();
        Ok(())
    }

    /// 应用启动时恢复队列：
    /// - pending：直接重新入队
    /// - running：认为上次运行被中断，改成 pending 并重新入队（避免永久卡死）
    pub fn restore_pending_tasks(&self) -> Result<usize, String> {
        let storage = self.app.state::<Storage>();
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
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn emit_task_status(
    app: &AppHandle,
    task_id: &str,
    status: &str,
    start_time: Option<u64>,
    end_time: Option<u64>,
    error: Option<String>,
) {
    let _ = app.emit(
        "task-status",
        TaskStatusEvent {
            task_id: task_id.to_string(),
            status: status.to_string(),
            start_time,
            end_time,
            error,
        },
    );
}

fn persist_task_status(
    app: &AppHandle,
    task_id: &str,
    status: &str,
    start_time: Option<u64>,
    end_time: Option<u64>,
    error: Option<String>,
) -> Result<(), String> {
    let storage = app
        .try_state::<Storage>()
        .ok_or_else(|| "Storage not ready".to_string())?;
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
    app: AppHandle,
    queue: Arc<(Mutex<VecDeque<CrawlTaskRequest>>, Condvar)>,
    running: Arc<AtomicUsize>,
) {
    // 每个 task worker 线程初始化一次 Rhai Engine，并在多任务之间复用（避免每次 Engine::new + 反复 register_fn）
    let mut rhai_runtime = crate::crawler::rhai::RhaiCrawlerRuntime::new(app.clone());

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

        // 如果任务已被用户取消（可能在排队期间），直接标记 canceled，避免进入 running/最终被 completed 覆盖。
        {
            let dq = app.state::<DownloadQueue>();
            if dq.is_task_canceled(&req.task_id) {
                let end = now_ms();
                let e = "Task canceled".to_string();

                // 兼容旧逻辑：前端也监听 task-error 来识别取消
                let _ = app.emit(
                    "task-error",
                    serde_json::json!({
                        "taskId": req.task_id.clone(),
                        "error": e.clone()
                    }),
                );

                let _ = persist_task_status(
                    &app,
                    &req.task_id,
                    "canceled",
                    None,
                    Some(end),
                    Some(e.clone()),
                );
                emit_task_status(&app, &req.task_id, "canceled", None, Some(end), Some(e));
                continue;
            }
        }

        running.fetch_add(1, Ordering::Relaxed);

        // 标记 running（写库 + 事件）
        let start = now_ms();
        let _ = persist_task_status(&app, &req.task_id, "running", Some(start), None, None);
        emit_task_status(&app, &req.task_id, "running", Some(start), None, None);

        let res = run_task(&app, &req, &mut rhai_runtime);

        match res {
            Ok(_) => {
                let end = now_ms();
                // 取消优先：即使脚本执行返回 Ok，只要用户请求了取消，就不要把任务标成 completed。
                // 这能修复“手动停止后仍被标记完成”（常见于脚本很快结束、或取消发生在下载阶段）。
                let dq = app.state::<DownloadQueue>();
                if dq.is_task_canceled(&req.task_id) {
                    let e = "Task canceled".to_string();
                    let _ = app.emit(
                        "task-error",
                        serde_json::json!({
                            "taskId": req.task_id.clone(),
                            "error": e.clone()
                        }),
                    );
                    let _ = persist_task_status(
                        &app,
                        &req.task_id,
                        "canceled",
                        None,
                        Some(end),
                        Some(e.clone()),
                    );
                    emit_task_status(&app, &req.task_id, "canceled", None, Some(end), Some(e));
                } else {
                    let _ =
                        persist_task_status(&app, &req.task_id, "completed", None, Some(end), None);
                    emit_task_status(&app, &req.task_id, "completed", None, Some(end), None);
                }
            }
            Err(e) => {
                let is_canceled = e.contains("Task canceled");
                let end = now_ms();
                let status = if is_canceled { "canceled" } else { "failed" };

                // 兼容旧逻辑：仍然发 task-error 事件（前端已有处理）
                let _ = app.emit(
                    "task-error",
                    serde_json::json!({
                        "taskId": req.task_id,
                        "error": e.clone()
                    }),
                );

                let _ = persist_task_status(
                    &app,
                    &req.task_id,
                    status,
                    None,
                    Some(end),
                    Some(e.clone()),
                );
                emit_task_status(&app, &req.task_id, status, None, Some(end), Some(e));
            }
        }

        running.fetch_sub(1, Ordering::Relaxed);
    }
}

fn run_task(
    app: &AppHandle,
    req: &CrawlTaskRequest,
    rhai_runtime: &mut crate::crawler::rhai::RhaiCrawlerRuntime,
) -> Result<(), String> {
    crate::crawler::emit_task_log(
        app,
        &req.task_id,
        "info",
        format!(
            "TaskScheduler: 开始执行任务（pluginId={}, taskId={}）",
            req.plugin_id, req.task_id
        ),
    );
    let plugin_manager = app.state::<PluginManager>();
    // 两种运行模式：
    // 1) 已安装插件：通过 plugin_id 查找并运行
    // 2) 临时插件文件：通过 plugin_file_path 读取 manifest/config 并运行（不要求安装）
    let (plugin, plugin_file_path) = plugin_manager
        .resolve_plugin_for_task_request(&req.plugin_id, req.plugin_file_path.as_deref())?;

    let storage = app.state::<Storage>();
    let settings_state = app.state::<Settings>();

    // 如果指定了输出目录，使用指定目录；否则使用默认下载目录（若配置）或回退到 Storage 的 images_dir
    let images_dir = if let Some(ref dir) = req.output_dir {
        PathBuf::from(dir)
    } else {
        match settings_state
            .get_settings()
            .ok()
            .and_then(|s| s.default_download_dir)
        {
            Some(dir) => PathBuf::from(dir),
            None => storage.get_images_dir(),
        }
    };

    // 关键：在 task worker 内复用 Rhai Engine（脚本运行本身是同步 eval）
    let script_content = if let Some(path) = plugin_file_path.as_ref() {
        plugin_manager
            .read_plugin_script(path)?
            .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?
    } else {
        let plugins_dir = plugin_manager.get_plugins_directory();
        let plugin_file = super::find_plugin_file(&plugins_dir, &plugin.id)?;
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
    let merged_config = super::build_effective_user_config_from_var_defs(&var_defs, user_cfg);

    crate::crawler::rhai::execute_crawler_script_with_runtime(
        rhai_runtime,
        &plugin,
        &images_dir,
        app,
        &plugin.id,
        &req.task_id,
        &script_content,
        merged_config,
        req.output_album_id.clone(),
    )
}
