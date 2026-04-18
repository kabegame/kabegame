// Settings related commands

use kabegame_core::settings::Settings;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

// fields' getter commands
#[tauri::command]
pub fn get_auto_launch() -> bool {
    Settings::global().get_auto_launch()
}

#[tauri::command]
pub fn get_auto_open_crawler_webview() -> bool {
    Settings::global().get_auto_open_crawler_webview()
}

#[tauri::command]
pub fn get_import_recommended_schedule_enabled() -> bool {
    Settings::global().get_import_recommended_schedule_enabled()
}

#[tauri::command]
pub fn set_import_recommended_schedule_enabled(enabled: bool) -> Result<(), String> {
    Settings::global().set_import_recommended_schedule_enabled(enabled)
}

#[tauri::command]
pub fn get_max_concurrent_downloads() -> u32 {
    Settings::global().get_max_concurrent_downloads()
}

#[tauri::command]
pub fn get_max_concurrent_tasks() -> u32 {
    Settings::global().get_max_concurrent_tasks()
}

#[tauri::command]
pub fn get_network_retry_count() -> u32 {
    Settings::global().get_network_retry_count()
}

#[tauri::command]
pub fn get_download_interval_ms() -> u32 {
    Settings::global().get_download_interval_ms()
}

#[tauri::command]
pub fn get_image_click_action() -> String {
    Settings::global().get_image_click_action()
}

#[tauri::command]
pub fn get_gallery_image_aspect_ratio() -> Option<String> {
    Settings::global().get_gallery_image_aspect_ratio()
}

#[tauri::command]
pub fn get_gallery_image_object_position() -> String {
    Settings::global().get_gallery_image_object_position()
}

#[tauri::command]
pub fn get_gallery_grid_columns() -> u32 {
    Settings::global().get_gallery_grid_columns()
}

#[tauri::command]
pub fn get_gallery_page_size() -> u32 {
    Settings::global().get_gallery_page_size()
}

#[tauri::command]
pub fn get_auto_deduplicate() -> bool {
    Settings::global().get_auto_deduplicate()
}

#[tauri::command]
pub fn get_default_download_dir() -> Option<String> {
    Settings::global().get_default_download_dir()
}

