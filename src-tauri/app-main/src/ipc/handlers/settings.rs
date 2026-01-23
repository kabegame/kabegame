//! Settings 蜻ｽ莉､螟・炊蝎ｨ

use crate::Store;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use std::sync::Arc;

/// 处理所有 Settings 相关的 IPC 请求
pub async fn handle_settings_request(
    req: &CliIpcRequest,
    ctx: Arc<Store>,
) -> Option<CliIpcResponse> {
    match req {
        // 扈・ｲ貞ｺｦ Getter
        CliIpcRequest::SettingsGetAutoLaunch => Some(get_auto_launch().await),
        CliIpcRequest::SettingsGetMaxConcurrentDownloads => {
            Some(get_max_concurrent_downloads().await)
        }
        CliIpcRequest::SettingsGetNetworkRetryCount => Some(get_network_retry_count().await),
        CliIpcRequest::SettingsGetImageClickAction => Some(get_image_click_action().await),
        CliIpcRequest::SettingsGetGalleryImageAspectRatio => {
            Some(get_gallery_image_aspect_ratio().await)
        }
        CliIpcRequest::SettingsGetAutoDeduplicate => Some(get_auto_deduplicate().await),
        CliIpcRequest::SettingsGetDefaultDownloadDir => Some(get_default_download_dir().await),
        CliIpcRequest::SettingsGetWallpaperEngineDir => Some(get_wallpaper_engine_dir().await),
        CliIpcRequest::SettingsGetWallpaperRotationEnabled => {
            Some(get_wallpaper_rotation_enabled().await)
        }
        CliIpcRequest::SettingsGetWallpaperRotationAlbumId => {
            Some(get_wallpaper_rotation_album_id().await)
        }
        CliIpcRequest::SettingsGetWallpaperRotationIntervalMinutes => {
            Some(get_wallpaper_rotation_interval_minutes().await)
        }
        CliIpcRequest::SettingsGetWallpaperRotationMode => {
            Some(get_wallpaper_rotation_mode().await)
        }
        CliIpcRequest::SettingsGetWallpaperRotationStyle => {
            Some(get_wallpaper_rotation_style().await)
        }
        CliIpcRequest::SettingsGetWallpaperRotationTransition => {
            Some(get_wallpaper_rotation_transition().await)
        }
        CliIpcRequest::SettingsGetWallpaperStyleByMode => Some(get_wallpaper_style_by_mode().await),
        CliIpcRequest::SettingsGetWallpaperTransitionByMode => {
            Some(get_wallpaper_transition_by_mode().await)
        }
        CliIpcRequest::SettingsGetWallpaperMode => Some(get_wallpaper_mode().await),
        CliIpcRequest::SettingsGetWindowState => Some(get_window_state().await),
        CliIpcRequest::SettingsGetCurrentWallpaperImageId => {
            Some(get_current_wallpaper_image_id().await)
        }
        CliIpcRequest::SettingsGetDefaultImagesDir => Some(get_default_images_dir().await),
        #[cfg(not(kabegame_mode = "light"))]
        CliIpcRequest::SettingsGetAlbumDriveEnabled => Some(get_album_drive_enabled().await),
        #[cfg(not(kabegame_mode = "light"))]
        CliIpcRequest::SettingsGetAlbumDriveMountPoint => Some(get_album_drive_mount_point().await),

        CliIpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio } => {
            Some(set_gallery_image_aspect_ratio(aspect_ratio.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperEngineDir { dir } => {
            Some(set_wallpaper_engine_dir(dir.clone()).await)
        }
        CliIpcRequest::SettingsGetWallpaperEngineMyprojectsDir => {
            Some(get_wallpaper_engine_myprojects_dir().await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationEnabled { enabled } => {
            Some(set_wallpaper_rotation_enabled(*enabled).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationAlbumId { album_id } => {
            Some(set_wallpaper_rotation_album_id(album_id.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationTransition { transition } => {
            Some(set_wallpaper_rotation_transition(transition.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperStyle { style } => {
            Some(set_wallpaper_style(style.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperMode { mode } => {
            Some(set_wallpaper_mode(mode.clone()).await)
        }
        #[cfg(not(kabegame_mode = "light"))]
        CliIpcRequest::SettingsSetAlbumDriveEnabled { enabled } => {
            Some(set_album_drive_enabled(*enabled, ctx.clone()).await)
        }
        #[cfg(not(kabegame_mode = "light"))]
        CliIpcRequest::SettingsSetAlbumDriveMountPoint { mount_point } => {
            Some(set_album_drive_mount_point(mount_point.clone()).await)
        }

        CliIpcRequest::SettingsSetAutoLaunch { enabled } => Some(set_auto_launch(*enabled).await),
        CliIpcRequest::SettingsSetMaxConcurrentDownloads { count } => {
            Some(set_max_concurrent_downloads(*count).await)
        }
        CliIpcRequest::SettingsSetNetworkRetryCount { count } => {
            Some(set_network_retry_count(*count).await)
        }
        CliIpcRequest::SettingsSetImageClickAction { action } => {
            Some(set_image_click_action(action.clone()).await)
        }
        CliIpcRequest::SettingsSetAutoDeduplicate { enabled } => {
            Some(set_auto_deduplicate(*enabled).await)
        }
        CliIpcRequest::SettingsSetDefaultDownloadDir { dir } => {
            Some(set_default_download_dir(dir.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes } => {
            Some(set_wallpaper_rotation_interval_minutes(*minutes).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationMode { mode } => {
            Some(set_wallpaper_rotation_mode(mode.clone()).await)
        }
        CliIpcRequest::SettingsSetCurrentWallpaperImageId { image_id } => {
            Some(set_current_wallpaper_image_id(image_id.clone()).await)
        }
        CliIpcRequest::SettingsSwapStyleTransitionForModeSwitch { old_mode, new_mode } => {
            Some(swap_style_transition_for_mode_switch(old_mode.clone(), new_mode.clone()).await)
        }
        _ => None,
    }
}

async fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_gallery_image_aspect_ratio(aspect_ratio).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_engine_dir(dir: Option<String>) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_engine_dir(dir).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_engine_myprojects_dir() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_engine_myprojects_dir().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_enabled(enabled: bool) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_rotation_enabled(enabled).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_album_id(album_id: Option<String>) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_rotation_album_id(album_id).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_transition(transition: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_rotation_transition(transition).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_style(style: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_style(style).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_mode(mode: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_mode(mode).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

#[cfg(not(kabegame_mode = "light"))]
async fn set_album_drive_enabled(enabled: bool, ctx: Arc<Store>) -> CliIpcResponse {
    let settings = Settings::global();

    if enabled {
        // 启用：先挂载虚拟盘
        let mount_point = match settings.get_album_drive_mount_point().await {
            Ok(mp) => mp,
            Err(e) => return CliIpcResponse::err(format!("Failed to get mount point: {}", e)),
        };

        if mount_point.is_empty() {
            return CliIpcResponse::err("Mount point is empty".to_string());
        }

        let vd_service = ctx.virtual_drive_service.clone();

        // 检查是否已挂载（幂等处理）
        if vd_service.current_mount_point().is_some() {
            // 已挂载，直接更新设置
            match settings.set_album_drive_enabled(true).await {
                Ok(()) => return CliIpcResponse::ok("updated"),
                Err(e) => return CliIpcResponse::err(e),
            }
        }

        // 执行挂载（使用 spawn_blocking 避免阻塞 tokio worker）
        let mount_result = match tokio::task::spawn_blocking({
            let vd_service = vd_service.clone();
            let mount_point = mount_point.clone();
            move || vd_service.mount(mount_point.as_str())
        })
        .await
        {
            Ok(result) => result,
            Err(e) => return CliIpcResponse::err(format!("Spawn blocking error: {}", e)),
        };

        match mount_result {
            Ok(()) => {
                // 挂载成功后，设置 enabled 为 true
                match settings.set_album_drive_enabled(true).await {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Err(e) => CliIpcResponse::err(format!("Failed to mount: {}", e)),
        }
    } else {
        // 禁用：先卸载虚拟盘
        let vd_service = ctx.virtual_drive_service.clone();

        // 检查是否已卸载（幂等处理）
        if vd_service.current_mount_point().is_none() {
            // 已卸载，直接更新设置
            match settings.set_album_drive_enabled(false).await {
                Ok(()) => return CliIpcResponse::ok("updated"),
                Err(e) => return CliIpcResponse::err(e),
            }
        }

        // 执行卸载（使用 spawn_blocking 避免阻塞 tokio worker）
        let unmount_result = match tokio::task::spawn_blocking({
            let vd_service = vd_service.clone();
            move || vd_service.unmount()
        })
        .await
        {
            Ok(result) => result,
            Err(e) => return CliIpcResponse::err(format!("Spawn blocking error: {}", e)),
        };

        match unmount_result {
            Ok(true) => {
                // 卸载成功后，设置 enabled 为 false
                match settings.set_album_drive_enabled(false).await {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Ok(false) => {
                // 卸载失败但可能已经卸载，直接更新设置（幂等）
                match settings.set_album_drive_enabled(false).await {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(e),
                }
            }
            Err(e) => CliIpcResponse::err(format!("Failed to unmount: {}", e)),
        }
    }
}

#[cfg(not(kabegame_mode = "light"))]
async fn set_album_drive_mount_point(mount_point: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_album_drive_mount_point(mount_point).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_auto_launch(enabled: bool) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_auto_launch(enabled).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_max_concurrent_downloads(count: u32) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_max_concurrent_downloads(count).await {
        Ok(()) => {
            TaskScheduler::global().set_download_concurrency(count);
            CliIpcResponse::ok("updated")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_network_retry_count(count: u32) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_network_retry_count(count).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_image_click_action(action: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_image_click_action(action).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_auto_deduplicate(enabled: bool) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_auto_deduplicate(enabled).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_default_download_dir(dir: Option<String>) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_default_download_dir(dir).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> CliIpcResponse {
    let settings = Settings::global();
    match settings
        .set_wallpaper_rotation_interval_minutes(minutes)
        .await
    {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_mode(mode: String) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_wallpaper_rotation_mode(mode).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_current_wallpaper_image_id(image_id: Option<String>) -> CliIpcResponse {
    let settings = Settings::global();
    match settings.set_current_wallpaper_image_id(image_id).await {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn swap_style_transition_for_mode_switch(
    old_mode: String,
    new_mode: String,
) -> CliIpcResponse {
    let settings = Settings::global();
    match settings
        .swap_style_transition_for_mode_switch(&old_mode, &new_mode)
        .await
    {
        Ok((style, transition)) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::json!({ "style": style, "transition": transition }),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

// ========== Getter 函数 ==========

async fn get_auto_launch() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_auto_launch().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_max_concurrent_downloads() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_max_concurrent_downloads().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_network_retry_count() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_network_retry_count().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_image_click_action() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_image_click_action().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_gallery_image_aspect_ratio() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_gallery_image_aspect_ratio().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_auto_deduplicate() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_auto_deduplicate().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_default_download_dir() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_default_download_dir().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_engine_dir() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_engine_dir().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_enabled() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_enabled().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_album_id() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_album_id().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_interval_minutes() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_interval_minutes().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_mode() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_mode().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_style() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_style().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_rotation_transition() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_rotation_transition().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_style_by_mode() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_style_by_mode().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_transition_by_mode() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_transition_by_mode().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_mode() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_wallpaper_mode().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_window_state() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_window_state().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_current_wallpaper_image_id() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_current_wallpaper_image_id().await {
        Ok(v) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_default_images_dir() -> CliIpcResponse {
    let dir = Storage::global().get_images_dir();
    let dir_str = dir
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(dir_str))
}

#[cfg(not(kabegame_mode = "light"))]
async fn get_album_drive_enabled() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_album_drive_enabled().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

#[cfg(not(kabegame_mode = "light"))]
async fn get_album_drive_mount_point() -> CliIpcResponse {
    let settings = Settings::global();
    match settings.get_album_drive_mount_point().await {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}
