#![cfg(target_os = "android")]

use async_trait::async_trait;
use kabegame_core::crawler::downloader::video_compress::{
    AndroidVideoCompressProvider, VideoCompressResult,
};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Runtime};
use tauri_plugin_compress::CompressExt;
use tokio::sync::oneshot;

pub struct PluginVideoCompressProvider<R: Runtime> {
    app_handle: Arc<AppHandle<R>>,
}

impl<R: Runtime> PluginVideoCompressProvider<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            app_handle: Arc::new(app_handle),
        }
    }
}

#[derive(Debug)]
enum Request {
    Compress {
        input_path: String,
        output_path: String,
    },
    GenerateGifThumbnail {
        input_path: String,
        output_path: String,
    },
}

enum Response {
    Compress(Result<VideoCompressResult, String>),
    GenerateGifThumbnail(Result<VideoCompressResult, String>),
}

fn run_worker_loop<R: Runtime + 'static>(
    provider: PluginVideoCompressProvider<R>,
    rx: mpsc::Receiver<(Request, oneshot::Sender<Response>)>,
) {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[VideoCompress] worker runtime init failed: {e}");
            return;
        }
    };

    while let Ok((req, resp_tx)) = rx.recv() {
        let response = match req {
            Request::Compress {
                input_path,
                output_path,
            } => {
                let p = &provider;
                Response::Compress(rt.block_on(async move {
                    let result = p
                        .app_handle
                        .compress()
                        .compress_video_for_preview(input_path, output_path)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(VideoCompressResult {
                        preview_path: std::path::PathBuf::from(result.output_path),
                        width: result.width,
                        height: result.height,
                    })
                }))
            }
            Request::GenerateGifThumbnail {
                input_path,
                output_path,
            } => {
                let p = &provider;
                Response::GenerateGifThumbnail(rt.block_on(async move {
                    let frame_dir = kabegame_core::app_paths::AppPaths::global()
                        .temp_dir
                        .clone()
                        .join(format!("gif_frames_{}", uuid::Uuid::new_v4()));
                    tokio::fs::create_dir_all(&frame_dir)
                        .await
                        .map_err(|e| format!("创建帧目录失败: {e}"))?;
                    let extract_result = p
                        .app_handle
                        .compress()
                        .extract_video_frames(
                            input_path.clone(),
                            frame_dir.to_string_lossy().to_string(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                    let frame_dir_path = std::path::Path::new(&extract_result.frame_dir);
                    let out_path = std::path::PathBuf::from(&output_path);
                    kabegame_core::crawler::downloader::video_compress::encode_frames_dir_to_gif(
                        frame_dir_path,
                        &out_path,
                    )?;
                    let _ = tokio::fs::remove_dir_all(frame_dir_path).await;
                    Ok(VideoCompressResult {
                        preview_path: out_path,
                        width: None,
                        height: None,
                    })
                }))
            }
        };
        let _ = resp_tx.send(response);
    }
}

pub struct ChannelVideoCompressProvider {
    tx: mpsc::Sender<(Request, oneshot::Sender<Response>)>,
}

impl ChannelVideoCompressProvider {
    pub fn new<R: Runtime + 'static>(provider: PluginVideoCompressProvider<R>) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || run_worker_loop(provider, rx));
        Self { tx }
    }
}

#[async_trait]
impl AndroidVideoCompressProvider for ChannelVideoCompressProvider {
    async fn compress_video_for_preview(
        &self,
        input_path: &Path,
        output_path: &Path,
    ) -> Result<VideoCompressResult, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        let is_gif = output_path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("gif"))
            .unwrap_or(false);
        let req = if is_gif {
            Request::GenerateGifThumbnail {
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
            }
        } else {
            Request::Compress {
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
            }
        };
        self.tx.send((req, resp_tx)).map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::Compress(r) => r,
            Response::GenerateGifThumbnail(r) => r,
        }
    }
}
