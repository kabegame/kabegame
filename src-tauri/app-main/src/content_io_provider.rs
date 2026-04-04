//! Android ContentIoProvider 实现：通过 Picker 插件调用 Kotlin API，并在 setup 时注册到 core。
//! 使用通道代理：真实 Provider 运行在独立线程（Wry 非 Send/Sync），注册的代理为 Send+Sync，通过 channel 转发请求并异步等待响应。

#![cfg(target_os = "android")]

use async_trait::async_trait;
use base64::Engine;
use kabegame_core::crawler::content_io::{
    ContentEntry, ContentIoProvider, CopiedImageEntry,
};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Runtime};
use tauri_plugin_picker::PickerExt;
use tokio::sync::oneshot;

/// 基于 Picker PluginHandle 的 ContentIoProvider，仅用于独立线程内，不要求 R: Send + Sync。
pub struct PickerContentIoProvider<R: Runtime> {
    app_handle: Arc<AppHandle<R>>,
}

impl<R: Runtime> PickerContentIoProvider<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            app_handle: Arc::new(app_handle),
        }
    }
}

#[derive(Debug)]
enum Request {
    IsDirectory(String),
    GetMimeType(String),
    ListChildren(String),
    ReadFileBytes(String),
    TakePersistablePermission(String),
    GetImageDimensions(String),
    GetContentSize(String),
    GetDisplayName(String),
    CopyImageToPictures {
        source_path: String,
        mime_type: String,
        display_name: String,
    },
    CopyExtractedImagesToPictures(String),
}

#[derive(Debug)]
enum Response {
    IsDirectory(Result<bool, String>),
    GetMimeType(Result<Option<String>, String>),
    ListChildren(Result<Vec<ContentEntry>, String>),
    ReadFileBytes(Result<Vec<u8>, String>),
    TakePersistablePermission(Result<(), String>),
    GetImageDimensions(Result<(u32, u32), String>),
    GetContentSize(Result<u64, String>),
    GetDisplayName(Result<String, String>),
    CopyImageToPictures(Result<String, String>),
    CopyExtractedImagesToPictures(Result<Vec<CopiedImageEntry>, String>),
}

/// 在独立线程中运行真实 Provider，用 channel 接收请求并返回结果。避免 Wry 跨线程 (Send/Sync)。
fn run_worker_loop<R: Runtime + 'static>(
    provider: PickerContentIoProvider<R>,
    rx: mpsc::Receiver<(Request, oneshot::Sender<Response>)>,
) {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ContentIo] worker runtime new failed: {}", e);
            return;
        }
    };
    while let Ok((req, resp_tx)) = rx.recv() {
        let response = match req {
            Request::IsDirectory(uri) => {
                let p = &provider;
                Response::IsDirectory(
                    rt.block_on(async move {
                        p.app_handle
                            .picker()
                            .is_directory(uri)
                            .await
                            .map(|r| r.is_directory)
                            .map_err(|e| e.to_string())
                    }),
                )
            }
            Request::GetMimeType(uri) => {
                let p = &provider;
                Response::GetMimeType(
                    rt.block_on(async move {
                        p.app_handle
                            .picker()
                            .get_mime_type(uri)
                            .await
                            .map(|r| r.mime_type)
                            .map_err(|e| e.to_string())
                    }),
                )
            }
            Request::ListChildren(uri) => {
                let p = &provider;
                Response::ListChildren(
                    rt.block_on(async move {
                        let resp = p
                            .app_handle
                            .picker()
                            .list_content_children(uri)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(resp
                            .entries
                            .into_iter()
                            .map(|e| ContentEntry {
                                uri: e.uri,
                                name: e.name,
                                is_directory: e.is_directory,
                            })
                            .collect())
                    }),
                )
            }
            Request::ReadFileBytes(uri) => {
                let p = &provider;
                Response::ReadFileBytes(
                    rt.block_on(async move {
                        let resp = p
                            .app_handle
                            .picker()
                            .read_file_bytes(uri)
                            .await
                            .map_err(|e| e.to_string())?;
                        base64::engine::general_purpose::STANDARD
                            .decode(&resp.data)
                            .map_err(|e| e.to_string())
                    }),
                )
            }
            Request::TakePersistablePermission(uri) => {
                let p = &provider;
                Response::TakePersistablePermission(
                    rt.block_on(async move {
                        p.app_handle
                            .picker()
                            .take_persistable_permission(uri)
                            .await
                            .map_err(|e| e.to_string())
                    }),
                )
            }
            Request::GetImageDimensions(uri) => {
                let p = &provider;
                Response::GetImageDimensions(
                    rt.block_on(async move {
                        let resp = p
                            .app_handle
                            .picker()
                            .get_image_dimensions(uri)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok((resp.width, resp.height))
                    }),
                )
            }
            Request::GetContentSize(uri) => {
                let p = &provider;
                Response::GetContentSize(rt.block_on(async move {
                    let resp = p
                        .app_handle
                        .picker()
                        .get_content_size(uri)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(resp.size)
                }))
            }
            Request::GetDisplayName(uri) => {
                let p = &provider;
                Response::GetDisplayName(
                    rt.block_on(async move {
                        let resp = p
                            .app_handle
                            .picker()
                            .get_display_name(uri)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(resp.name)
                    }),
                )
            }
            Request::CopyImageToPictures {
                source_path,
                mime_type,
                display_name,
            } => {
                let p = &provider;
                Response::CopyImageToPictures(rt.block_on(async move {
                    let resp = p
                        .app_handle
                        .picker()
                        .copy_image_to_pictures(source_path, mime_type, display_name)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(resp.content_uri)
                }))
            }
            Request::CopyExtractedImagesToPictures(source_dir) => {
                let p = &provider;
                Response::CopyExtractedImagesToPictures(rt.block_on(async move {
                    let resp = p
                        .app_handle
                        .picker()
                        .copy_extracted_images_to_pictures(source_dir)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(resp
                        .entries
                        .into_iter()
                        .map(|entry| CopiedImageEntry {
                            content_uri: entry.content_uri,
                            display_name: entry.display_name,
                        })
                        .collect())
                }))
            }
        };
        let _ = resp_tx.send(response);
    }
}

