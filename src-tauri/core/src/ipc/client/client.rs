//! IPC 客户端：封装与 daemon 的通信，供所有前端（app-main、cli）复用
//!
//! 使用示例：
//! ```rust,no_run
//! use kabegame_core::ipc::client::IpcClient;
//!
//! fn main() -> Result<(), String> {
//!     let rt = tokio::runtime::Runtime::new().unwrap();
//!     rt.block_on(async {
//!         let client = IpcClient::new();
//!         client.connect().await?;
//!
//!         let _images = client.storage_get_images().await?;
//!         let _albums = client.storage_get_albums().await?;
//!         let _plugins = client.plugin_get_plugins().await?;
//!         let _auto_launch = client.settings_get_auto_launch().await?;
//!         Ok(())
//!     })
//! }
//! ```

use std::sync::Arc;

use super::connection::{ConnectionStatus, PersistentConnection};
use crate::ipc::ipc::{IpcRequest, IpcResponse};
use tokio::sync::watch;

/// IPC 客户端（基于持久连接）
#[derive(Clone)]
pub struct IpcClient {
    pub connection: Arc<PersistentConnection>,
}

impl IpcClient {
    pub fn new() -> Self {
        Self {
            connection: Arc::new(PersistentConnection::new()),
        }
    }

    /// 连接到 daemon
    ///
    /// 在应用首次启动或用户手动重连时调用此方法建立连接。
    pub async fn connect(&self) -> Result<(), String> {
        self.connection.clone().connect().await
    }

