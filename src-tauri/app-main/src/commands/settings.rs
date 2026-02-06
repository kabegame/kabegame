// Settings related commands

use kabegame_core::settings::Settings;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
#[tauri::command]
pub async fn get_album_drive_enabled() -> Result<bool, String> {
    Settings::global()
        .get_album_drive_enabled()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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
pub fn get_desktop_resolution(app: tauri::AppHandle) -> Result<(u32, u32), String> {
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
        use tauri::Manager;
        // 获取主窗口，然后获取主显示器
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;
        
        let monitor = window
            .primary_monitor()
            .map_err(|e| format!("获取主显示器失败: {}", e))?
            .ok_or_else(|| "找不到主显示器".to_string())?;
        
        let size = monitor.size();
        Ok((size.width, size.height))
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
