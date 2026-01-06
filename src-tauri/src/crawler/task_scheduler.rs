use crate::crawler::crawl_images;
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
    pub url: String,
    pub task_id: String,
    pub output_dir: Option<String>,
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    pub output_album_id: Option<String>,
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
                    url: t.url,
                    task_id: t.id,
                    output_dir: t.output_dir,
                    user_config: t.user_config,
                    output_album_id: t.output_album_id,
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

        running.fetch_add(1, Ordering::Relaxed);

        // 标记 running（写库 + 事件）
        let start = now_ms();
        let _ = persist_task_status(&app, &req.task_id, "running", Some(start), None, None);
        emit_task_status(&app, &req.task_id, "running", Some(start), None, None);

        let res = run_task(&app, &req);

        match res {
            Ok(_) => {
                let end = now_ms();
                let _ = persist_task_status(&app, &req.task_id, "completed", None, Some(end), None);
                emit_task_status(&app, &req.task_id, "completed", None, Some(end), None);
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

fn run_task(app: &AppHandle, req: &CrawlTaskRequest) -> Result<(), String> {
    let plugin_manager = app.state::<PluginManager>();
    let plugin = plugin_manager
        .get(&req.plugin_id)
        .ok_or_else(|| format!("Plugin {} not found", req.plugin_id))?;

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

    // 注意：crawl_images 是 async，但内部主要是同步脚本执行；
    // 我们在 task worker 线程里 block_on，不阻塞 Tauri 的 command runtime。
    tauri::async_runtime::block_on(async {
        let _ = crawl_images(
            &plugin,
            &req.url,
            &req.task_id,
            images_dir,
            app.clone(),
            req.user_config.clone(),
            req.output_album_id.clone(),
        )
        .await?;
        Ok::<(), String>(())
    })
}
