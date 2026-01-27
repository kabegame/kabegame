use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::crawler::downloader::{DownloadQueue, TempDirGuard};
use crate::emitter::GlobalEmitter;
use serde_json::json;
use url::Url;

#[derive(Debug, Clone)]
pub struct DecompressionJob {
    pub archive_path: PathBuf,
    pub images_dir: PathBuf,
    pub original_url: String,
    pub task_id: String,
    pub plugin_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
    pub temp_dir_guard: Option<Arc<TempDirGuard>>,
}

pub(crate) async fn decompression_worker_loop(dq: Arc<DownloadQueue>) {
    let queue_pair = Arc::clone(&dq.decompression_queue);

    // active_tasks is no longer used here as decompression tasks are removed from the active list
    // immediately after download completion.

    loop {
        let job = {
            let (lock, notify) = &*queue_pair;
            let mut queue = lock.lock().await;
            while queue.is_empty() {
                drop(queue);
                notify.notified().await;
                queue = lock.lock().await;
            }
            let job = queue.pop_front().unwrap();
            job
        };

        println!("Decompression job: {:?}", job);

        let url_clone = job.original_url.clone();
        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let download_start_time = job.download_start_time;
        let archive_path = job.archive_path.clone();

        let archive_name = if let Ok(parsed) = Url::parse(&job.original_url) {
            parsed
                .path_segments()
                .and_then(|s| s.last())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "archive".to_string())
        } else {
            "archive".to_string()
        };

        // Emit global status: Unzipping
        GlobalEmitter::global().emit(
            "app-status",
            json!({
                "text": format!("正在解压 {}...", archive_name)
            }),
        );

        let result: Result<(), String> = (async {
            if dq.is_task_canceled(&task_id_clone).await {
                return Err("Task canceled".to_string());
            }

            let local_url = format!(
                "file:///{}",
                archive_path.display().to_string().replace("\\", "/")
            );

            // Check if processor exists
            if crate::archive::manager()
                .get_processor(None, &local_url)
                .is_none()
            {
                return Err("Failed to find archive processor for downloaded file".to_string());
            }

            let temp_dir = archive_path.parent().unwrap().to_path_buf();
            let canceled_tasks = dq.canceled_tasks.clone();
            let tid = task_id_clone.clone();
            let local_url_clone = local_url.clone();

            let images = tokio::task::spawn_blocking(move || {
                let cancel_check = || -> bool { canceled_tasks.blocking_lock().contains(&tid) };
                let dummy_downloader = |_: &str, _: &Path| -> Result<(), String> { Ok(()) };

                let processor = crate::archive::manager()
                    .get_processor(None, &local_url_clone)
                    .unwrap();
                processor.process(
                    &local_url_clone,
                    &temp_dir,
                    &dummy_downloader,
                    &cancel_check,
                )
            })
            .await
            .map_err(|e| format!("Decompression task failed: {}", e))??;

            // Emit global status: Importing
            GlobalEmitter::global().emit(
                "app-status",
                json!({
                    "text": format!("正在导入 {} 中的图片...", archive_name)
                }),
            );

            if images.is_empty() {
                return Ok(());
            }

            let temp_guard = job.temp_dir_guard.clone();

            for img in images {
                if dq.is_task_canceled(&task_id_clone).await {
                    break;
                }
                let img_url: String =
                    format!("file:///{}", img.display().to_string().replace("\\", "/"));

                let _ = dq
                    .download_with_temp_guard(
                        img_url,
                        job.images_dir.clone(),
                        plugin_id_clone.clone(),
                        task_id_clone.clone(),
                        download_start_time,
                        job.output_album_id.clone(),
                        job.http_headers.clone(),
                        None,
                        temp_guard.clone(),
                    )
                    .await;
            }
            Ok(())
        })
        .await;

        match result {
            Ok(_) => {
                // Clear status on success
                GlobalEmitter::global().emit(
                    "app-status",
                    json!({
                        "text": "" // Clear status
                    }),
                );
            }
            Err(e) => {
                if !e.contains("Task canceled") {
                    eprintln!(
                        "[Decompression Error] Task: {}, URL: {}, Error: {}",
                        task_id_clone, url_clone, e
                    );
                    // Show error in status bar
                    GlobalEmitter::global().emit(
                        "app-status",
                        json!({
                            "text": format!("解压失败 {}: {}", archive_name, e)
                        }),
                    );
                } else {
                    GlobalEmitter::global().emit(
                        "app-status",
                        json!({
                            "text": ""
                        }),
                    );
                }
            }
        }
    }
}
