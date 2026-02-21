//! Android ContentIoProvider 实现：通过 Picker 插件调用 Kotlin API，并在 setup 时注册到 core。

#![cfg(target_os = "android")]

use base64::Engine;
use kabegame_core::crawler::content_io::{
    ContentEntry, ContentIoProvider, ExtractArchiveResult,
};
use std::sync::Arc;
use tauri::{AppHandle, Runtime};
use tauri_plugin_picker::PickerExt;

/// 基于 Picker PluginHandle 的 ContentIoProvider，在 setup 时注册到 core。
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

impl<R: Runtime> ContentIoProvider for PickerContentIoProvider<R> {
    fn is_directory(&self, uri: &str) -> Result<bool, String> {
        let handle = self.app_handle.clone();
        let uri = uri.to_string();
        tauri::async_runtime::block_on(async move {
            handle
                .picker()
                .is_directory(uri)
                .await
                .map(|r| r.is_directory)
                .map_err(|e| e.to_string())
        })
    }

    fn get_mime_type(&self, uri: &str) -> Result<Option<String>, String> {
        let handle = self.app_handle.clone();
        let uri = uri.to_string();
        tauri::async_runtime::block_on(async move {
            handle
                .picker()
                .get_mime_type(uri)
                .await
                .map(|r| r.mime_type)
                .map_err(|e| e.to_string())
        })
    }

    fn list_children(&self, uri: &str) -> Result<Vec<ContentEntry>, String> {
        let handle = self.app_handle.clone();
        let uri = uri.to_string();
        tauri::async_runtime::block_on(async move {
            let resp = handle.picker().list_content_children(uri).await.map_err(|e| e.to_string())?;
            Ok(resp
                .entries
                .into_iter()
                .map(|e| ContentEntry {
                    uri: e.uri,
                    name: e.name,
                    is_directory: e.is_directory,
                })
                .collect())
        })
    }

    fn read_file_bytes(&self, uri: &str) -> Result<Vec<u8>, String> {
        let handle = self.app_handle.clone();
        let uri = uri.to_string();
        tauri::async_runtime::block_on(async move {
            let resp = handle.picker().read_file_bytes(uri).await.map_err(|e| e.to_string())?;
            base64::engine::general_purpose::STANDARD
                .decode(&resp.data)
                .map_err(|e| e.to_string())
        })
    }

    fn take_persistable_permission(&self, uri: &str) -> Result<(), String> {
        let handle = self.app_handle.clone();
        let uri = uri.to_string();
        tauri::async_runtime::block_on(async move {
            handle
                .picker()
                .take_persistable_permission(uri)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn extract_archive_to_media_store(
        &self,
        archive_uri: &str,
        folder_name: &str,
    ) -> Result<ExtractArchiveResult, String> {
        let handle = self.app_handle.clone();
        let archive_uri = archive_uri.to_string();
        let folder_name = folder_name.to_string();
        tauri::async_runtime::block_on(async move {
            let resp = handle
                .picker()
                .extract_archive_to_media_store(archive_uri, folder_name)
                .await
                .map_err(|e| e.to_string())?;
            Ok(ExtractArchiveResult {
                uris: resp.uris,
                count: resp.count,
            })
        })
    }
}
