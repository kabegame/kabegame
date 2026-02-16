use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use walkdir::WalkDir;

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

/// Recursively walk the directory and download each image file (streaming, no upfront collection).
async fn walk_images_and_download(
    dir: &Path,
    dq: &DownloadQueue,
    task_id: &str,
    images_dir: &PathBuf,
    plugin_id: &str,
    download_start_time: u64,
    output_album_id: &Option<String>,
    http_headers: &HashMap<String, String>,
    temp_guard: Option<&Arc<TempDirGuard>>,
) -> Result<(), String> {
    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if dq.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }
        let p = entry.path();
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if crate::archive::is_supported_image_ext(ext) {
                let img_url = url::Url::from_file_path(p).unwrap();
                let _ = dq
                    .download(
                        img_url,
                        images_dir.clone(),
                        plugin_id.to_string(),
                        task_id.to_string(),
                        download_start_time,
                        output_album_id.clone(),
                        http_headers.clone(),
                        None,
                        temp_guard.cloned(),
                    )
                    .await;
            }
        }
    }
    Ok(())
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

        // Emit archiver log: Unzipping
        GlobalEmitter::global().emit(
            "archiver-log",
            json!({
                "text": format!("正在解压 {}...", archive_name)
            }),
        );

        let result: Result<(), String> = (async {
            if dq.is_task_canceled(&task_id_clone).await {
                return Err("Task canceled".to_string());
            }

            let path_hint = archive_path.display().to_string();

            // Check if processor exists
            if crate::archive::manager()
                .get_processor_by_url(&path_hint)
                .is_none()
            {
                return Err("Failed to find archive processor for downloaded file".to_string());
            }

            let temp_dir = archive_path.parent().unwrap().to_path_buf();
            let archive_path_clone = archive_path.clone();

            let extract_dir = tokio::task::spawn_blocking(move || {
                let processor = crate::archive::manager()
                    .get_processor_by_url(&archive_path_clone.display().to_string())
                    .unwrap();
                processor.process(&archive_path_clone, &temp_dir)
            })
            .await
            .map_err(|e| format!("Decompression task failed: {}", e))??;

            // Emit archiver log: Importing
            GlobalEmitter::global().emit(
                "archiver-log",
                json!({
                    "text": format!("正在导入 {} 中的图片...", archive_name)
                }),
            );

            let temp_guard = job.temp_dir_guard.clone();
            let job_images_dir = job.images_dir.clone();
            let job_plugin_id = plugin_id_clone.clone();
            let job_task_id = task_id_clone.clone();
            let job_output_album_id = job.output_album_id.clone();
            let job_http_headers = job.http_headers.clone();

            walk_images_and_download(
                &extract_dir,
                &dq,
                &job_task_id,
                &job_images_dir,
                &job_plugin_id,
                download_start_time,
                &job_output_album_id,
                &job_http_headers,
                temp_guard.as_ref(),
            )
            .await?;
            Ok(())
        })
        .await;

        match result {
            Ok(_) => {
                // Clear status on success
                GlobalEmitter::global().emit(
                    "archiver-log",
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
                        "archiver-log",
                        json!({
                            "text": format!("解压失败 {}: {}", archive_name, e)
                        }),
                    );
                } else {
                    GlobalEmitter::global().emit(
                        "archiver-log",
                        json!({
                            "text": ""
                        }),
                    );
                }
            }
        }
    }
}