#[tauri::command]
pub fn get_language() -> Option<String> {
    Settings::global().get_language()
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn get_wallpaper_engine_dir() -> Option<String> {
    Settings::global().get_wallpaper_engine_dir()
}

#[tauri::command]
pub fn get_wallpaper_rotation_enabled() -> bool {
    Settings::global().get_wallpaper_rotation_enabled()
}

#[tauri::command]
pub fn get_wallpaper_rotation_album_id() -> Option<String> {
    Settings::global().get_wallpaper_rotation_album_id()
}

#[tauri::command]
pub fn get_wallpaper_rotation_include_subalbums() -> bool {
    Settings::global().get_wallpaper_rotation_include_subalbums()
}

#[tauri::command]
pub fn get_wallpaper_rotation_interval_minutes() -> u32 {
    Settings::global().get_wallpaper_rotation_interval_minutes()
}

#[tauri::command]
pub fn get_wallpaper_rotation_mode() -> String {
    Settings::global().get_wallpaper_rotation_mode()
}

#[tauri::command]
pub fn get_wallpaper_rotation_style() -> String {
    Settings::global().get_wallpaper_rotation_style()
}

#[tauri::command]
pub fn get_wallpaper_volume() -> f64 {
    Settings::global().get_wallpaper_volume()
}

#[tauri::command]
pub fn set_wallpaper_volume(volume: f64) -> Result<(), String> {
    Settings::global().set_wallpaper_volume(volume)
}

#[tauri::command]
pub fn get_wallpaper_video_playback_rate() -> f64 {
    Settings::global().get_wallpaper_video_playback_rate()
}

#[tauri::command]
pub fn set_wallpaper_video_playback_rate(rate: f64) -> Result<(), String> {
    Settings::global().set_wallpaper_video_playback_rate(rate)
}

#[tauri::command]
pub fn get_wallpaper_rotation_transition() -> String {
    Settings::global().get_wallpaper_rotation_transition()
}

#[tauri::command]
pub fn get_wallpaper_style_by_mode() -> std::collections::HashMap<String, String> {
    Settings::global().get_wallpaper_style_by_mode()
}

#[tauri::command]
pub fn get_wallpaper_transition_by_mode() -> std::collections::HashMap<String, String> {
    Settings::global().get_wallpaper_transition_by_mode()
}

#[tauri::command]
pub fn get_wallpaper_mode() -> String {
    Settings::global().get_wallpaper_mode()
}

#[tauri::command]
pub fn get_window_state() -> Option<serde_json::Value> {
    let window_state = Settings::global().get_window_state();
    serde_json::to_value(window_state).ok()
}

#[cfg(kabegame_mode = "standard")]
#[tauri::command]
pub fn get_album_drive_enabled() -> bool {
    Settings::global().get_album_drive_enabled()
}

#[cfg(kabegame_mode = "standard")]
#[tauri::command]
pub fn get_album_drive_mount_point() -> String {
    Settings::global().get_album_drive_mount_point()
}

#[tauri::command]
pub fn get_favorite_album_id() -> Result<String, String> {
    Ok("00000000-0000-0000-0000-000000000001".to_string())
}

#[tauri::command]
#[cfg(kabegame_mode = "standard")]
pub async fn set_album_drive_enabled(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();

    if enabled {
        // 启用：先挂载虚拟盘
        let mount_point = settings.get_album_drive_mount_point();
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

    settings.set_album_drive_enabled(enabled)
}

#[tauri::command]
#[cfg(kabegame_mode = "standard")]
pub fn set_album_drive_mount_point(mount_point: String) -> Result<(), String> {
    Settings::global().set_album_drive_mount_point(mount_point)
}

#[tauri::command]
pub fn set_language(language: Option<String>) -> Result<(), String> {
    Settings::global().set_language(language.clone())?;
    kabegame_i18n::sync_locale(language.as_deref());
    Ok(())
}

#[tauri::command]
pub fn set_auto_launch(enabled: bool) -> Result<(), String> {
    Settings::global().set_auto_launch(enabled)
}

#[tauri::command]
pub fn set_auto_open_crawler_webview(enabled: bool) -> Result<(), String> {
    Settings::global().set_auto_open_crawler_webview(enabled)
}

#[tauri::command]
pub async fn set_max_concurrent_downloads(count: u32) -> Result<(), String> {
    Settings::global().set_max_concurrent_downloads(count)?;

    // 同时更新运行时调度器配置
    kabegame_core::crawler::TaskScheduler::global()
        .set_download_concurrency()
        .await;
    Ok(())
}

#[tauri::command]
pub fn set_max_concurrent_tasks(count: u32) -> Result<(), String> {
    Settings::global().set_max_concurrent_tasks(count)?;
    kabegame_core::crawler::TaskScheduler::global().set_task_concurrency();
    Ok(())
}

#[tauri::command]
pub fn set_network_retry_count(count: u32) -> Result<(), String> {
    Settings::global().set_network_retry_count(count)
}

#[tauri::command]
pub fn set_download_interval_ms(interval_ms: u32) -> Result<(), String> {
    Settings::global().set_download_interval_ms(interval_ms)
}

#[tauri::command]
pub fn set_image_click_action(action: String) -> Result<(), String> {
    Settings::global().set_image_click_action(action)
}

#[tauri::command]
pub fn set_gallery_image_aspect_ratio(aspect_ratio: Option<String>) -> Result<(), String> {
    Settings::global().set_gallery_image_aspect_ratio(aspect_ratio)
}

#[tauri::command]
pub fn set_gallery_image_object_position(position: String) -> Result<(), String> {
    Settings::global().set_gallery_image_object_position(position)
}

#[tauri::command]
pub fn set_gallery_grid_columns(columns: u32) -> Result<(), String> {
    Settings::global().set_gallery_grid_columns(columns)
}

#[tauri::command]
pub fn set_gallery_page_size(size: u32) -> Result<(), String> {
    Settings::global().set_gallery_page_size(size)
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
pub fn set_auto_deduplicate(enabled: bool) -> Result<(), String> {
    Settings::global().set_auto_deduplicate(enabled)
}

#[tauri::command]
pub fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    Settings::global().set_default_download_dir(dir)
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn set_wallpaper_engine_dir(dir: Option<String>) -> Result<(), String> {
    Settings::global().set_wallpaper_engine_dir(dir)
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn get_wallpaper_engine_myprojects_dir() -> Result<Option<String>, String> {
    Settings::global().get_wallpaper_engine_myprojects_dir()
}

#[tauri::command]
pub fn get_default_images_dir() -> Result<String, String> {
    Ok(kabegame_core::storage::Storage::global()
        .get_images_dir()
        .to_string_lossy()
        .to_string())
}
