//! IPC 客户端：封装与 daemon 的通信，供所有前端（app-main、plugin-editor、cli）复用
//!
//! 使用示例：
//! ```rust
//! use kabegame_core::ipc::client::IpcClient;
//!
//! let client = IpcClient::new();
//!
//! // Storage 操作
//! let images = client.storage_get_images().await?;
//! let albums = client.storage_get_albums().await?;
//!
//! // Plugin 操作
//! let plugins = client.plugin_get_plugins().await?;
//!
//! // Settings 操作
//! let settings = client.settings_get().await?;
//! ```

use super::ipc::{request, CliIpcRequest, CliIpcResponse};

/// IPC 客户端
#[derive(Debug, Clone)]
pub struct IpcClient;

impl IpcClient {
    pub fn new() -> Self {
        Self
    }

    /// 内部辅助函数：发送请求并返回 data 字段（客户端仅依赖 ipc，不暴露 core 业务类型）
    async fn request_data(&self, req: CliIpcRequest) -> Result<serde_json::Value, String> {
        let resp = request(req).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        resp.data.ok_or_else(|| "No data in response".to_string())
    }

    /// 内部辅助函数：发送请求并检查是否成功
    async fn request_ok(&self, req: CliIpcRequest) -> Result<(), String> {
        let resp = request(req).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

    /// 内部辅助函数：发送请求并返回完整响应
    async fn request_raw(&self, req: CliIpcRequest) -> Result<CliIpcResponse, String> {
        request(req).await
    }

    // ==================== Status ====================
    
    /// 检查 daemon 状态
    pub async fn status(&self) -> Result<serde_json::Value, String> {
        let resp = self.request_raw(CliIpcRequest::Status).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.info.unwrap_or(serde_json::json!({})))
    }

    // ==================== Storage - Images ====================

