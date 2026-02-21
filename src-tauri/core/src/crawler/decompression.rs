use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use url::Url;
use walkdir::WalkDir;

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::downloader::DownloadQueue;
use crate::emitter::GlobalEmitter;
use serde_json::json;

#[derive(Debug, Clone)]
pub struct DecompressionJob {
    pub archive_url: Url,
    /// 解压目标目录（网络下载的压缩包解压到此目录；本地导入的也解压到此默认输出目录）
    pub images_dir: PathBuf,
    pub task_id: String,
    pub plugin_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
}

#[cfg(target_os = "android")]
async fn process_content_archive(
    archive_url: &Url,
    job: &DecompressionJob,
    dq: &DownloadQueue,
    task_id: &str,
    plugin_id: &str,
    download_start_time: u64,
) -> Result<(), String> {
    let io = get_content_io_provider()
        .ok_or_else(|| "Android ContentIoProvider 未注册".to_string())?;

    let folder_name = archive_url
        .path_segments()
        .and_then(|s| s.last())
        .unwrap_or("archive")
        .trim_end_matches(".zip")
        .trim_end_matches(".rar")
        .to_string();
    let folder_name = if folder_name.is_empty() {
        "archive".to_string()
    } else {
        folder_name
    };

    let result = io.extract_archive_to_media_store(archive_url.as_str(), &folder_name)?;

    GlobalEmitter::global().emit(
        "archiver-log",
        json!({
            "text": format!("正在导入 {} 中的图片...", result.count)
        }),
    );

    for uri in &result.uris {
        if dq.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }
        let url = Url::parse(uri).map_err(|e| format!("Invalid URI: {}", e))?;
        let _ = dq
            .download(
                url,
                job.images_dir.clone(),
                plugin_id.to_string(),
                task_id.to_string(),
                download_start_time,
                job.output_album_id.clone(),
                job.http_headers.clone(),
                None,
            )
            .await;
    }
    Ok(())
}

/// 递归遍历解压目录，将每个图片以 file:// 协议加入下载队列（本地导入流程，不复制文件）。
async fn walk_images_and_enqueue_file_downloads(
    dir: &Path,
    dq: &DownloadQueue,
    task_id: &str,
    plugin_id: &str,
    download_start_time: u64,
    output_album_id: &Option<String>,
    http_headers: &HashMap<String, String>,
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
                // file:// 不复制，目标路径即源路径；加入下载队列后由 download worker 做后处理（哈希、缩略图、入库）
                let _ = dq
                    .download(
                        img_url,
                        dir.to_path_buf(), // file 协议下 images_dir 仅用于 compute_destination_path，file 会返回源路径
                        plugin_id.to_string(),
                        task_id.to_string(),
                        download_start_time,
                        output_album_id.clone(),
                        http_headers.clone(),
                        None,
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

        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let download_start_time = job.download_start_time;
        let archive_url = job.archive_url.clone();

        let archive_name = archive_url
            .path_segments()
            .and_then(|s| s.last())
            .unwrap_or("archive")
            .to_string();

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

            #[cfg(target_os = "android")]
            if archive_url.scheme() == "content" {
                return process_content_archive(
                    &archive_url,
                    &job,
                    &dq,
                    &task_id_clone,
                    &plugin_id_clone,
                    download_start_time,
                )
                .await;
            }

            // file://：桌面解压逻辑
            let archive_path = archive_url
                .to_file_path()
                .map_err(|_| "Invalid file URL for archive".to_string())?;
            if crate::archive::get_processor_by_path(&archive_path).is_none() {
                return Err("Failed to find archive processor for downloaded file".to_string());
            }

            let extract_base = job.images_dir.clone();
            let archive_path_clone = archive_path.clone();

            let extract_dir = tokio::task::spawn_blocking(move || {
                let processor = crate::archive::get_processor_by_path(&archive_path_clone).unwrap();
                processor.process(&archive_path_clone, &extract_base)
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

            let job_plugin_id = plugin_id_clone.clone();
            let job_task_id = task_id_clone.clone();
            let job_output_album_id = job.output_album_id.clone();
            let job_http_headers = job.http_headers.clone();

            walk_images_and_enqueue_file_downloads(
                &extract_dir,
                &dq,
                &job_task_id,
                &job_plugin_id,
                download_start_time,
                &job_output_album_id,
                &job_http_headers,
            )
            .await?;
            Ok(())
        })
        .await;

        match result {
            Ok(_) => {
                GlobalEmitter::global().emit(
                    "archiver-log",
                    json!({
                        "text": format!("解压完成 {}", archive_name)
                    }),
                );
            }
            Err(e) => {
                if !e.contains("Task canceled") {
                    eprintln!(
                        "[Decompression Error] Task: {}, archive: {}, Error: {}",
                        task_id_clone,
                        archive_url,
                        e
                    );
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
                            "text": format!("解压取消 {}", archive_name)
                        }),
                    );
                }
            }
        }
    }
}
