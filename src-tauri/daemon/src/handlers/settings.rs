//! Settings 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::EventBroadcaster;
use kabegame_core::ipc::events::DaemonEvent;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::settings::Settings;
use std::sync::Arc;

/// 处理所有 Settings 相关的 IPC 请求
pub async fn handle_settings_request(
    req: &CliIpcRequest,
    settings: Arc<Settings>,
    task_scheduler: Arc<TaskScheduler>,
    broadcaster: Arc<EventBroadcaster>,
) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::SettingsGet => Some(get_settings(settings).await),
        
        CliIpcRequest::SettingsGetKey { key } => {
            Some(get_settings_key(settings, key).await)
        }
        
        CliIpcRequest::SettingsUpdate { settings: new_settings } => {
            Some(update_settings(settings, new_settings).await)
        }
        
        CliIpcRequest::SettingsUpdateKey { key, value } => {
            Some(update_settings_key(settings, key, value).await)
        }

        CliIpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio } => {
            Some(set_gallery_image_aspect_ratio(settings, aspect_ratio.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperEngineDir { dir } => {
            Some(set_wallpaper_engine_dir(settings, dir.clone()).await)
        }
        CliIpcRequest::SettingsGetWallpaperEngineMyprojectsDir => {
            Some(get_wallpaper_engine_myprojects_dir(settings).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationEnabled { enabled } => {
            Some(set_wallpaper_rotation_enabled(settings, *enabled).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationAlbumId { album_id } => {
            Some(set_wallpaper_rotation_album_id(settings, album_id.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationTransition { transition } => {
            Some(set_wallpaper_rotation_transition(settings, transition.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperStyle { style } => {
            Some(set_wallpaper_style(settings, style.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperMode { mode } => {
            Some(set_wallpaper_mode(settings, mode.clone()).await)
        }
        #[cfg(feature = "virtual-drive")]
        CliIpcRequest::SettingsSetAlbumDriveEnabled { enabled } => {
            Some(set_album_drive_enabled(settings, *enabled).await)
        }
        #[cfg(feature = "virtual-drive")]
        CliIpcRequest::SettingsSetAlbumDriveMountPoint { mount_point } => {
            Some(set_album_drive_mount_point(settings, mount_point.clone()).await)
        }

        CliIpcRequest::SettingsSetAutoLaunch { enabled } => {
            Some(set_auto_launch(settings, *enabled).await)
        }
        CliIpcRequest::SettingsSetMaxConcurrentDownloads { count } => {
            Some(set_max_concurrent_downloads(settings, task_scheduler, *count).await)
        }
        CliIpcRequest::SettingsSetNetworkRetryCount { count } => {
            Some(set_network_retry_count(settings, *count).await)
        }
        CliIpcRequest::SettingsSetImageClickAction { action } => {
            Some(set_image_click_action(settings, action.clone()).await)
        }
        CliIpcRequest::SettingsSetGalleryImageAspectRatioMatchWindow { enabled } => {
            Some(set_gallery_image_aspect_ratio_match_window(settings, *enabled).await)
        }
        CliIpcRequest::SettingsSetAutoDeduplicate { enabled } => {
            Some(set_auto_deduplicate(settings, *enabled).await)
        }
        CliIpcRequest::SettingsSetDefaultDownloadDir { dir } => {
            Some(set_default_download_dir(settings, dir.clone()).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes } => {
            Some(set_wallpaper_rotation_interval_minutes(settings, *minutes).await)
        }
        CliIpcRequest::SettingsSetWallpaperRotationMode { mode } => {
            Some(set_wallpaper_rotation_mode(settings, mode.clone()).await)
        }
        CliIpcRequest::SettingsSetCurrentWallpaperImageId { image_id } => {
            Some(set_current_wallpaper_image_id(settings, image_id.clone()).await)
        }
        CliIpcRequest::SettingsSwapStyleTransitionForModeSwitch { old_mode, new_mode } => {
            Some(swap_style_transition_for_mode_switch(settings, old_mode.clone(), new_mode.clone()).await)
        }
        _ => None,
    }
}

async fn get_settings(settings: Arc<Settings>) -> CliIpcResponse {
    match settings.get_settings() {
        Ok(settings) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(settings).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_settings_key(settings: Arc<Settings>, key: &str) -> CliIpcResponse {
    // Settings 没有 get_setting 方法，需要先获取所有设置再提取
    match settings.get_settings() {
        Ok(s) => {
            let value = serde_json::to_value(&s)
                .ok()
                .and_then(|v| v.get(key).cloned())
                .unwrap_or(serde_json::Value::Null);
            CliIpcResponse::ok_with_data("ok", value)
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn update_settings(
    settings: Arc<Settings>,
    new_settings: &serde_json::Value,
) -> CliIpcResponse {
    match serde_json::from_value::<kabegame_core::settings::AppSettings>(new_settings.clone()) {
        Ok(new_settings) => match settings.save_settings(&new_settings) {
            Ok(()) => CliIpcResponse::ok("updated"),
            Err(e) => CliIpcResponse::err(e),
        },
        Err(e) => CliIpcResponse::err(format!("Invalid settings data: {}", e)),
    }
}

async fn update_settings_key(
    settings: Arc<Settings>,
    key: &str,
    value: &serde_json::Value,
) -> CliIpcResponse {
    // Settings 没有 set_setting 方法，需要先获取、修改、再保存
    match settings.get_settings() {
        Ok(s) => {
            // 使用反射或者直接修改 serde_json::Value
            let mut s_value = match serde_json::to_value(&s) {
                Ok(v) => v,
                Err(e) => return CliIpcResponse::err(format!("Serialize failed: {}", e)),
            };
            if let Some(obj) = s_value.as_object_mut() {
                obj.insert(key.to_string(), value.clone());
            }
            match serde_json::from_value::<kabegame_core::settings::AppSettings>(s_value) {
                Ok(new_s) => match settings.save_settings(&new_s) {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(e),
                },
                Err(e) => CliIpcResponse::err(format!("Deserialize failed: {}", e)),
            }
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_gallery_image_aspect_ratio(
    settings: Arc<Settings>,
    aspect_ratio: Option<String>,
) -> CliIpcResponse {
    match settings.set_gallery_image_aspect_ratio(aspect_ratio) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_engine_dir(settings: Arc<Settings>, dir: Option<String>) -> CliIpcResponse {
    match settings.set_wallpaper_engine_dir(dir) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_wallpaper_engine_myprojects_dir(settings: Arc<Settings>) -> CliIpcResponse {
    match settings.get_wallpaper_engine_myprojects_dir() {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_enabled(settings: Arc<Settings>, enabled: bool) -> CliIpcResponse {
    match settings.set_wallpaper_rotation_enabled(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_album_id(settings: Arc<Settings>, album_id: Option<String>) -> CliIpcResponse {
    match settings.set_wallpaper_rotation_album_id(album_id) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_transition(settings: Arc<Settings>, transition: String) -> CliIpcResponse {
    match settings.set_wallpaper_rotation_transition(transition) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_style(settings: Arc<Settings>, style: String) -> CliIpcResponse {
    match settings.set_wallpaper_style(style) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_mode(settings: Arc<Settings>, mode: String) -> CliIpcResponse {
    match settings.set_wallpaper_mode(mode) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

#[cfg(feature = "virtual-drive")]
async fn set_album_drive_enabled(settings: Arc<Settings>, enabled: bool) -> CliIpcResponse {
    match settings.set_album_drive_enabled(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

#[cfg(feature = "virtual-drive")]
async fn set_album_drive_mount_point(settings: Arc<Settings>, mount_point: String) -> CliIpcResponse {
    match settings.set_album_drive_mount_point(mount_point) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_auto_launch(settings: Arc<Settings>, enabled: bool) -> CliIpcResponse {
    match settings.set_auto_launch(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_max_concurrent_downloads(
    settings: Arc<Settings>,
    task_scheduler: Arc<TaskScheduler>,
    count: u32,
) -> CliIpcResponse {
    match settings.set_max_concurrent_downloads(count) {
        Ok(()) => {
            task_scheduler.set_download_concurrency(count);
            CliIpcResponse::ok("updated")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_network_retry_count(settings: Arc<Settings>, count: u32) -> CliIpcResponse {
    match settings.set_network_retry_count(count) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_image_click_action(settings: Arc<Settings>, action: String) -> CliIpcResponse {
    match settings.set_image_click_action(action) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_gallery_image_aspect_ratio_match_window(
    settings: Arc<Settings>,
    enabled: bool,
) -> CliIpcResponse {
    match settings.set_gallery_image_aspect_ratio_match_window(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_auto_deduplicate(settings: Arc<Settings>, enabled: bool) -> CliIpcResponse {
    match settings.set_auto_deduplicate(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_default_download_dir(settings: Arc<Settings>, dir: Option<String>) -> CliIpcResponse {
    match settings.set_default_download_dir(dir) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_interval_minutes(settings: Arc<Settings>, minutes: u32) -> CliIpcResponse {
    match settings.set_wallpaper_rotation_interval_minutes(minutes) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_wallpaper_rotation_mode(settings: Arc<Settings>, mode: String) -> CliIpcResponse {
    match settings.set_wallpaper_rotation_mode(mode) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_current_wallpaper_image_id(settings: Arc<Settings>, image_id: Option<String>) -> CliIpcResponse {
    match settings.set_current_wallpaper_image_id(image_id) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn swap_style_transition_for_mode_switch(
    settings: Arc<Settings>,
    old_mode: String,
    new_mode: String,
) -> CliIpcResponse {
    match settings.swap_style_transition_for_mode_switch(&old_mode, &new_mode) {
        Ok((style, transition)) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::json!({ "style": style, "transition": transition }),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

