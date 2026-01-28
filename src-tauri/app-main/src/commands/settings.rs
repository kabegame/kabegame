// Settings related commands

use kabegame_core::settings::Settings;
#[cfg(not(kabegame_mode = "light"))]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(not(kabegame_mode = "light"))]
use kabegame_core::virtual_driver::VirtualDriveService;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

// fields' getter commands
#[tauri::command]
pub async fn get_auto_launch() -> Result<bool, String> {
    Settings::global()
        .get_auto_launch()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_max_concurrent_downloads() -> Result<u32, String> {
    Settings::global()
        .get_max_concurrent_downloads()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_network_retry_count() -> Result<u32, String> {
    Settings::global()
        .get_network_retry_count()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_image_click_action() -> Result<String, String> {
    Settings::global()
        .get_image_click_action()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gallery_image_aspect_ratio() -> Result<Option<String>, String> {
    Settings::global()
        .get_gallery_image_aspect_ratio()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_auto_deduplicate() -> Result<bool, String> {
    Settings::global()
        .get_auto_deduplicate()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_default_download_dir() -> Result<Option<String>, String> {
    Settings::global()
        .get_default_download_dir()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn get_wallpaper_engine_dir() -> Result<Option<String>, String> {
    Settings::global()
        .get_wallpaper_engine_dir()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_enabled() -> Result<bool, String> {
    Settings::global()
        .get_wallpaper_rotation_enabled()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_album_id() -> Result<Option<String>, String> {
    Settings::global()
        .get_wallpaper_rotation_album_id()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_interval_minutes() -> Result<u32, String> {
    Settings::global()
        .get_wallpaper_rotation_interval_minutes()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_mode() -> Result<String, String> {
    Settings::global()
        .get_wallpaper_rotation_mode()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_style() -> Result<String, String> {
    Settings::global()
        .get_wallpaper_rotation_style()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_rotation_transition() -> Result<String, String> {
    Settings::global()
        .get_wallpaper_rotation_transition()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_style_by_mode(
) -> Result<std::collections::HashMap<String, String>, String> {
    Settings::global()
        .get_wallpaper_style_by_mode()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_transition_by_mode(
) -> Result<std::collections::HashMap<String, String>, String> {
    Settings::global()
        .get_wallpaper_transition_by_mode()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_wallpaper_mode() -> Result<String, String> {
    Settings::global()
        .get_wallpaper_mode()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_window_state() -> Result<Option<serde_json::Value>, String> {
    let window_state = Settings::global()
        .get_window_state()
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(window_state).ok())
}

#[cfg(not(kabegame_mode = "light"))]
#[tauri::command]
pub async fn get_album_drive_enabled() -> Result<bool, String> {
    Settings::global()
        .get_album_drive_enabled()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(kabegame_mode = "light"))]
#[tauri::command]
pub async fn get_album_drive_mount_point() -> Result<String, String> {
    Settings::global()
        .get_album_drive_mount_point()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_favorite_album_id() -> Result<String, String> {
    Ok("00000000-0000-0000-0000-000000000001".to_string())
}

#[tauri::command]
#[cfg(not(kabegame_mode = "light"))]
pub async fn set_album_drive_enabled(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();

    if enabled {
        // 启用：先挂载虚拟盘
        let mount_point = settings
            .get_album_drive_mount_point()
            .await
            .map_err(|e| e.to_string())?;
        println!("mount point: {}", mount_point);
        let vd_service = VirtualDriveService::global();
        let mount_result = tokio::task::spawn_blocking({
            let mount_point = mount_point.clone();
            move || vd_service.mount(mount_point.as_str())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
        println!("mount over {:?}", mount_result);
        if let Err(e) = mount_result {
            return Err(e);
        }
    } else {
        // 禁用：先卸载虚拟盘
        let vd_service = VirtualDriveService::global();
        let unmount_result = tokio::task::spawn_blocking(move || vd_service.unmount())
            .await
            .map_err(|e| format!("Task join error: {}", e))?;

        if let Err(e) = unmount_result {
            return Err(e);
        }
    }

    settings
        .set_album_drive_enabled(enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(kabegame_mode = "light"))]
pub async fn set_album_drive_mount_point(mount_point: String) -> Result<(), String> {
    Settings::global()
        .set_album_drive_mount_point(mount_point)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_auto_launch(enabled: bool) -> Result<(), String> {
    Settings::global()
        .set_auto_launch(enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_max_concurrent_downloads(count: u32) -> Result<(), String> {
    Settings::global()
        .set_max_concurrent_downloads(count)
        .await
        .map_err(|e| e.to_string())?;

    // 同时更新运行时调度器配置
    kabegame_core::crawler::TaskScheduler::global().set_download_concurrency(count);
    Ok(())
}

#[tauri::command]
pub async fn set_network_retry_count(count: u32) -> Result<(), String> {
    Settings::global()
        .set_network_retry_count(count)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_image_click_action(action: String) -> Result<(), String> {
    Settings::global()
        .set_image_click_action(action)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> Result<(), String> {
    Settings::global()
        .set_gallery_image_aspect_ratio(aspect_ratio)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_desktop_resolution() -> Result<(u32, u32), String> {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let width = GetSystemMetrics(0) as u32; // SM_CXSCREEN
            let height = GetSystemMetrics(1) as u32; // SM_CYSCREEN
            Ok((width, height))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok((1920, 1080))
    }
}

#[tauri::command]
pub async fn set_auto_deduplicate(enabled: bool) -> Result<(), String> {
    Settings::global()
        .set_auto_deduplicate(enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    Settings::global()
        .set_default_download_dir(dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn set_wallpaper_engine_dir(dir: Option<String>) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_engine_dir(dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn get_wallpaper_engine_myprojects_dir() -> Result<Option<String>, String> {
    Settings::global()
        .get_wallpaper_engine_myprojects_dir()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_default_images_dir() -> Result<String, String> {
    Ok(kabegame_core::storage::Storage::global()
        .get_images_dir()
        .to_string_lossy()
        .to_string())
}
