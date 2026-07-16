// Settings related commands

#[cfg(all(feature = "standard", target_os = "windows"))]
use kabegame_core::app_paths::AppPaths;
use kabegame_core::settings::Settings;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
#[cfg(feature = "standard")]
use std::path::Path;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

// fields' getter commands
#[tauri::command]
pub fn get_settings(keys: Vec<String>) -> Result<serde_json::Value, String> {
    let snapshot = Settings::global().get_all_settings_json()?;
    let mut filtered = serde_json::Map::new();

    if let Some(map) = snapshot.as_object() {
        for key in keys {
            if let Some(value) = map.get(&key) {
                filtered.insert(key, value.clone());
            }
        }
    }

    Ok(serde_json::Value::Object(filtered))
}

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
pub fn get_auto_deduplicate() -> bool {
    Settings::global().get_auto_deduplicate()
}

#[tauri::command]
pub fn get_realtime_folder_sync() -> bool {
    Settings::global().get_realtime_folder_sync()
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

#[cfg(feature = "standard")]
#[tauri::command]
pub fn get_album_drive_enabled() -> bool {
    Settings::global().get_album_drive_enabled()
}

#[cfg(feature = "standard")]
#[tauri::command]
pub fn get_album_drive_mount_point() -> String {
    Settings::global().get_album_drive_mount_point()
}

#[cfg(feature = "standard")]
#[tauri::command]
pub fn get_album_drive_driver_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        let windir = Path::new(&windir);
        return windir.join("SysNative\\drivers\\dokan2.sys").is_file()
            || windir.join("System32\\drivers\\dokan2.sys").is_file();
    }

    #[cfg(target_os = "macos")]
    {
        return Path::new("/Library/Frameworks/macFUSE.framework").exists()
            || Path::new("/Library/Filesystems/macfuse.fs").exists();
    }

    #[cfg(target_os = "linux")]
    {
        return Path::new("/dev/fuse").exists()
            && std::process::Command::new("fusermount3")
                .arg("--version")
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(all(feature = "standard", target_os = "windows"))]
#[tauri::command]
pub fn install_album_drive_driver() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }

    let installer_path = AppPaths::global()
        .resource_dir
        .join("bin")
        .join("dokan-installer.exe");
    if !installer_path.is_file() {
        return Err(format!(
            "Dokan installer not found: {}",
            installer_path.display()
        ));
    }

    let operation = wide("runas");
    let file = wide(installer_path.as_os_str());
    let params = wide("/S");

    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    if result as isize <= 32 {
        return Err(format!(
            "Failed to launch Dokan installer: {}",
            result as isize
        ));
    }

    Ok(())
}

/// 收藏画册 id 是常量而非设置项：走 core 复用 `kabegame_core::storage::FAVORITE_ALBUM_ID`，
/// 不要再抄字面量。
#[tauri::command]
pub fn get_favorite_album_id() -> Result<serde_json::Value, String> {
    kabegame_core::commands::settings::get_favorite_album_id()
}

#[tauri::command]
#[cfg(feature = "standard")]
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
#[cfg(feature = "standard")]
pub fn set_album_drive_mount_point(mount_point: String) -> Result<(), String> {
    Settings::global().set_album_drive_mount_point(mount_point)
}

/// 语言变更的落地点：写入 → `sync_locale` → 刷新依赖 locale 的后端派生物
/// （托盘菜单、收藏画册名、官方插件源名）。
///
/// 这些副作用原先在 `startup::start_event_loop` 的 `SettingChange` 分支里做，
/// 但那里与 `sync_locale` 是竞态的：事件循环可能在 `sync_locale` 之前就跑 `t!()`，
/// 从而按旧 locale 写名字。放在这里可保证顺序。启动时的同等逻辑见 `core_init`。
#[tauri::command]
pub fn set_language<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    language: Option<String>,
) -> Result<(), String> {
    Settings::global().set_language(language.clone())?;
    kabegame_i18n::sync_locale(language.as_deref());

    #[cfg(not(target_os = "android"))]
    if let Err(e) = crate::tray::update_tray_menu(&app) {
        eprintln!("[托盘] 语言切换后刷新菜单失败: {}", e);
    }
    #[cfg(target_os = "android")]
    let _ = &app;

    let raw = kabegame_i18n::t!("albums.favorite");
    let i18n_name = if raw == "albums.favorite" {
        "收藏"
    } else {
        raw.as_str()
    };
    let storage = kabegame_core::storage::Storage::global();
    let _ = storage.ensure_favorite_album();
    if let Err(e) = storage.set_favorite_album_name(i18n_name) {
        eprintln!("[收藏画册] 语言切换后设置 i18n 名称失败: {}", e);
    }

    let raw_source_name = kabegame_i18n::t!("plugins.officialGithubReleaseSourceName");
    let i18n_source_name = if raw_source_name == "plugins.officialGithubReleaseSourceName" {
        kabegame_core::storage::plugin_sources::OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME
    } else {
        raw_source_name.as_str()
    };
    if let Err(e) = storage
        .plugin_sources()
        .set_official_source_name(i18n_source_name)
    {
        eprintln!("[插件官方源] 语言切换后设置 i18n 名称失败: {}", e);
    }

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

/// 走 core：写入设置的同时同步运行时调度器，见 `commands::settings`。
#[tauri::command]
pub async fn set_max_concurrent_downloads(count: u32) -> Result<serde_json::Value, String> {
    kabegame_core::commands::settings::set_max_concurrent_downloads(count).await
}

#[tauri::command]
pub fn set_max_concurrent_tasks(count: u32) -> Result<serde_json::Value, String> {
    kabegame_core::commands::settings::set_max_concurrent_tasks(count)
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
pub fn get_desktop_resolution<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(u32, u32), String> {
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
pub async fn set_realtime_folder_sync(enabled: bool) -> Result<(), String> {
    Settings::global().set_realtime_folder_sync(enabled)?;
    kabegame_core::local_folder::watch::set_enabled(enabled).await;
    Ok(())
}

#[tauri::command]
pub fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    Settings::global().set_default_download_dir(dir)
}

#[tauri::command]
pub fn get_default_images_dir() -> Result<String, String> {
    Ok(kabegame_core::storage::Storage::global()
        .get_images_dir()
        .to_string_lossy()
        .to_string())
}
