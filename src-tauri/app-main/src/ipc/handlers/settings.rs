//! Settings 相关 IPC 处理

use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::{driver_service::VirtualDriveServiceTrait, VirtualDriveService};

/// 处理所有 Settings 相关的 IPC 请求
pub async fn handle_settings_request(req: &CliIpcRequest) -> Option<CliIpcResponse> {
    match req {
        // 扈・ｲ貞ｺｦ Getter
        CliIpcRequest::SettingsGetAutoLaunch => Some(get_auto_launch()),
        CliIpcRequest::SettingsGetMaxConcurrentDownloads => {
            Some(get_max_concurrent_downloads())
        }
        CliIpcRequest::SettingsGetMaxConcurrentTasks => Some(get_max_concurrent_tasks()),
        CliIpcRequest::SettingsGetNetworkRetryCount => Some(get_network_retry_count()),
        CliIpcRequest::SettingsGetImageClickAction => Some(get_image_click_action()),
        CliIpcRequest::SettingsGetGalleryImageAspectRatio => {
            Some(get_gallery_image_aspect_ratio())
        }
        CliIpcRequest::SettingsGetAutoDeduplicate => Some(get_auto_deduplicate()),
        CliIpcRequest::SettingsGetDefaultDownloadDir => Some(get_default_download_dir()),
        CliIpcRequest::SettingsGetWallpaperEngineDir => Some(get_wallpaper_engine_dir()),
        CliIpcRequest::SettingsGetWallpaperRotationEnabled => {
            Some(get_wallpaper_rotation_enabled())
        }
        CliIpcRequest::SettingsGetWallpaperRotationAlbumId => {
            Some(get_wallpaper_rotation_album_id())
        }
        CliIpcRequest::SettingsGetWallpaperRotationIncludeSubalbums => {
            Some(get_wallpaper_rotation_include_subalbums())
        }
        CliIpcRequest::SettingsGetWallpaperRotationIntervalMinutes => {
            Some(get_wallpaper_rotation_interval_minutes())
        }
        CliIpcRequest::SettingsGetWallpaperRotationMode => {
            Some(get_wallpaper_rotation_mode())
        }
        CliIpcRequest::SettingsGetWallpaperStyle => Some(get_wallpaper_rotation_style()),
        CliIpcRequest::SettingsGetWallpaperRotationTransition => {
            Some(get_wallpaper_rotation_transition())
        }
        CliIpcRequest::SettingsGetWallpaperStyleByMode => Some(get_wallpaper_style_by_mode()),
        CliIpcRequest::SettingsGetWallpaperTransitionByMode => {
            Some(get_wallpaper_transition_by_mode())
        }
        CliIpcRequest::SettingsGetWallpaperMode => Some(get_wallpaper_mode()),
        CliIpcRequest::SettingsGetWallpaperVolume => Some(get_wallpaper_volume()),
        CliIpcRequest::SettingsGetWallpaperVideoPlaybackRate => {
            Some(get_wallpaper_video_playback_rate())
        }
        CliIpcRequest::SettingsGetWindowState => Some(get_window_state()),
        CliIpcRequest::SettingsGetCurrentWallpaperImageId => {
            Some(get_current_wallpaper_image_id())
        }
        CliIpcRequest::SettingsGetDefaultImagesDir => Some(get_default_images_dir()),
        #[cfg(kabegame_mode = "standard")]
        CliIpcRequest::SettingsGetAlbumDriveEnabled => Some(get_album_drive_enabled()),
        #[cfg(kabegame_mode = "standard")]
        CliIpcRequest::SettingsGetAlbumDriveMountPoint => Some(get_album_drive_mount_point()),

        CliIpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio } => {
            Some(set_gallery_image_aspect_ratio(aspect_ratio.clone()))
        }
        CliIpcRequest::SettingsSetWallpaperEngineDir { dir } => {
            Some(set_wallpaper_engine_dir(dir.clone()))
        }
        CliIpcRequest::SettingsGetWallpaperEngineMyprojectsDir => {
            Some(get_wallpaper_engine_myprojects_dir())
        }
        CliIpcRequest::SettingsSetWallpaperRotationEnabled { enabled } => {
            Some(set_wallpaper_rotation_enabled(*enabled))
        }
        CliIpcRequest::SettingsSetWallpaperRotationAlbumId { album_id } => {
            Some(set_wallpaper_rotation_album_id(album_id.clone()))
        }
        CliIpcRequest::SettingsSetWallpaperRotationIncludeSubalbums { include_subalbums } => {
            Some(set_wallpaper_rotation_include_subalbums(*include_subalbums))
        }
        CliIpcRequest::SettingsSetWallpaperRotationTransition { transition } => {
            Some(set_wallpaper_rotation_transition(transition.clone()))
        }
        CliIpcRequest::SettingsSetWallpaperStyle { style } => {
            Some(set_wallpaper_style(style.clone()))
        }
        CliIpcRequest::SettingsSetWallpaperMode { mode } => {
            Some(set_wallpaper_mode(mode.clone()))
        }
        #[cfg(kabegame_mode = "standard")]
        CliIpcRequest::SettingsSetAlbumDriveEnabled { enabled } => {
            Some(set_album_drive_enabled(*enabled).await)
        }
        #[cfg(kabegame_mode = "standard")]
        CliIpcRequest::SettingsSetAlbumDriveMountPoint { mount_point } => {
            Some(set_album_drive_mount_point(mount_point.clone()))
        }

        CliIpcRequest::SettingsSetAutoLaunch { enabled } => Some(set_auto_launch(*enabled)),
        CliIpcRequest::SettingsSetMaxConcurrentDownloads { count } => {
            Some(set_max_concurrent_downloads(*count).await)
        }
        CliIpcRequest::SettingsSetMaxConcurrentTasks { count } => {
            Some(set_max_concurrent_tasks(*count))
        }
        CliIpcRequest::SettingsSetNetworkRetryCount { count } => {
            Some(set_network_retry_count(*count))
        }
        CliIpcRequest::SettingsSetImageClickAction { action } => {
            Some(set_image_click_action(action.clone()))
        }
        CliIpcRequest::SettingsSetAutoDeduplicate { enabled } => {
            Some(set_auto_deduplicate(*enabled))
        }
        CliIpcRequest::SettingsSetDefaultDownloadDir { dir } => {
            Some(set_default_download_dir(dir.clone()))
        }
        CliIpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes } => {
            Some(set_wallpaper_rotation_interval_minutes(*minutes))
        }
        CliIpcRequest::SettingsSetWallpaperRotationMode { mode } => {
            Some(set_wallpaper_rotation_mode(mode.clone()))
        }
        CliIpcRequest::SettingsSetCurrentWallpaperImageId { image_id } => {
            Some(set_current_wallpaper_image_id(image_id.clone()))
        }
        CliIpcRequest::SettingsSwapStyleTransitionForModeSwitch { old_mode, new_mode } => {
            Some(swap_style_transition_for_mode_switch(old_mode.clone(), new_mode.clone()))
        }
        _ => None,
    }
}

fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> CliIpcResponse {
    match Settings::global().set_gallery_image_aspect_ratio(aspect_ratio) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_engine_dir(dir: Option<String>) -> CliIpcResponse {
    match Settings::global().set_wallpaper_engine_dir(dir) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn get_wallpaper_engine_myprojects_dir() -> CliIpcResponse {
    match Settings::global().get_wallpaper_engine_myprojects_dir() {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_enabled(enabled: bool) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_enabled(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_album_id(album_id: Option<String>) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_album_id(album_id) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_include_subalbums(include_subalbums: bool) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_include_subalbums(include_subalbums) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_transition(transition: String) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_transition(transition) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_style(style: String) -> CliIpcResponse {
    match Settings::global().set_wallpaper_style(style) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_mode(mode: String) -> CliIpcResponse {
    match Settings::global().set_wallpaper_mode(mode) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

#[cfg(kabegame_mode = "standard")]
async fn set_album_drive_enabled(enabled: bool) -> CliIpcResponse {
    let settings = Settings::global();

    if enabled {
        // 启用：先挂载虚拟盘
        let mount_point = settings.get_album_drive_mount_point();

        if mount_point.is_empty() {
            return CliIpcResponse::err("Mount point is empty".to_string());
        }

        let vd_service = VirtualDriveService::global().clone();

        // 检查是否已挂载（幂等处理）
        if vd_service.current_mount_point().is_some() {
            // 已挂载，直接更新设置
            match settings.set_album_drive_enabled(true) {
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
                match settings.set_album_drive_enabled(true) {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Err(e) => CliIpcResponse::err(format!("Failed to mount: {}", e)),
        }
    } else {
        // 禁用：先卸载虚拟盘
        let vd_service = VirtualDriveService::global().clone();

        // 检查是否已卸载（幂等处理）
        if vd_service.current_mount_point().is_none() {
            // 已卸载，直接更新设置
            match settings.set_album_drive_enabled(false) {
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
                match settings.set_album_drive_enabled(false) {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Ok(false) => {
                // 卸载失败但可能已经卸载，直接更新设置（幂等）
                match settings.set_album_drive_enabled(false) {
                    Ok(()) => CliIpcResponse::ok("updated"),
                    Err(e) => CliIpcResponse::err(e),
                }
            }
            Err(e) => CliIpcResponse::err(format!("Failed to unmount: {}", e)),
        }
    }
}

#[cfg(kabegame_mode = "standard")]
fn set_album_drive_mount_point(mount_point: String) -> CliIpcResponse {
    match Settings::global().set_album_drive_mount_point(mount_point) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_auto_launch(enabled: bool) -> CliIpcResponse {
    match Settings::global().set_auto_launch(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn set_max_concurrent_downloads(count: u32) -> CliIpcResponse {
    match Settings::global().set_max_concurrent_downloads(count) {
        Ok(()) => {
            TaskScheduler::global().set_download_concurrency().await;
            CliIpcResponse::ok("updated")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_max_concurrent_tasks(count: u32) -> CliIpcResponse {
    match Settings::global().set_max_concurrent_tasks(count) {
        Ok(()) => {
            TaskScheduler::global().set_task_concurrency();
            CliIpcResponse::ok("updated")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_network_retry_count(count: u32) -> CliIpcResponse {
    match Settings::global().set_network_retry_count(count) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_image_click_action(action: String) -> CliIpcResponse {
    match Settings::global().set_image_click_action(action) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_auto_deduplicate(enabled: bool) -> CliIpcResponse {
    match Settings::global().set_auto_deduplicate(enabled) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_default_download_dir(dir: Option<String>) -> CliIpcResponse {
    match Settings::global().set_default_download_dir(dir) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_interval_minutes(minutes) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_mode(mode: String) -> CliIpcResponse {
    match Settings::global().set_wallpaper_rotation_mode(mode) {
        Ok(()) => CliIpcResponse::ok("updated"),
        Err(e) => CliIpcResponse::err(e),
    }
}

fn set_current_wallpaper_image_id(image_id: Option<String>) -> CliIpcResponse {
    match Settings::global().set_current_wallpaper_image_id(image_id.clone()) {
        Ok(()) => {
            if let Some(id) = image_id {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let _ = Storage::global().update_image_last_set_wallpaper_at(&id, now);
                GlobalEmitter::global().emit_images_change("change", &[id], None, None);
            }
            CliIpcResponse::ok("updated")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

fn swap_style_transition_for_mode_switch(old_mode: String, new_mode: String) -> CliIpcResponse {
    match Settings::global().swap_style_transition_for_mode_switch(&old_mode, &new_mode) {
        Ok((style, transition)) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::json!({ "style": style, "transition": transition }),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

// ========== Getter 函数 ==========

fn get_auto_launch() -> CliIpcResponse {
    let v = Settings::global().get_auto_launch();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_max_concurrent_downloads() -> CliIpcResponse {
    let v = Settings::global().get_max_concurrent_downloads();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_max_concurrent_tasks() -> CliIpcResponse {
    let v = Settings::global().get_max_concurrent_tasks();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_network_retry_count() -> CliIpcResponse {
    let v = Settings::global().get_network_retry_count();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_image_click_action() -> CliIpcResponse {
    let v = Settings::global().get_image_click_action();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_gallery_image_aspect_ratio() -> CliIpcResponse {
    let v = Settings::global().get_gallery_image_aspect_ratio();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_auto_deduplicate() -> CliIpcResponse {
    let v = Settings::global().get_auto_deduplicate();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_default_download_dir() -> CliIpcResponse {
    let v = Settings::global().get_default_download_dir();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_engine_dir() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_engine_dir();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_rotation_enabled() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_enabled();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_album_id() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_album_id();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_rotation_include_subalbums() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_include_subalbums();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_interval_minutes() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_interval_minutes();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_mode() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_mode();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_style() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_style();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_transition() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_rotation_transition();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_style_by_mode() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_style_by_mode();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
    )
}

fn get_wallpaper_transition_by_mode() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_transition_by_mode();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
    )
}

fn get_wallpaper_mode() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_mode();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_volume() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_volume();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_video_playback_rate() -> CliIpcResponse {
    let v = Settings::global().get_wallpaper_video_playback_rate();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_window_state() -> CliIpcResponse {
    let v = Settings::global().get_window_state();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_current_wallpaper_image_id() -> CliIpcResponse {
    let v = Settings::global().get_current_wallpaper_image_id();
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_default_images_dir() -> CliIpcResponse {
    let dir = Storage::global().get_images_dir();
    let dir_str = dir
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(dir_str))
}

#[cfg(kabegame_mode = "standard")]
fn get_album_drive_enabled() -> CliIpcResponse {
    let v = Settings::global().get_album_drive_enabled();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}

#[cfg(kabegame_mode = "standard")]
fn get_album_drive_mount_point() -> CliIpcResponse {
    let v = Settings::global().get_album_drive_mount_point();
    CliIpcResponse::ok_with_data("ok", serde_json::json!(v))
}
