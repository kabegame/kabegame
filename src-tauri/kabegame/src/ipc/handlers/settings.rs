//! Settings 相关 IPC 处理

use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::settings::{Settings, WallpaperTargetConfig};
use kabegame_core::storage::Storage;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::{
    driver_service::VirtualDriveServiceTrait, VirtualDriveService,
};

/// 处理所有 Settings 相关的 IPC 请求
pub async fn handle_settings_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        // 扈・ｲ貞ｺｦ Getter
        IpcRequest::SettingsGetAutoLaunch => Some(get_auto_launch()),
        IpcRequest::SettingsGetMaxConcurrentDownloads => Some(get_max_concurrent_downloads()),
        IpcRequest::SettingsGetMaxConcurrentTasks => Some(get_max_concurrent_tasks()),
        IpcRequest::SettingsGetNetworkRetryCount => Some(get_network_retry_count()),
        IpcRequest::SettingsGetImageClickAction => Some(get_image_click_action()),
        IpcRequest::SettingsGetGalleryImageAspectRatio => Some(get_gallery_image_aspect_ratio()),
        IpcRequest::SettingsGetAutoDeduplicate => Some(get_auto_deduplicate()),
        IpcRequest::SettingsGetDefaultDownloadDir => Some(get_default_download_dir()),
        IpcRequest::SettingsGetWallpaperRotationEnabled => Some(get_wallpaper_rotation_enabled()),
        IpcRequest::SettingsGetWallpaperRotationPath { target } => {
            Some(get_wallpaper_rotation_path(target.as_deref()))
        }
        IpcRequest::SettingsGetWallpaperRotationIntervalMinutes => {
            Some(get_wallpaper_rotation_interval_minutes())
        }
        IpcRequest::SettingsGetWallpaperStyle { target } => {
            Some(get_wallpaper_rotation_style(target.as_deref()))
        }
        IpcRequest::SettingsGetWallpaperRotationTransition { target } => {
            Some(get_wallpaper_rotation_transition(target.as_deref()))
        }
        IpcRequest::SettingsGetWallpaperMode => Some(get_wallpaper_mode()),
        IpcRequest::SettingsGetWallpaperVolume => Some(get_wallpaper_volume()),
        IpcRequest::SettingsGetWallpaperVideoPlaybackRate => {
            Some(get_wallpaper_video_playback_rate())
        }
        IpcRequest::SettingsGetWindowState => Some(get_window_state()),
        IpcRequest::SettingsGetCurrentWallpaperImageId { target } => {
            Some(get_current_wallpaper_image_id(target.as_deref()))
        }
        IpcRequest::SettingsGetDefaultImagesDir => Some(get_default_images_dir()),
        IpcRequest::SettingsGetLanguage => Some(IpcResponse::ok_with_data(
            "ok",
            serde_json::json!(Settings::global().get_resolved_language()),
        )),
        #[cfg(feature = "standard")]
        IpcRequest::SettingsGetAlbumDriveEnabled => Some(get_album_drive_enabled()),
        #[cfg(feature = "standard")]
        IpcRequest::SettingsGetAlbumDriveMountPoint => Some(get_album_drive_mount_point()),

        IpcRequest::SettingsSetGalleryImageAspectRatio { aspect_ratio } => {
            Some(set_gallery_image_aspect_ratio(aspect_ratio.clone()))
        }
        IpcRequest::SettingsSetWallpaperRotationEnabled { enabled } => {
            Some(set_wallpaper_rotation_enabled(*enabled))
        }
        IpcRequest::SettingsSetWallpaperRotationPath { path, target } => {
            Some(set_wallpaper_rotation_path(path.clone(), target.clone()).await)
        }
        IpcRequest::SettingsSetWallpaperRotationTransition { transition, target } => {
            Some(set_wallpaper_rotation_transition(transition.clone(), target.clone()).await)
        }
        IpcRequest::SettingsSetWallpaperStyle { style, target } => {
            Some(set_wallpaper_style(style.clone(), target.clone()).await)
        }
        IpcRequest::SettingsSetWallpaperMode { mode } => Some(set_wallpaper_mode(mode.clone())),
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
            Some(set_max_concurrent_downloads(*count).await)
        }
        IpcRequest::SettingsSetMaxConcurrentTasks { count } => {
            Some(set_max_concurrent_tasks(*count))
        }
        IpcRequest::SettingsSetNetworkRetryCount { count } => Some(set_network_retry_count(*count)),
        IpcRequest::SettingsSetImageClickAction { action } => {
            Some(set_image_click_action(action.clone()))
        }
        IpcRequest::SettingsSetAutoDeduplicate { enabled } => Some(set_auto_deduplicate(*enabled)),
        IpcRequest::SettingsSetDefaultDownloadDir { dir } => {
            Some(set_default_download_dir(dir.clone()))
        }
        IpcRequest::SettingsSetWallpaperRotationIntervalMinutes { minutes } => {
            Some(set_wallpaper_rotation_interval_minutes(*minutes))
        }
        IpcRequest::SettingsSetCurrentWallpaperImageId { image_id, target } => Some(
            set_current_wallpaper_image_id(image_id.clone(), target.as_deref()),
        ),
        _ => None,
    }
}

fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> IpcResponse {
    match Settings::global().set_gallery_image_aspect_ratio(aspect_ratio) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_wallpaper_rotation_enabled(enabled: bool) -> IpcResponse {
    match Settings::global().set_wallpaper_rotation_enabled(enabled) {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

/// 把请求里的可选 `target` 解析成壁纸目标 id：缺省为当前显示器模式的默认目标，指定的目标必须活跃。
/// web 版没有壁纸后端与显示器模式，只有 `multiple` 这一个目标。
fn resolve_wallpaper_target(target: Option<&str>) -> Result<String, String> {
    #[cfg(not(feature = "web"))]
    {
        crate::wallpaper::WallpaperController::global()
            .resolve_target(target)
            .map(|(id, _)| id)
    }
    #[cfg(feature = "web")]
    {
        Ok(target
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or(kabegame_core::settings::TARGET_MULTIPLE)
            .to_string())
    }
}

/// 读-改-写一个壁纸目标的配置。
fn update_wallpaper_target(
    target: Option<&str>,
    f: impl FnOnce(&mut WallpaperTargetConfig),
) -> Result<(), String> {
    let target_id = resolve_wallpaper_target(target)?;
    Settings::global().update_wallpaper_target(&target_id, WallpaperTargetConfig::default, f)
}

/// 壁纸目标的当前配置；目标不活跃时为错误。
fn wallpaper_target_config(target: Option<&str>) -> Result<WallpaperTargetConfig, String> {
    let target_id = resolve_wallpaper_target(target)?;
    Ok(Settings::global()
        .get_wallpaper_target(&target_id)
        .unwrap_or_default())
}

fn updated(res: Result<(), String>) -> IpcResponse {
    match res {
        Ok(()) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

/// 与 Tauri 命令同一实现：校验路径、换路径时立即把该目标设到第 1 张。web 版没有壁纸后端，只写设置。
async fn set_wallpaper_rotation_path(path: Option<String>, target: Option<String>) -> IpcResponse {
    #[cfg(not(feature = "web"))]
    let res =
        crate::commands::wallpaper::set_wallpaper_rotation_path(path.unwrap_or_default(), target)
            .await;
    #[cfg(feature = "web")]
    let res = update_wallpaper_target(target.as_deref(), |config| {
        config.set_rotation_path(
            path.as_deref()
                .and_then(kabegame_core::wallpaper_rotation::normalize_path),
        );
    });
    updated(res)
}

/// 与 Tauri 命令同一实现：按能力校验、写该目标在当前壁纸模式下的过渡。web 版只写设置。
async fn set_wallpaper_rotation_transition(
    transition: String,
    target: Option<String>,
) -> IpcResponse {
    #[cfg(not(feature = "web"))]
    let res =
        crate::commands::wallpaper::set_wallpaper_rotation_transition(transition, target).await;
    #[cfg(feature = "web")]
    let res = update_wallpaper_target(target.as_deref(), |config| {
        config
            .transition
            .insert(Settings::global().get_wallpaper_mode(), transition);
    });
    updated(res)
}

/// 与 Tauri 命令同一实现：按能力校验、写该目标在当前壁纸模式下的样式并重新输出。web 版只写设置。
async fn set_wallpaper_style(style: String, target: Option<String>) -> IpcResponse {
    #[cfg(not(feature = "web"))]
    let res = crate::commands::wallpaper::set_wallpaper_style(style, target).await;
    #[cfg(feature = "web")]
    let res = update_wallpaper_target(target.as_deref(), |config| {
        config
            .style
            .insert(Settings::global().get_wallpaper_mode(), style);
    });
    updated(res)
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

/// 走 core：CLI 自身没有 plugin 运行时，改并发只能由主应用后端应用，
/// 故必须与 Tauri 命令 / web dispatch 共用 `commands::settings` 的实现。
async fn set_max_concurrent_downloads(count: u32) -> IpcResponse {
    match kabegame_core::commands::settings::set_max_concurrent_downloads(count).await {
        Ok(_) => IpcResponse::ok("updated"),
        Err(e) => IpcResponse::err(e),
    }
}

fn set_max_concurrent_tasks(count: u32) -> IpcResponse {
    match kabegame_core::commands::settings::set_max_concurrent_tasks(count) {
        Ok(_) => IpcResponse::ok("updated"),
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

fn set_current_wallpaper_image_id(image_id: Option<String>, target: Option<&str>) -> IpcResponse {
    let written = update_wallpaper_target(target, |config| {
        config.set_current_image_id(image_id.clone())
    });
    match written {
        Ok(()) => {
            if let Some(id) = image_id {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let ids = vec![id];
                if Storage::global()
                    .update_image_last_set_wallpaper_at(&ids[0], now)
                    .is_ok()
                {
                    GlobalEmitter::global()
                        .emit_image_fields(&ids, serde_json::json!({ "lastSetWallpaperAt": now }));
                }
            }
            IpcResponse::ok("updated")
        }
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

fn get_wallpaper_rotation_enabled() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_enabled();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

fn get_wallpaper_rotation_path(target: Option<&str>) -> IpcResponse {
    match wallpaper_target_config(target) {
        Ok(config) => IpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(config.rotation_path).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => IpcResponse::err(e),
    }
}

fn get_wallpaper_rotation_interval_minutes() -> IpcResponse {
    let v = Settings::global().get_wallpaper_rotation_interval_minutes();
    IpcResponse::ok_with_data("ok", serde_json::json!(v))
}

/// 目标在当前壁纸模式下的有效样式（按能力归一化）。web 版没有能力表，读存的值，缺省 `fill`。
fn get_wallpaper_rotation_style(target: Option<&str>) -> IpcResponse {
    let style = wallpaper_target_config(target).map(|config| {
        #[cfg(not(feature = "web"))]
        {
            crate::wallpaper::WallpaperController::global().effective_style(&config)
        }
        #[cfg(feature = "web")]
        {
            config
                .style
                .get(&Settings::global().get_wallpaper_mode())
                .cloned()
                .unwrap_or_else(|| "fill".to_string())
        }
    });
    match style {
        Ok(v) => IpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => IpcResponse::err(e),
    }
}

/// 目标在当前壁纸模式下的有效过渡（按能力归一化）。web 版读存的值，缺省 `none`。
fn get_wallpaper_rotation_transition(target: Option<&str>) -> IpcResponse {
    let transition = wallpaper_target_config(target).map(|config| {
        #[cfg(not(feature = "web"))]
        {
            crate::wallpaper::WallpaperController::global().effective_transition(&config)
        }
        #[cfg(feature = "web")]
        {
            config
                .transition
                .get(&Settings::global().get_wallpaper_mode())
                .cloned()
                .unwrap_or_else(|| "none".to_string())
        }
    });
    match transition {
        Ok(v) => IpcResponse::ok_with_data("ok", serde_json::json!(v)),
        Err(e) => IpcResponse::err(e),
    }
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

fn get_current_wallpaper_image_id(target: Option<&str>) -> IpcResponse {
    match wallpaper_target_config(target) {
        Ok(config) => IpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(config.current_image_id).unwrap_or(serde_json::Value::Null),
        ),
        Err(e) => IpcResponse::err(e),
    }
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
