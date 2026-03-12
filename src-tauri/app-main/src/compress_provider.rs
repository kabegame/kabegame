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
}

#[derive(Debug)]
enum Response {
    Compress(Result<VideoCompressResult, String>),
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
        self.tx
            .send((
                Request::Compress {
                    input_path: input_path.to_string_lossy().to_string(),
                    output_path: output_path.to_string_lossy().to_string(),
                },
                resp_tx,
            ))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::Compress(r) => r,
        }
    }
}