    /// 获取所有图片
    pub async fn storage_get_images(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetImages).await
    }

    /// 分页获取图片
    pub async fn storage_get_images_paginated(
        &self,
        page: usize,
        page_size: usize,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetImagesPaginated { page, page_size })
            .await
    }

    /// 获取图片总数
    pub async fn storage_get_images_count(&self) -> Result<usize, String> {
        let v = self.request_data(CliIpcRequest::StorageGetImagesCount).await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    /// 根据 ID 获取图片
    pub async fn storage_get_image_by_id(
        &self,
        image_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetImageById { image_id }).await
    }

    /// 根据本地路径查找图片
    pub async fn storage_find_image_by_path(&self, path: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageFindImageByPath { path }).await
    }

    // ==================== Wallpaper Engine Export ====================

    pub async fn we_export_images_to_project(
        &self,
        image_paths: Vec<String>,
        title: Option<String>,
        output_parent_dir: String,
        options: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::WeExportImagesToProject {
            image_paths,
            title,
            output_parent_dir,
            options,
        })
        .await
    }

    pub async fn we_export_album_to_project(
        &self,
        album_id: String,
        album_name: String,
        output_parent_dir: String,
        options: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::WeExportAlbumToProject {
            album_id,
            album_name,
            output_parent_dir,
            options,
        })
        .await
    }

    /// 删除图片
    pub async fn storage_delete_image(&self, image_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageDeleteImage { image_id })
            .await
    }

    /// 仅从 DB 移除图片（不删除本地文件）
    pub async fn storage_remove_image(&self, image_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageRemoveImage { image_id })
            .await
    }

    /// 批量删除图片（删除本地文件 + DB）
    pub async fn storage_batch_delete_images(&self, image_ids: Vec<String>) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageBatchDeleteImages { image_ids })
            .await
    }

    /// 批量仅从 DB 移除图片
    pub async fn storage_batch_remove_images(&self, image_ids: Vec<String>) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageBatchRemoveImages { image_ids })
            .await
    }

    /// 收藏/取消收藏图片
    pub async fn storage_toggle_image_favorite(
        &self,
        image_id: String,
        favorite: bool,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageToggleImageFavorite { image_id, favorite })
            .await
    }

    // ==================== Storage - Albums ====================

    /// 获取所有画册
    pub async fn storage_get_albums(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetAlbums).await
    }

    /// 添加画册
    pub async fn storage_add_album(&self, name: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageAddAlbum { name }).await
    }

    /// 删除画册
    pub async fn storage_delete_album(&self, album_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageDeleteAlbum { album_id })
            .await
    }

    pub async fn storage_rename_album(&self, album_id: String, new_name: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageRenameAlbum { album_id, new_name })
            .await
    }

    /// 添加图片到画册
    pub async fn storage_add_images_to_album(
        &self,
        album_id: String,
        image_ids: Vec<String>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageAddImagesToAlbum { album_id, image_ids })
            .await
    }

    pub async fn storage_remove_images_from_album(
        &self,
        album_id: String,
        image_ids: Vec<String>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageRemoveImagesFromAlbum { album_id, image_ids })
            .await
    }

    /// 获取画册图片
    pub async fn storage_get_album_images(
        &self,
        album_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetAlbumImages { album_id }).await
    }

    pub async fn storage_get_album_preview(
        &self,
        album_id: String,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetAlbumPreview { album_id, limit })
            .await
    }

    pub async fn storage_get_album_counts(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetAlbumCounts).await
    }

    pub async fn storage_update_album_images_order(
        &self,
        album_id: String,
        image_orders: Vec<(String, i64)>,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageUpdateAlbumImagesOrder { album_id, image_orders })
            .await
    }

    /// 获取画册图片 ID 列表
    pub async fn storage_get_album_image_ids(
        &self,
        album_id: String,
    ) -> Result<Vec<String>, String> {
        let v = self.request_data(CliIpcRequest::StorageGetAlbumImageIds { album_id }).await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    // ==================== Storage - Tasks ====================

    /// 获取所有任务
    pub async fn storage_get_all_tasks(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetAllTasks).await
    }

    /// 根据 ID 获取任务
    pub async fn storage_get_task(
        &self,
        task_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetTask { task_id }).await
    }

    /// 添加任务
    pub async fn storage_add_task(&self, task: serde_json::Value) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageAddTask { task }).await
    }

    /// 更新任务
    pub async fn storage_update_task(&self, task: serde_json::Value) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageUpdateTask { task }).await
    }

    /// 删除任务
    pub async fn storage_delete_task(&self, task_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageDeleteTask { task_id })
            .await
    }

    /// 获取任务图片
    pub async fn storage_get_task_images(
        &self,
        task_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetTaskImages { task_id }).await
    }

    pub async fn storage_get_task_image_ids(&self, task_id: String) -> Result<Vec<String>, String> {
        let v = self
            .request_data(CliIpcRequest::StorageGetTaskImageIds { task_id })
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn storage_get_task_images_paginated(
        &self,
        task_id: String,
        offset: usize,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetTaskImagesPaginated {
            task_id,
            offset,
            limit,
        })
        .await
    }

    /// 获取任务失败图片
    pub async fn storage_get_task_failed_images(
        &self,
        task_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetTaskFailedImages { task_id }).await
    }

    pub async fn storage_confirm_task_rhai_dump(&self, task_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageConfirmTaskRhaiDump { task_id })
            .await
    }

    pub async fn storage_clear_finished_tasks(&self) -> Result<usize, String> {
        let v = self.request_data(CliIpcRequest::StorageClearFinishedTasks).await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    // ==================== Storage - Run Configs ====================

    /// 获取运行配置列表
    pub async fn storage_get_run_configs(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetRunConfigs).await
    }

    /// 添加运行配置
    pub async fn storage_add_run_config(
        &self,
        config: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageAddRunConfig { config }).await
    }

    /// 更新运行配置
    pub async fn storage_update_run_config(
        &self,
        config: serde_json::Value,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageUpdateRunConfig { config }).await
    }

    /// 删除运行配置
    pub async fn storage_delete_run_config(&self, config_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::StorageDeleteRunConfig { config_id })
            .await
    }

    // ==================== Storage - Gallery Query Helpers ====================

    pub async fn storage_get_gallery_date_groups(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetGalleryDateGroups).await
    }

    pub async fn storage_get_gallery_plugin_groups(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetGalleryPluginGroups).await
    }

    pub async fn storage_get_tasks_with_images(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetTasksWithImages).await
    }

    pub async fn storage_get_images_count_by_query(
        &self,
        query: serde_json::Value,
    ) -> Result<usize, String> {
        let v = self
            .request_data(CliIpcRequest::StorageGetImagesCountByQuery { query })
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    pub async fn storage_get_images_range_by_query(
        &self,
        query: serde_json::Value,
        offset: usize,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::StorageGetImagesRangeByQuery { query, offset, limit })
            .await
    }

    // ==================== Gallery / Provider ====================

    pub async fn gallery_browse_provider(&self, path: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::GalleryBrowseProvider { path }).await
    }

    // ==================== Plugin ====================

    /// 获取已安装插件列表
    pub async fn plugin_get_plugins(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetPlugins).await
    }

    /// 获取插件详情
    pub async fn plugin_get_detail(
        &self,
        plugin_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetDetail { plugin_id }).await
    }

    /// 删除插件
    pub async fn plugin_delete(&self, plugin_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::PluginDelete { plugin_id })
            .await
    }

    /// 导入插件
    pub async fn plugin_import(&self, kgpg_path: String) -> Result<String, String> {
        let resp = self
            .request_raw(CliIpcRequest::PluginImport { kgpg_path })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        let data = resp.data.ok_or_else(|| "No data in response".to_string())?;
        let plugin_id: String = serde_json::from_value(data["pluginId"].clone())
            .map_err(|e| format!("Failed to parse plugin_id: {}", e))?;
        Ok(plugin_id)
    }

    /// 获取插件变量定义
    pub async fn plugin_get_vars(
        &self,
        plugin_id: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetVars { plugin_id }).await
    }

    /// 获取浏览器插件列表
    pub async fn plugin_get_browser_plugins(
        &self,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetBrowserPlugins).await
    }

    /// 获取插件源列表
    pub async fn plugin_get_plugin_sources(
        &self,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetPluginSources).await
    }

    pub async fn plugin_validate_source(&self, index_url: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginValidateSource { index_url }).await
    }

    pub async fn plugin_save_plugin_sources(&self, sources: serde_json::Value) -> Result<(), String> {
        self.request_ok(CliIpcRequest::PluginSavePluginSources { sources }).await
    }

    pub async fn plugin_install_browser_plugin(&self, plugin_id: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginInstallBrowserPlugin { plugin_id }).await
    }

    pub async fn plugin_get_store_plugins(
        &self,
        source_id: Option<String>,
        force_refresh: bool,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetStorePlugins { source_id, force_refresh })
            .await
    }

    pub async fn plugin_get_detail_for_ui(
        &self,
        plugin_id: String,
        download_url: Option<String>,
        sha256: Option<String>,
        size_bytes: Option<u64>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetDetailForUi {
            plugin_id,
            download_url,
            sha256,
            size_bytes,
        })
        .await
    }

    pub async fn plugin_preview_import(&self, zip_path: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginPreviewImport { zip_path }).await
    }

    pub async fn plugin_preview_store_install(
        &self,
        download_url: String,
        sha256: Option<String>,
        size_bytes: Option<u64>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginPreviewStoreInstall {
            download_url,
            sha256,
            size_bytes,
        })
        .await
    }

    pub async fn plugin_get_icon(&self, plugin_id: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetIcon { plugin_id }).await
    }

    pub async fn plugin_get_remote_icon_v2(
        &self,
        download_url: String,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetRemoteIconV2 { download_url }).await
    }

    pub async fn plugin_get_image_for_detail(
        &self,
        plugin_id: String,
        image_path: String,
        download_url: Option<String>,
        sha256: Option<String>,
        size_bytes: Option<u64>,
    ) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::PluginGetImageForDetail {
            plugin_id,
            image_path,
            download_url,
            sha256,
            size_bytes,
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
            .request_raw(CliIpcRequest::PluginRun {
                plugin,
                output_dir,
                task_id: task_id.clone(),
                output_album_id,
                plugin_args,
            })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.task_id.unwrap_or_else(|| task_id.unwrap_or_default()))
    }

    // ==================== Settings ====================

    /// 获取所有设置
    pub async fn settings_get(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::SettingsGet).await
    }

    /// 获取单个设置
    pub async fn settings_get_key(&self, key: String) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::SettingsGetKey { key }).await
    }

    /// 更新设置
    pub async fn settings_update(&self, settings: serde_json::Value) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsUpdate { settings }).await
    }

    pub async fn settings_set_gallery_image_aspect_ratio(
        &self,
        aspect_ratio: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio })
            .await
    }

    pub async fn settings_set_wallpaper_engine_dir(&self, dir: Option<String>) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperEngineDir { dir }).await
    }

    pub async fn settings_get_wallpaper_engine_myprojects_dir(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::SettingsGetWallpaperEngineMyprojectsDir).await
    }

    pub async fn settings_set_wallpaper_rotation_enabled(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperRotationEnabled { enabled })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_album_id(
        &self,
        album_id: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperRotationAlbumId { album_id })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_transition(&self, transition: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperRotationTransition { transition })
            .await
    }

    pub async fn settings_set_wallpaper_style(&self, style: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperStyle { style }).await
    }

    pub async fn settings_set_wallpaper_mode(&self, mode: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperMode { mode }).await
    }

    pub async fn settings_set_album_drive_enabled(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetAlbumDriveEnabled { enabled })
            .await
    }

    pub async fn settings_set_album_drive_mount_point(&self, mount_point: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetAlbumDriveMountPoint { mount_point })
            .await
    }

    pub async fn settings_set_auto_launch(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetAutoLaunch { enabled }).await
    }

    pub async fn settings_set_max_concurrent_downloads(&self, count: u32) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetMaxConcurrentDownloads { count })
            .await
    }

    pub async fn settings_set_network_retry_count(&self, count: u32) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetNetworkRetryCount { count }).await
    }

    pub async fn settings_set_image_click_action(&self, action: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetImageClickAction { action }).await
    }

    pub async fn settings_set_gallery_image_aspect_ratio_match_window(
        &self,
        enabled: bool,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetGalleryImageAspectRatioMatchWindow { enabled })
            .await
    }

    pub async fn settings_set_auto_deduplicate(&self, enabled: bool) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetAutoDeduplicate { enabled }).await
    }

    pub async fn settings_set_default_download_dir(&self, dir: Option<String>) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetDefaultDownloadDir { dir }).await
    }

    pub async fn settings_set_wallpaper_rotation_interval_minutes(
        &self,
        minutes: u32,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes })
            .await
    }

    pub async fn settings_set_wallpaper_rotation_mode(&self, mode: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetWallpaperRotationMode { mode }).await
    }

    pub async fn settings_set_current_wallpaper_image_id(
        &self,
        image_id: Option<String>,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsSetCurrentWallpaperImageId { image_id })
            .await
    }

    pub async fn settings_swap_style_transition_for_mode_switch(
        &self,
        old_mode: String,
        new_mode: String,
    ) -> Result<(String, String), String> {
        let v = self
            .request_data(CliIpcRequest::SettingsSwapStyleTransitionForModeSwitch {
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
        let resp = self.request_raw(CliIpcRequest::TaskStart { task }).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.task_id.unwrap_or_default())
    }

    pub async fn task_cancel(&self, task_id: String) -> Result<(), String> {
        self.request_ok(CliIpcRequest::TaskCancel { task_id }).await
    }

    pub async fn task_retry_failed_image(&self, failed_id: i64) -> Result<(), String> {
        self.request_ok(CliIpcRequest::TaskRetryFailedImage { failed_id })
            .await
    }

    /// 获取正在下载的任务列表
    pub async fn get_active_downloads(&self) -> Result<serde_json::Value, String> {
        self.request_data(CliIpcRequest::GetActiveDownloads).await
    }

    pub async fn dedupe_start_gallery_by_hash_batched(
        &self,
        delete_files: bool,
        batch_size: Option<usize>,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::DedupeStartGalleryByHashBatched { delete_files, batch_size })
            .await
    }

    pub async fn dedupe_cancel_gallery_by_hash_batched(&self) -> Result<bool, String> {
        let v = self
            .request_data(CliIpcRequest::DedupeCancelGalleryByHashBatched)
            .await?;
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }

    /// 更新单个设置
    pub async fn settings_update_key(
        &self,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), String> {
        self.request_ok(CliIpcRequest::SettingsUpdateKey { key, value })
            .await
    }

    // ==================== Virtual Drive (Windows only) ====================

        /// 挂载虚拟盘
    pub async fn vd_mount(&self, mount_point: String, no_wait: bool) -> Result<(), String> {
        let resp = self
            .request_raw(CliIpcRequest::VdMount { mount_point, no_wait })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

        /// 卸载虚拟盘
    pub async fn vd_unmount(&self, mount_point: String) -> Result<(), String> {
        let resp = self
            .request_raw(CliIpcRequest::VdUnmount { mount_point })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

        /// 获取虚拟盘状态
    pub async fn vd_status(&self) -> Result<(bool, Option<String>), String> {
        let resp = self.request_raw(CliIpcRequest::VdStatus).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok((resp.mounted.unwrap_or(false), resp.mount_point))
    }

    // ==================== Events ====================

    /// 获取待处理的事件（轮询模式）
    pub async fn get_pending_events(&self, since: Option<u64>) -> Result<Vec<serde_json::Value>, String> {
        let resp = self
            .request_raw(CliIpcRequest::GetPendingEvents { since })
            .await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(resp.events.unwrap_or_default())
    }

    /// 订阅事件（WebSocket 或长轮询）
    pub async fn subscribe_events(&self) -> Result<(), String> {
        let resp = self.request_raw(CliIpcRequest::SubscribeEvents).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }

    /// 取消订阅事件
    pub async fn unsubscribe_events(&self) -> Result<(), String> {
        let resp = self.request_raw(CliIpcRequest::UnsubscribeEvents).await?;
        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "Unknown error".to_string()));
        }
        Ok(())
    }
}

impl Default for IpcClient {
    fn default() -> Self {
        Self::new()
    }
}
