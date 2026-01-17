// 设置相关命令

use crate::daemon_client;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
#[cfg(feature = "self-host")]
use crate::storage::Storage;

#[tauri::command]
pub async fn get_settings() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_setting(key: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .settings_get_key(key)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub fn get_favorite_album_id() -> Result<String, String> {
    Ok("00000000-0000-0000-0000-000000000001".to_string())
}

#[tauri::command]
#[cfg(feature = "virtual-drive")]
pub fn set_album_drive_enabled(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_album_drive_enabled(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
#[cfg(feature = "virtual-drive")]
pub fn set_album_drive_mount_point(mount_point: String) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_album_drive_mount_point(mount_point)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_auto_launch(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_auto_launch(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_max_concurrent_downloads(count: u32) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_max_concurrent_downloads(count)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    Ok(())
}

#[tauri::command]
pub fn set_network_retry_count(count: u32) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_network_retry_count(count)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_image_click_action(action: String) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_image_click_action(action)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_gallery_image_aspect_ratio_match_window(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_gallery_image_aspect_ratio_match_window(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> Result<(), String> {
    tauri::async_runtime::block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_gallery_image_aspect_ratio(aspect_ratio)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
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
pub fn set_auto_deduplicate(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_auto_deduplicate(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_default_download_dir(dir)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn set_wallpaper_engine_dir(dir: Option<String>) -> Result<(), String> {
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_engine_dir(dir)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub fn get_wallpaper_engine_myprojects_dir() -> Result<Option<String>, String> {
    tokio::runtime::Handle::current().block_on(async move {
        let v = daemon_client::get_ipc_client()
            .settings_get_wallpaper_engine_myprojects_dir()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))?;
        serde_json::from_value(v).map_err(|e| format!("Invalid response: {e}"))
    })
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn get_default_images_dir(state: tauri::State<Storage>) -> Result<String, String> {
    Ok(state
        .get_images_dir()
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string())
}
