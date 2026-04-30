//! Settings 相关 IPC 处理

use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::{driver_service::VirtualDriveServiceTrait, VirtualDriveService};

/// 处理所有 Settings 相关的 IPC 请求
pub async fn handle_settings_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        // 扈・ｲ貞ｺｦ Getter
        IpcRequest::SettingsGetAutoLaunch => Some(get_auto_launch()),
        IpcRequest::SettingsGetMaxConcurrentDownloads => {
            Some(get_max_concurrent_downloads())
        }
        IpcRequest::SettingsGetMaxConcurrentTasks => Some(get_max_concurrent_tasks()),
        IpcRequest::SettingsGetNetworkRetryCount => Some(get_network_retry_count()),
        IpcRequest::SettingsGetImageClickAction => Some(get_image_click_action()),
        IpcRequest::SettingsGetGalleryImageAspectRatio => {
            Some(get_gallery_image_aspect_ratio())
        }
        IpcRequest::SettingsGetAutoDeduplicate => Some(get_auto_deduplicate()),
        IpcRequest::SettingsGetDefaultDownloadDir => Some(get_default_download_dir()),
        IpcRequest::SettingsGetWallpaperEngineDir => Some(get_wallpaper_engine_dir()),
        IpcRequest::SettingsGetWallpaperRotationEnabled => {
            Some(get_wallpaper_rotation_enabled())
        }
        IpcRequest::SettingsGetWallpaperRotationAlbumId => {
            Some(get_wallpaper_rotation_album_id())
        }
        IpcRequest::SettingsGetWallpaperRotationIncludeSubalbums => {
            Some(get_wallpaper_rotation_include_subalbums())
        }
        IpcRequest::SettingsGetWallpaperRotationIntervalMinutes => {
            Some(get_wallpaper_rotation_interval_minutes())
        }
        IpcRequest::SettingsGetWallpaperRotationMode => {
            Some(get_wallpaper_rotation_mode())
        }
        IpcRequest::SettingsGetWallpaperStyle => Some(get_wallpaper_rotation_style()),
        IpcRequest::SettingsGetWallpaperRotationTransition => {
            Some(get_wallpaper_rotation_transition())
        }
        IpcRequest::SettingsGetWallpaperStyleByMode => Some(get_wallpaper_style_by_mode()),
        IpcRequest::SettingsGetWallpaperTransitionByMode => {
            Some(get_wallpaper_transition_by_mode())
        }
        IpcRequest::SettingsGetWallpaperMode => Some(get_wallpaper_mode()),
        IpcRequest::SettingsGetWallpaperVolume => Some(get_wallpaper_volume()),
        IpcRequest::SettingsGetWallpaperVideoPlaybackRate => {
            Some(get_wallpaper_video_playback_rate())
        }
        IpcRequest::SettingsGetWindowState => Some(get_window_state()),
        IpcRequest::SettingsGetCurrentWallpaperImageId => {
            Some(get_current_wallpaper_image_id())
        }
        IpcRequest::SettingsGetDefaultImagesDir => Some(get_default_images_dir()),
        #[cfg(feature = "standard")]
        IpcRequest::SettingsGetAlbumDriveEnabled => Some(get_album_drive_enabled()),
        #[cfg(feature = "standard")]
        IpcRequest::SettingsGetAlbumDriveMountPoint => Some(get_album_drive_mount_point()),

        IpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio } => {
            Some(set_gallery_image_aspect_ratio(aspect_ratio.clone()))
        }
        IpcRequest::SettingsSetWallpaperEngineDir { dir } => {
            Some(set_wallpaper_engine_dir(dir.clone()))
        }
        IpcRequest::SettingsGetWallpaperEngineMyprojectsDir => {
            Some(get_wallpaper_engine_myprojects_dir())
        }
        IpcRequest::SettingsSetWallpaperRotationEnabled { enabled } => {
            Some(set_wallpaper_rotation_enabled(*enabled))
        }
        IpcRequest::SettingsSetWallpaperRotationAlbumId { album_id } => {
            Some(set_wallpaper_rotation_album_id(album_id.clone()))
        }
        IpcRequest::SettingsSetWallpaperRotationIncludeSubalbums { include_subalbums } => {
            Some(set_wallpaper_rotation_include_subalbums(*include_subalbums))
        }
        IpcRequest::SettingsSetWallpaperRotationTransition { transition } => {
            Some(set_wallpaper_rotation_transition(transition.clone()))
        }
        IpcRequest::SettingsSetWallpaperStyle { style } => {
            Some(set_wallpaper_style(style.clone()))
        }
        IpcRequest::SettingsSetWallpaperMode { mode } => {
            Some(set_wallpaper_mode(mode.clone()))
        }
        #[cfg(feature = "standard")]
        IpcRequest::SettingsSetAlbumDriveEnabled { enabled } => {
            Some(set_album_drive_enabled(*enabled).await)
        }
        #[cfg(feature = "standard")]
        IpcRequest::SettingsSetAlbumDriveMountPoint { mount_point } => {
            Some(set_album_drive_mount_point(mount_point.clone()))
        }

        IpcRequest::SettingsSetAutoLaunch { enabled } => Some(set_auto_launch(*enabled)),
        IpcRequest::SettingsSetMaxConcurrentDownloads { count } => {
            Some(set_max_concurrent_downloads(*count))
        }
        IpcRequest::SettingsSetMaxConcurrentTasks { count } => {
            Some(set_max_concurrent_tasks(*count))
        }
        IpcRequest::SettingsSetNetworkRetryCount { count } => {
            Some(set_network_retry_count(*count))
        }
        IpcRequest::SettingsSetImageClickAction { action } => {
            Some(set_image_click_action(action.clone()))
        }
        IpcRequest::SettingsSetAutoDeduplicate { enabled } => {
            Some(set_auto_deduplicate(*enabled))
        }
        IpcRequest::SettingsSetDefaultDownloadDir { dir } => {
            Some(set_default_download_dir(dir.clone()))
        }
        IpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes } => {
            Some(set_wallpaper_rotation_interval_minutes(*minutes))
        }
        IpcRequest::SettingsSetWallpaperRotationMode { mode } => {
            Some(set_wallpaper_rotation_mode(mode.clone()))
        }
        IpcRequest::SettingsSetCurrentWallpaperImageId { image_id } => {
            Some(set_current_wallpaper_image_id(image_id.clone()))
        }
        IpcRequest::SettingsSwapStyleTransitionForModeSwitch { old_mode, new_mode } => {
            Some(swap_style_transition_for_mode_switch(old_mode.clone(), new_mode.clone()))
        }
        _ => None,
    }
}

fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> IpcResponse {
    match Settings::global().set_gallery_image_aspect_ratio(aspect_ratio) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_engine_dir(dir: Option<String>) -> IpcResponse {
    match Settings::global().set_wallpaper_engine_dir(dir) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn get_wallpaper_engine_myprojects_dir() -> IpcResponse {
    match Settings::global().get_wallpaper_engine_myprojects_dir() {
        Ok(v) => IpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_enabled(enabled: bool) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_enabled(enabled) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_album_id(album_id: Option<String>) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_album_id(album_id) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_include_subalbums(include_subalbums: bool) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_include_subalbums(include_subalbums) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_transition(transition: String) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_transition(transition) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_style(style: String) -> IpcResponse {
    match Settings::global().set_wallpaper_style(style) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_mode(mode: String) -> IpcResponse {
    match Settings::global().set_wallpaper_mode(mode) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

#[cfg(feature = "standard")]
async fn set_album_drive_enabled(enabled: bool) -> IpcResponse {
    let settings = Settings::global();

    if enabled {
        // 启用：先挂载虚拟盘
        let mount_point = settings.get_album_drive_mount_point();

        if mount_point.is_empty() {
            return IpcResponse::err("Mount point is empty".to_string());
        }

        let vd_service = VirtualDriveService::global().clone();

        // 检查是否已挂载（幂等处理）
        if vd_service.current_mount_point().is_some() {
            // 已挂载，直接更新设置
            match settings.set_album_drive_enabled(true) {
                Ok(()) => return IpcResponse::ok("updated"),
                Err(e) => return IpcResponse::err(e),
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
            Err(e) => return IpcResponse::err(format!("Spawn blocking error: {}", e)),
        };

        match mount_result {
            Ok(()) => {
                // 挂载成功后，设置 enabled 为 true
                match settings.set_album_drive_enabled(true) {
                    Ok(()) => IpcResponse::ok("updated"),
                    Err(e) => IpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Err(e) => IpcResponse::err(format!("Failed to mount: {}", e)),
        }
    } else {
        // 禁用：先卸载虚拟盘
        let vd_service = VirtualDriveService::global().clone();

        // 检查是否已卸载（幂等处理）
        if vd_service.current_mount_point().is_none() {
            // 已卸载，直接更新设置
            match settings.set_album_drive_enabled(false) {
                Ok(()) => return IpcResponse::ok("updated"),
                Err(e) => return IpcResponse::err(e),
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
            Err(e) => return IpcResponse::err(format!("Spawn blocking error: {}", e)),
        };

        match unmount_result {
            Ok(true) => {
                // 卸载成功后，设置 enabled 为 false
                match settings.set_album_drive_enabled(false) {
                    Ok(()) => IpcResponse::ok("updated"),
                    Err(e) => IpcResponse::err(format!("Failed to set enabled: {}", e)),
                }
            }
            Ok(false) => {
                // 卸载失败但可能已经卸载，直接更新设置（幂等）
                match settings.set_album_drive_enabled(false) {
                    Ok(()) => IpcResponse::ok("updated"),
                    Err(e) => IpcResponse::err(e),
                }
            }
            Err(e) => IpcResponse::err(format!("Failed to unmount: {}", e)),
        }
    }
}

#[cfg(feature = "standard")]
fn set_album_drive_mount_point(mount_point: String) -> IpcResponse {
    match Settings::global().set_album_drive_mount_point(mount_point) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_auto_launch(enabled: bool) -> IpcResponse {
    match Settings::global().set_auto_launch(enabled) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_max_concurrent_downloads(count: u32) -> IpcResponse {
    match Settings::global().set_max_concurrent_downloads(count) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_max_concurrent_tasks(count: u32) -> IpcResponse {
    match Settings::global().set_max_concurrent_tasks(count) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_network_retry_count(count: u32) -> IpcResponse {
    match Settings::global().set_network_retry_count(count) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_image_click_action(action: String) -> IpcResponse {
    match Settings::global().set_image_click_action(action) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_auto_deduplicate(enabled: bool) -> IpcResponse {
    match Settings::global().set_auto_deduplicate(enabled) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_default_download_dir(dir: Option<String>) -> IpcResponse {
    match Settings::global().set_default_download_dir(dir) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_interval_minutes(minutes) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_mode(mode: String) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_mode(mode) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_current_wallpaper_image_id(image_id: Option<String>) -> IpcResponse {
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
            IpcResponse::ok("updated")
        }
        Err(e) => IpcResponse::err(e),
    }
}

fn swap_style_transition_for_mode_switch(old_mode: String, new_mode: String) -> IpcResponse {
    match Settings::global().swap_style_transition_for_mode_switch(&old_mode, &new_mode) {
        Ok((style, transition)) => IpcResponse::ok_with_data(
            "ok",
            serde_json::json!({ "style": style, "transition": transition }),
        ),
        Err(e) => IpcResponse::err(e),
    }
}

// ========== Getter 函数 ==========

fn get_auto_launch() -> IpcResponse {
    let v = Settings::global().get_auto_launch();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_max_concurrent_downloads() -> IpcResponse {
    let v = Settings::global().get_max_concurrent_downloads();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_max_concurrent_tasks() -> IpcResponse {
    let v = Settings::global().get_max_concurrent_tasks();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_network_retry_count() -> IpcResponse {
    let v = Settings::global().get_network_retry_count();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_image_click_action() -> IpcResponse {
    let v = Settings::global().get_image_click_action();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_gallery_image_aspect_ratio() -> IpcResponse {
    let v = Settings::global().get_gallery_image_aspect_ratio();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_auto_deduplicate() -> IpcResponse {
    let v = Settings::global().get_auto_deduplicate();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_default_download_dir() -> IpcResponse {
    let v = Settings::global().get_default_download_dir();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_engine_dir() -> IpcResponse {
    let v = Settings::global().get_wallpaper_engine_dir();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_rotation_enabled() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_enabled();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_album_id() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_album_id();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_wallpaper_rotation_include_subalbums() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_include_subalbums();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_interval_minutes() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_interval_minutes();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_mode() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_mode();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_style() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_style();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_transition() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_transition();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_style_by_mode() -> IpcResponse {
    let v = Settings::global().get_wallpaper_style_by_mode();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
    )
}

fn get_wallpaper_transition_by_mode() -> IpcResponse {
    let v = Settings::global().get_wallpaper_transition_by_mode();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
    )
}

fn get_wallpaper_mode() -> IpcResponse {
    let v = Settings::global().get_wallpaper_mode();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_volume() -> IpcResponse {
    let v = Settings::global().get_wallpaper_volume();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_video_playback_rate() -> IpcResponse {
    let v = Settings::global().get_wallpaper_video_playback_rate();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_window_state() -> IpcResponse {
    let v = Settings::global().get_window_state();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_current_wallpaper_image_id() -> IpcResponse {
    let v = Settings::global().get_current_wallpaper_image_id();
    IpcResponse::ok_with_data(
        "ok",
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
    )
}

fn get_default_images_dir() -> IpcResponse {
    let dir = Storage::global().get_images_dir();
    let dir_str = dir
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string();
    IpcResponse::ok_with_data("ok", serde_json::json!(dir_str))
}

#[cfg(feature = "standard")]
fn get_album_drive_enabled() -> IpcResponse {
    let v = Settings::global().get_album_drive_enabled();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

#[cfg(feature = "standard")]
fn get_album_drive_mount_point() -> IpcResponse {
    let v = Settings::global().get_album_drive_mount_point();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}
