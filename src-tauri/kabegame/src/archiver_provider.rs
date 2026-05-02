//! Android ArchiveExtractProvider 实现：通过 Archiver 插件调用 Kotlin API，并在 setup 时注册到 core。
//! 使用通道代理：真实 Provider 运行在独立线程（Wry 非 Send/Sync），注册的代理为 Send+Sync，通过 channel 转发请求并异步等待响应。

#![cfg(target_os = "android")]

use async_trait::async_trait;
use kabegame_core::crawler::archiver::ArchiveExtractProvider;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Runtime};
use tauri_plugin_archiver::ArchiverExt;
use tokio::sync::oneshot;

/// 基于 Archiver PluginHandle 的 ArchiveExtractProvider，仅用于独立线程内，不要求 R: Send + Sync。
pub struct ArchiverContentProvider<R: Runtime> {
    app_handle: Arc<AppHandle<R>>,
}

impl<R: Runtime> ArchiverContentProvider<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            app_handle: Arc::new(app_handle),
        }
    }
}

#[derive(Debug)]
enum Request {
    ExtractZip {
        archive_uri: String,
        output_dir: String,
    },
    ExtractRar {
        archive_uri: String,
        output_dir: String,
    },
}

#[derive(Debug)]
enum Response {
    ExtractZip(Result<PathBuf, String>),
    ExtractRar(Result<PathBuf, String>),
}

/// 在独立线程中运行真实 Provider，用 channel 接收请求并返回结果。避免 Wry 跨线程 (Send/Sync)。
fn run_worker_loop<R: Runtime + 'static>(
    provider: ArchiverContentProvider<R>,
    rx: mpsc::Receiver<(Request, oneshot::Sender<Response>)>,
) {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ArchiverProvider] worker runtime new failed: {}", e);
            return;
        }
    };
    while let Ok((req, resp_tx)) = rx.recv() {
        let response = match req {
            Request::ExtractZip {
                archive_uri,
                output_dir,
            } => {
                let p = &provider;
                Response::ExtractZip(rt.block_on(async move {
                    let resp = p
                        .app_handle
                        .archiver()
                        .extract_zip(archive_uri, output_dir)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(PathBuf::from(resp.dir))
                }))
            }
            Request::ExtractRar {
                archive_uri,
                output_dir,
            } => {
                let p = &provider;
                Response::ExtractRar(rt.block_on(async move {
                    let resp = p
                        .app_handle
                        .archiver()
                        .extract_rar(archive_uri, output_dir)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(PathBuf::from(resp.dir))
                }))
            }
        };
        let _ = resp_tx.send(response);
    }
}

/// 通过 channel 转发到独立线程的 Provider，实现 Send + Sync，可安全存入 core 的 OnceLock。
pub struct ChannelArchiveExtractProvider {
    tx: mpsc::Sender<(Request, oneshot::Sender<Response>)>,
}

impl ChannelArchiveExtractProvider {
    pub fn new<R: Runtime + 'static>(provider: ArchiverContentProvider<R>) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || run_worker_loop(provider, rx));
        Self { tx }
    }
}

#[async_trait]
impl ArchiveExtractProvider for ChannelArchiveExtractProvider {
    async fn extract_zip(&self, archive_uri: &str, output_dir: &str) -> Result<PathBuf, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((
                Request::ExtractZip {
                    archive_uri: archive_uri.to_string(),
                    output_dir: output_dir.to_string(),
                },
                resp_tx,
            ))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::ExtractZip(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn extract_rar(&self, archive_uri: &str, output_dir: &str) -> Result<PathBuf, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((
                Request::ExtractRar {
                    archive_uri: archive_uri.to_string(),
                    output_dir: output_dir.to_string(),
                },
                resp_tx,
            ))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::ExtractRar(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }
}