    /// 内部辅助函数：发送请求并返回 data 字段
    /// TODO: data泛型化
    async fn request_data(&self, req: IpcRequest) -> Result<serde_json::Value, String> {
        let resp = self.connection.request(req).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.data)
    }

    /// 内部辅助函数：发送请求并检查是否成功
    async fn request_ok(&self, req: IpcRequest) -> Result<(), String> {
        let resp = self.connection.request(req).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

    /// 内部辅助函数：发送请求并返回完整响应
    async fn request_raw(&self, req: IpcRequest) -> Result<IpcResponse, String> {
        self.connection.request(req).await
    }

    /// 内部辅助函数：发送请求并返回 bytes 字段
    async fn request_bytes(&self, req: IpcRequest) -> Result<Option<Vec<u8>>, String> {
        let resp = self.connection.request(req).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.bytes.map(|b| b.as_slice().to_vec()))
    }

    // ==================== Status ====================

    /// 检查 daemon 状态
    pub async fn status(&self) -> Result<serde_json::Value, String> {
        let resp = self.request_raw(IpcRequest::Status).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.info.unwrap_or(serde_json::json!({})))
    }

    /// 获取当前连接状态
    pub async fn connection_status(&self) -> ConnectionStatus {
        self.connection.get_status().await
    }

    /// 订阅连接状态变化
    pub fn subscribe_connection_status(&self) -> watch::Receiver<ConnectionStatus> {
        self.connection.subscribe_status()
    }

    // ==================== Storage - Images ====================
    /// 获取图片总数
    pub async fn storage_get_images_count(&self) -> Result<usize, String> {
        let v = self
            .request_data(IpcRequest::StorageGetImagesCount)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    /// 根据 ID 获取图片
    pub async fn storage_get_image_by_id(
        &self,
        image_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetImageById { image_id })
            .await
    }

    /// 根据本地路径查找图片
    pub async fn storage_find_image_by_path(
        &self,
        path: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageFindImageByPath { path })
            .await
    }

    /// 删除图片
    pub async fn storage_delete_image(&self, image_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageDeleteImage { image_id })
            .await
    }

    /// 仅从 DB 移除图片（不删除本地文件）
    pub async fn storage_remove_image(&self, image_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageRemoveImage { image_id })
            .await
    }

    /// 批量删除图片（删除本地文件 + DB）
    pub async fn storage_batch_delete_images(&self, image_ids: Vec<String>) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageBatchDeleteImages { image_ids })
            .await
    }

    /// 批量仅从 DB 移除图片
    pub async fn storage_batch_remove_images(&self, image_ids: Vec<String>) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageBatchRemoveImages { image_ids })
            .await
    }

    /// 收藏/取消收藏图片
    pub async fn storage_toggle_image_favorite(
        &self,
        image_id: String,
        favorite: bool,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageToggleImageFavorite { image_id, favorite })
            .await
    }

    // ==================== Storage - Albums ====================

    /// 获取所有画册
    pub async fn storage_get_albums(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAlbums).await
    }

    /// 添加画册
    pub async fn storage_add_album(&self, name: String) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageAddAlbum { name })
            .await
    }

    /// 删除画册
    pub async fn storage_delete_album(&self, album_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageDeleteAlbum { album_id })
            .await
    }

    pub async fn storage_rename_album(
        &self,
        album_id: String,
        new_name: String,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageRenameAlbum { album_id, new_name })
            .await
    }

    /// 添加图片到画册
    pub async fn storage_add_images_to_album(
        &self,
        album_id: String,
        image_ids: Vec<String>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageAddImagesToAlbum {
            album_id,
            image_ids,
        })
        .await
    }

    pub async fn storage_remove_images_from_album(
        &self,
        album_id: String,
        image_ids: Vec<String>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageRemoveImagesFromAlbum {
            album_id,
            image_ids,
        })
        .await
    }

    /// 获取画册图片
    pub async fn storage_get_album_images(
        &self,
        album_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAlbumImages { album_id })
            .await
    }

    pub async fn storage_get_album_preview(
        &self,
        album_id: String,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAlbumPreview { album_id, limit })
            .await
    }

    pub async fn storage_get_album_counts(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAlbumCounts)
            .await
    }

    pub async fn storage_update_album_images_order(
        &self,
        album_id: String,
        image_orders: Vec<(String, i64)>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageUpdateAlbumImagesOrder {
            album_id,
            image_orders,
        })
        .await
    }

    /// 获取画册图片 ID 列表
    pub async fn storage_get_album_image_ids(
        &self,
        album_id: String,
    ) -> Result<Vec<String>, String> {
        let v = self
            .request_data(IpcRequest::StorageGetAlbumImageIds { album_id })
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    // ==================== Storage - Tasks ====================

    /// 获取所有任务
    pub async fn storage_get_all_tasks(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAllTasks).await
    }

    /// 根据 ID 获取任务
    pub async fn storage_get_task(&self, task_id: String) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetTask { task_id })
            .await
    }

    /// 添加任务
    pub async fn storage_add_task(&self, task: serde_json::Value) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageAddTask { task })
            .await
    }

    /// 更新任务
    pub async fn storage_update_task(&self, task: serde_json::Value) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageUpdateTask { task })
            .await
    }

    /// 删除任务
    pub async fn storage_delete_task(&self, task_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageDeleteTask { task_id })
            .await
    }

    /// 获取任务失败图片
    pub async fn storage_get_task_failed_images(
        &self,
        task_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetTaskFailedImages { task_id })
            .await
    }

    /// 获取所有任务失败图片
    pub async fn storage_get_all_failed_images(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetAllFailedImages)
            .await
    }

    pub async fn storage_clear_finished_tasks(&self) -> Result<usize, String> {
        let v = self
            .request_data(IpcRequest::StorageClearFinishedTasks)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    // ==================== Storage - Run Configs ====================

    /// 获取运行配置列表
    pub async fn storage_get_run_configs(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetRunConfigs).await
    }

    /// 添加运行配置
    pub async fn storage_add_run_config(
        &self,
        config: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageAddRunConfig { config })
            .await
    }

    /// 更新运行配置
    pub async fn storage_update_run_config(&self, config: serde_json::Value) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageUpdateRunConfig { config })
            .await
    }

    /// 删除运行配置
    pub async fn storage_delete_run_config(&self, config_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::StorageDeleteRunConfig { config_id })
            .await
    }

    // ==================== Storage - Gallery Query Helpers ====================

    pub async fn storage_get_gallery_date_groups(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetGalleryDateGroups)
            .await
    }

    pub async fn storage_get_gallery_plugin_groups(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetGalleryPluginGroups)
            .await
    }

    pub async fn storage_get_tasks_with_images(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::StorageGetTasksWithImages)
            .await
    }

    // ==================== Gallery / Provider ====================

    pub async fn gallery_browse_provider(&self, path: String) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::GalleryBrowseProvider { path })
            .await
    }

    // ==================== Plugin ====================

    /// 获取已安装插件列表
    pub async fn plugin_get_plugins(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginGetPlugins).await
    }

    /// 获取插件详情
    pub async fn plugin_get_detail(&self, plugin_id: String) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginGetDetail { plugin_id })
            .await
    }

    /// 删除插件
    pub async fn plugin_delete(&self, plugin_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::PluginDelete { plugin_id })
            .await
    }

    /// 导入插件
    pub async fn plugin_import(&self, kgpg_path: String) -> Result<String, String> {
        let resp = self
            .request_raw(IpcRequest::PluginImport { kgpg_path })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        if resp.data.is_null() {
            return Err("No data in response".to_string());
        }
        let plugin_id: String = serde_json::from_value(resp.data["pluginId"].clone())
            .map_err(|e| format!("Failed to parse plugin_id: {}", e))?;
        Ok(plugin_id)
    }

    /// 获取插件源列表
    pub async fn plugin_get_plugin_sources(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginGetPluginSources)
            .await
    }

    pub async fn plugin_validate_source(
        &self,
        index_url: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginValidateSource { index_url })
            .await
    }

    pub async fn plugin_add_source(
        &self,
        id: Option<String>,
        name: String,
        index_url: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginAddSource {
            id,
            name,
            index_url,
        })
        .await
    }

    pub async fn plugin_update_source(
        &self,
        id: String,
        name: String,
        index_url: String,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::PluginUpdateSource {
            id,
            name,
            index_url,
        })
        .await
    }

    pub async fn plugin_delete_source(&self, id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::PluginDeleteSource { id })
            .await
    }

    pub async fn plugin_get_store_plugins(
        &self,
        source_id: Option<String>,
        force_refresh: bool,
        revalidate_if_stale_after_secs: Option<u64>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginGetStorePlugins {
            source_id,
            force_refresh,
            revalidate_if_stale_after_secs,
        })
        .await
    }

    pub async fn plugin_preview_import(
        &self,
        zip_path: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginPreviewImport { zip_path })
            .await
    }

    pub async fn plugin_preview_store_install(
        &self,
        source_id: String,
        plugin_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::PluginPreviewStoreInstall {
            source_id,
            plugin_id,
        })
        .await
    }

    pub async fn plugin_get_remote_icon_v2(
        &self,
        download_url: String,
    ) -> Result<Option<Vec<u8>>, String> {
        self.request_bytes(IpcRequest::PluginGetRemoteIconV2 {
            download_url,
            source_id: None,
            plugin_id: None,
        })
        .await
    }

    /// 运行插件
    pub async fn plugin_run(
        &self,
        plugin: String,
        output_dir: Option<String>,
        task_id: Option<String>,
        output_album_id: Option<String>,
        plugin_args: Vec<String>,
    ) -> Result<String, String> {
        let resp = self
            .request_raw(IpcRequest::PluginRun {
                plugin,
                output_dir,
                task_id: task_id.clone(),
                output_album_id,
                plugin_args,
                http_headers: None,
            })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.task_id.unwrap_or_else(|| task_id.unwrap_or_default()))
    }

    // ========== Settings Getter ==========

    pub async fn settings_get_auto_launch(&self) -> Result<bool, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetAutoLaunch)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_max_concurrent_downloads(&self) -> Result<u32, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetMaxConcurrentDownloads)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_max_concurrent_tasks(&self) -> Result<u32, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetMaxConcurrentTasks)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_network_retry_count(&self) -> Result<u32, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetNetworkRetryCount)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_image_click_action(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetImageClickAction)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_gallery_image_aspect_ratio(&self) -> Result<Option<String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetGalleryImageAspectRatio)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_auto_deduplicate(&self) -> Result<bool, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetAutoDeduplicate)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_default_download_dir(&self) -> Result<Option<String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetDefaultDownloadDir)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_wallpaper_engine_dir(&self) -> Result<Option<String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperEngineDir)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_wallpaper_rotation_enabled(&self) -> Result<bool, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationEnabled)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_rotation_album_id(&self) -> Result<Option<String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationAlbumId)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_wallpaper_rotation_include_subalbums(&self) -> Result<bool, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationIncludeSubalbums)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_rotation_interval_minutes(&self) -> Result<u32, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationIntervalMinutes)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_rotation_mode(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationMode)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_rotation_style(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperStyle)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_rotation_transition(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperRotationTransition)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_style_by_mode(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperStyleByMode)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_transition_by_mode(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperTransitionByMode)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_wallpaper_mode(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWallpaperMode)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_get_window_state(
        &self,
    ) -> Result<Option<crate::settings::WindowState>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetWindowState)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_current_wallpaper_image_id(&self) -> Result<Option<String>, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetCurrentWallpaperImageId)
            .await?;
        if v.is_null() {
            Ok(None)
        } else {
            serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
        }
    }

    pub async fn settings_get_default_images_dir(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetDefaultImagesDir)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    #[cfg(feature = "virtual-driver")]
    pub async fn settings_get_album_drive_enabled(&self) -> Result<bool, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetAlbumDriveEnabled)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    #[cfg(feature = "virtual-driver")]
    pub async fn settings_get_album_drive_mount_point(&self) -> Result<String, String> {
        let v = self
            .request_data(IpcRequest::SettingsGetAlbumDriveMountPoint)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn settings_set_gallery_image_aspect_ratio(
        &self,
        aspect_ratio: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio })
            .await
    }

    pub async fn settings_set_wallpaper_engine_dir(
        &self,
        dir: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperEngineDir { dir })
            .await
    }

    pub async fn settings_get_wallpaper_engine_myprojects_dir(
        &self,
    ) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::SettingsGetWallpaperEngineMyprojectsDir)
            .await
    }

    pub async fn settings_set_wallpaper_rotation_enabled(
        &self,
        enabled: bool,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperRotationEnabled { enabled })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_album_id(
        &self,
        album_id: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperRotationAlbumId { album_id })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_include_subalbums(
        &self,
        include_subalbums: bool,
    ) -> Result<(), String> {
        self.request_ok(
            IpcRequest::SettingsSetWallpaperRotationIncludeSubalbums { include_subalbums },
        )
        .await
    }

    pub async fn settings_set_wallpaper_rotation_transition(
        &self,
        transition: String,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperRotationTransition { transition })
            .await
    }

    pub async fn settings_set_wallpaper_style(&self, style: String) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperStyle { style })
            .await
    }

    pub async fn settings_set_wallpaper_mode(&self, mode: String) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperMode { mode })
            .await
    }

    #[cfg(feature = "virtual-driver")]
    pub async fn settings_set_album_drive_enabled(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetAlbumDriveEnabled { enabled })
            .await
    }

    #[cfg(feature = "virtual-driver")]
    pub async fn settings_set_album_drive_mount_point(
        &self,
        mount_point: String,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetAlbumDriveMountPoint { mount_point })
            .await
    }

    pub async fn settings_set_auto_launch(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetAutoLaunch { enabled })
            .await
    }

    pub async fn settings_set_max_concurrent_downloads(&self, count: u32) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetMaxConcurrentDownloads { count })
            .await
    }

    pub async fn settings_set_max_concurrent_tasks(&self, count: u32) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetMaxConcurrentTasks { count })
            .await
    }

    pub async fn settings_set_network_retry_count(&self, count: u32) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetNetworkRetryCount { count })
            .await
    }

    pub async fn settings_set_image_click_action(&self, action: String) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetImageClickAction { action })
            .await
    }

    pub async fn settings_set_auto_deduplicate(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetAutoDeduplicate { enabled })
            .await
    }

    pub async fn settings_set_default_download_dir(
        &self,
        dir: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetDefaultDownloadDir { dir })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_interval_minutes(
        &self,
        minutes: u32,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_mode(&self, mode: String) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetWallpaperRotationMode { mode })
            .await
    }

    pub async fn settings_set_current_wallpaper_image_id(
        &self,
        image_id: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::SettingsSetCurrentWallpaperImageId { image_id })
            .await
    }

    pub async fn settings_swap_style_transition_for_mode_switch(
        &self,
        old_mode: String,
        new_mode: String,
    ) -> Result<(String, String), String> {
        let v = self
            .request_data(IpcRequest::SettingsSwapStyleTransitionForModeSwitch {
                old_mode,
                new_mode,
            })
            .await?;
        let style = v
            .get("style")
            .and_then(|x| x.as_str())
            .unwrap_or("fill")
            .to_string();
        let transition = v
            .get("transition")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string();
        Ok((style, transition))
    }

    // ==================== Task scheduling ====================
    pub async fn task_start(&self, task: serde_json::Value) -> Result<String, String> {
        let resp = self.request_raw(IpcRequest::TaskStart { task }).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.task_id.unwrap_or_default())
    }

    pub async fn task_cancel(&self, task_id: String) -> Result<(), String> {
        self.request_ok(IpcRequest::TaskCancel { task_id }).await
    }

    pub async fn task_retry_failed_image(&self, failed_id: i64) -> Result<(), String> {
        self.request_ok(IpcRequest::TaskRetryFailedImage { failed_id })
            .await
    }

    /// 获取正在下载的任务列表
    pub async fn get_active_downloads(&self) -> Result<serde_json::Value, String> {
        self.request_data(IpcRequest::GetActiveDownloads).await
    }

    pub async fn organize_start(
        &self,
        dedupe: bool,
        remove_missing: bool,
        regen_thumbnails: bool,
        remove_unrecognized: bool,
        range_start: Option<usize>,
        range_end: Option<usize>,
        delete_source_files: bool,
        safe_delete: bool,
    ) -> Result<(), String> {
        self.request_ok(IpcRequest::OrganizeStart {
            dedupe,
            remove_missing,
            regen_thumbnails,
            remove_unrecognized,
            range_start,
            range_end,
            delete_source_files,
            safe_delete,
        })
        .await
    }

    pub async fn organize_cancel(&self) -> Result<bool, String> {
        let v = self.request_data(IpcRequest::OrganizeCancel).await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    // ==================== Virtual Driver ====================

    /// 挂载虚拟盘
    #[cfg(feature = "virtual-driver")]
    pub async fn vd_mount(&self) -> Result<(), String> {
        let resp = self.request_raw(IpcRequest::VdMount).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

    /// 卸载虚拟盘
    #[cfg(feature = "virtual-driver")]
    pub async fn vd_unmount(&self) -> Result<(), String> {
        let resp = self.request_raw(IpcRequest::VdUnmount).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

    /// 获取虚拟盘状态
    #[cfg(feature = "virtual-driver")]
    pub async fn vd_status(&self) -> Result<(bool, Option<String>), String> {
        let resp = self.request_raw(IpcRequest::VdStatus).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok((resp.mounted.unwrap_or(false), resp.mount_point))
    }

    // ==================== Events ====================

    /// 订阅事件并建立长连接，持续读取事件（按事件类型过滤）
    ///
    /// 参数 `kinds` 是感兴趣的事件类型列表，空列表表示订阅全部事件。
    /// 参数 `on_event` 是回调函数，每当收到一个事件时会被调用。
    /// 函数会持续运行直到连接关闭或发生错误。
    ///
    /// 事件格式：每行一个 JSON 对象（serde_json::Value）
    ///
    /// 注意：此方法使用统一的 PersistentConnection，与请求共享同一个连接。
    /// 这个函数仅能调用一次
    /// 自动处理连接状态变化
    pub async fn subscribe_events_stream<F, Fut>(
        &mut self,
        kinds: &[crate::ipc::events::DaemonEventKind],
        mut on_event: F,
    ) -> Result<(), String>
    where
        F: FnMut(serde_json::Value) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        // 将事件类型转为字符串列表
        let kinds: Vec<String> = kinds
            .iter()
            .map(|k| serde_json::to_string(k).unwrap_or_default())
            .collect();

        // 使用统一的 PersistentConnection 订阅事件
        self.connection
            .request(IpcRequest::SubscribeEvents { kinds })
            .await?;

        eprintln!("[DEBUG] IpcClient::subscribe_events_stream 订阅成功，开始接收事件流");

        // 获取 event_rx 的克隆
        let event_rx = {
            let handle = self.connection.handle.read().await;
            handle.as_ref().unwrap().event_rx.clone()
        };

        // 持续接收事件
        while let Some(event) = event_rx.lock().await.recv().await {
            eprintln!(
                "[DEBUG] IpcClient::subscribe_events_stream 收到事件: {:?}",
                event
            );
            on_event(event).await;
        }

        eprintln!("[DEBUG] IpcClient::subscribe_events_stream 事件流结束");
        Ok(())
    }
}

impl Default for IpcClient {
    fn default() -> Self {
        Self::new()
    }
}