/// 通过 channel 转发到独立线程的 Provider，实现 Send + Sync，可安全存入 core 的 OnceLock。
pub struct ChannelContentIoProvider {
    tx: mpsc::Sender<(Request, oneshot::Sender<Response>)>,
}

impl ChannelContentIoProvider {
    pub fn new<R: Runtime + 'static>(
        provider: PickerContentIoProvider<R>,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || run_worker_loop(provider, rx));
        Self { tx }
    }
}

#[async_trait]
impl ContentIoProvider for ChannelContentIoProvider {
    async fn is_directory(&self, uri: &str) -> Result<bool, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::IsDirectory(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::IsDirectory(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn get_mime_type(&self, uri: &str) -> Result<Option<String>, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::GetMimeType(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::GetMimeType(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn list_children(&self, uri: &str) -> Result<Vec<ContentEntry>, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::ListChildren(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::ListChildren(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn read_file_bytes(&self, uri: &str) -> Result<Vec<u8>, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::ReadFileBytes(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::ReadFileBytes(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn take_persistable_permission(&self, uri: &str) -> Result<(), String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::TakePersistablePermission(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::TakePersistablePermission(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn get_image_dimensions(&self, uri: &str) -> Result<(u32, u32), String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::GetImageDimensions(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::GetImageDimensions(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn get_content_size(&self, uri: &str) -> Result<u64, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::GetContentSize(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::GetContentSize(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn get_display_name(&self, uri: &str) -> Result<String, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::GetDisplayName(uri.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::GetDisplayName(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn copy_image_to_pictures(
        &self,
        source_path: &str,
        mime_type: &str,
        display_name: &str,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((
                Request::CopyImageToPictures {
                    source_path: source_path.to_string(),
                    mime_type: mime_type.to_string(),
                    display_name: display_name.to_string(),
                },
                resp_tx,
            ))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::CopyImageToPictures(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }

    async fn copy_extracted_images_to_pictures(
        &self,
        source_dir: &str,
    ) -> Result<Vec<CopiedImageEntry>, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((Request::CopyExtractedImagesToPictures(source_dir.to_string()), resp_tx))
            .map_err(|e| e.to_string())?;
        match resp_rx.await.map_err(|e| e.to_string())? {
            Response::CopyExtractedImagesToPictures(r) => r,
            _ => Err("unexpected response".to_string()),
        }
    }
}
