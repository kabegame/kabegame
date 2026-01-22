// 设置相关命令

use crate::daemon_client;
#[cfg(feature = "self-hosted")]
use crate::storage::Storage;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

// 注意：get_settings 和 get_setting 已废弃，前端应使用细粒度 getter
// 保留这些函数以向后兼容，但返回错误提示
#[tauri::command]
pub async fn get_settings() -> Result<serde_json::Value, String> {
    Err("get_settings is deprecated. Use individual getter commands instead.".to_string())
}

#[tauri::command]
pub async fn get_setting(_key: String) -> Result<serde_json::Value, String> {
    Err("get_setting is deprecated. Use individual getter commands instead.".to_string())
}

// 添加细粒度 getter commands
#[tauri::command]
pub async fn get_auto_launch() -> Result<bool, String> {
    daemon_client::get_ipc_client()
        .settings_get_auto_launch()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_max_concurrent_downloads() -> Result<u32, String> {
    daemon_client::get_ipc_client()
        .settings_get_max_concurrent_downloads()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_network_retry_count() -> Result<u32, String> {
    daemon_client::get_ipc_client()
        .settings_get_network_retry_count()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_image_click_action() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_image_click_action()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_gallery_image_aspect_ratio() -> Result<Option<String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_gallery_image_aspect_ratio()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_auto_deduplicate() -> Result<bool, String> {
    daemon_client::get_ipc_client()
        .settings_get_auto_deduplicate()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_default_download_dir() -> Result<Option<String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_default_download_dir()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_engine_dir() -> Result<Option<String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_engine_dir()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_enabled() -> Result<bool, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_enabled()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_album_id() -> Result<Option<String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_album_id()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_interval_minutes() -> Result<u32, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_interval_minutes()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_mode() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_mode()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_style() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_style()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_rotation_transition() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_rotation_transition()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_style_by_mode(
) -> Result<std::collections::HashMap<String, String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_style_by_mode()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_transition_by_mode(
) -> Result<std::collections::HashMap<String, String>, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_transition_by_mode()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_mode() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_wallpaper_mode()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_window_state() -> Result<Option<serde_json::Value>, String> {
    let window_state = daemon_client::get_ipc_client()
        .settings_get_window_state()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let v = match serde_json::to_value(window_state) {
        Ok(v) => v,
        Err(e) => return Err(format!("Failed to parse response: {}", e)),
    };
    if v.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(v).map_err(|e| format!("Failed to parse response: {}", e))
    }
}

#[cfg(feature = "virtual-driver")]
#[tauri::command]
pub async fn get_album_drive_enabled() -> Result<bool, String> {
    daemon_client::get_ipc_client()
        .settings_get_album_drive_enabled()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[cfg(feature = "virtual-driver")]
#[tauri::command]
pub async fn get_album_drive_mount_point() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_album_drive_mount_point()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub fn get_favorite_album_id() -> Result<String, String> {
    Ok("00000000-0000-0000-0000-000000000001".to_string())
}

#[tauri::command]
#[cfg(feature = "virtual-driver")]
pub async fn set_album_drive_enabled(enabled: bool) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_album_drive_enabled(enabled)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(feature = "virtual-driver")]
pub async fn set_album_drive_mount_point(mount_point: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_album_drive_mount_point(mount_point)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_auto_launch(enabled: bool) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_auto_launch(enabled)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_max_concurrent_downloads(count: u32) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_max_concurrent_downloads(count)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_network_retry_count(count: u32) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_network_retry_count(count)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_image_click_action(action: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_image_click_action(action)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_gallery_image_aspect_ratio(aspect_ratio)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
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
    daemon_client::get_ipc_client()
        .settings_set_auto_deduplicate(enabled)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_default_download_dir(dir)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn set_wallpaper_engine_dir(dir: Option<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_wallpaper_engine_dir(dir)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_wallpaper_engine_myprojects_dir() -> Result<Option<String>, String> {
    let v = daemon_client::get_ipc_client()
        .settings_get_wallpaper_engine_myprojects_dir()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    serde_json::from_value(v).map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn get_default_images_dir() -> Result<String, String> {
    daemon_client::get_ipc_client()
        .settings_get_default_images_dir()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 打开 Plasma 壁纸配置面板
#[tauri::command]
#[cfg(all(target_os = "linux", desktop = "plasma"))]
pub async fn open_plasma_wallpaper_settings() -> Result<(), String> {
    use std::process::{Command, Stdio};

    // 直接打开 systemsettings5/systemsettings6
    // 用户可以在快速设置中配置壁纸
    for cmd in ["systemsettings6", "systemsettings5", "systemsettings"] {
        match Command::new(cmd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                // 成功启动，不等待进程结束（在后台运行）
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(_) => continue,
        }
    }

    Err("无法打开 Plasma 配置面板。请确保已安装 systemsettings5 或 systemsettings6。\n提示：您也可以右键桌面选择\"配置桌面和壁纸\"来打开壁纸设置。".to_string())
}

#[tauri::command]
#[cfg(not(all(target_os = "linux", desktop = "plasma")))]
pub async fn open_plasma_wallpaper_settings() -> Result<(), String> {
    Err("此功能仅在 Plasma 桌面环境下可用".to_string())
}
