// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::Shell::DROPFILES,
};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

mod crawler;
mod plugin;
mod settings;
mod storage;
mod tray;
mod wallpaper;
mod wallpaper_engine_export;

use crawler::{crawl_images, ActiveDownloadInfo, CrawlResult};
use plugin::{BrowserPlugin, Plugin, PluginManager};
use settings::{AppSettings, Settings};
use storage::{Album, ImageInfo, PaginatedImages, RunConfig, Storage, TaskInfo};
use wallpaper::{WallpaperController, WallpaperRotator, WallpaperWindow};
use wallpaper_engine_export::{export_album_to_we_project, export_images_to_we_project};

#[tauri::command]
fn get_plugins(state: tauri::State<PluginManager>) -> Result<Vec<Plugin>, String> {
    state.get_all()
}

#[tauri::command]
fn add_plugin(plugin: Plugin, state: tauri::State<PluginManager>) -> Result<Plugin, String> {
    state.add(plugin)
}

#[tauri::command]
fn update_plugin(
    plugin_id: String,
    updates: HashMap<String, serde_json::Value>,
    state: tauri::State<PluginManager>,
) -> Result<Plugin, String> {
    state.update(&plugin_id, updates)
}

#[tauri::command]
fn delete_plugin(plugin_id: String, state: tauri::State<PluginManager>) -> Result<(), String> {
    state.delete(&plugin_id)
}

#[tauri::command]
async fn crawl_images_command(
    plugin_id: String,
    url: String,
    task_id: String,
    output_dir: Option<String>,
    user_config: Option<HashMap<String, serde_json::Value>>, // 用户配置的变量
    app: tauri::AppHandle,
) -> Result<CrawlResult, String> {
    let plugin_manager = app.state::<PluginManager>();
    let plugin = plugin_manager
        .get(&plugin_id)
        .ok_or_else(|| format!("Plugin {} not found", plugin_id))?;

    let storage = app.state::<Storage>();
    let settings_state = app.state::<Settings>();

    // 如果指定了输出目录，使用指定目录；否则使用默认目录
    let images_dir = if let Some(ref dir) = output_dir {
        std::path::PathBuf::from(dir)
    } else {
        // 优先使用“默认下载目录”，否则回退到应用内置 images 目录
        match settings_state
            .get_settings()
            .ok()
            .and_then(|s| s.default_download_dir)
        {
            Some(dir) => std::path::PathBuf::from(dir),
            None => storage.get_images_dir(),
        }
    };

    // 如果没有提供用户配置，尝试加载已保存的配置
    let final_user_config = if let Some(config) = user_config {
        Some(config)
    } else {
        plugin_manager.load_plugin_config(&plugin_id).ok()
    };

    let result = crawl_images(
        &plugin,
        &url,
        &task_id,
        images_dir,
        app.clone(),
        final_user_config,
    )
    .await
    .map_err(|e| {
        // 脚本执行错误时，通过事件通知前端
        let _ = app.emit(
            "task-error",
            serde_json::json!({
                "taskId": task_id,
                "error": e.clone()
            }),
        );
        e
    })?;

    // 保存图片元数据到全局 store，关联 task_id
    for img_data in &result.images {
        let hash = compute_file_hash(std::path::Path::new(&img_data.local_path))
            .unwrap_or_else(|_| String::new());
        let image_info = ImageInfo {
            id: uuid::Uuid::new_v4().to_string(),
            url: img_data.url.clone(),
            local_path: img_data.local_path.clone(),
            plugin_id: plugin_id.clone(),
            task_id: Some(task_id.clone()),
            crawled_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            metadata: img_data.metadata.clone(),
            thumbnail_path: if img_data.thumbnail_path.trim().is_empty() {
                img_data.local_path.clone()
            } else {
                img_data.thumbnail_path.clone()
            },
            favorite: false,
            hash,
        };
        let _ = storage.add_image(image_info);
    }

    Ok(result)
}

#[tauri::command]
fn get_images(state: tauri::State<Storage>) -> Result<Vec<ImageInfo>, String> {
    state.get_all_images()
}

#[tauri::command]
fn get_images_paginated(
    page: usize,
    page_size: usize,
    plugin_id: Option<String>,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_images_paginated(page, page_size, plugin_id.as_deref())
}

#[tauri::command]
fn get_albums(state: tauri::State<Storage>) -> Result<Vec<Album>, String> {
    state.get_albums()
}

#[tauri::command]
fn add_album(name: String, state: tauri::State<Storage>) -> Result<Album, String> {
    state.add_album(&name)
}

#[tauri::command]
fn delete_album(album_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.delete_album(&album_id)
}

#[tauri::command]
fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
) -> Result<usize, String> {
    state.add_images_to_album(&album_id, &image_ids)
}

#[tauri::command]
fn get_album_images(
    album_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<ImageInfo>, String> {
    state.get_album_images(&album_id)
}

#[tauri::command]
fn get_album_preview(
    album_id: String,
    limit: usize,
    state: tauri::State<Storage>,
) -> Result<Vec<ImageInfo>, String> {
    state.get_album_preview(&album_id, limit)
}

#[tauri::command]
fn get_album_counts(
    state: tauri::State<Storage>,
) -> Result<std::collections::HashMap<String, usize>, String> {
    state.get_album_counts()
}

fn compute_file_hash(path: &std::path::Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
fn get_images_count(
    plugin_id: Option<String>,
    state: tauri::State<Storage>,
) -> Result<usize, String> {
    state.get_total_count(plugin_id.as_deref())
}

#[tauri::command]
fn delete_image(image_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.delete_image(&image_id)
}

#[tauri::command]
fn toggle_image_favorite(
    image_id: String,
    favorite: bool,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    state.toggle_image_favorite(&image_id, favorite)
}

#[tauri::command]
fn open_file_path(file_path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn open_file_folder(file_path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        let path = Path::new(&file_path);
        if path.parent().is_some() {
            Command::new("explorer")
                .args(["/select,", &file_path])
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        } else {
            return Err("Invalid file path".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        let path = Path::new(&file_path);
        if let Some(parent) = path.parent() {
            Command::new("open")
                .arg("-R")
                .arg(&file_path)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        } else {
            return Err("Invalid file path".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        let path = Path::new(&file_path);
        if let Some(parent) = path.parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        } else {
            return Err("Invalid file path".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn set_wallpaper(file_path: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    // 使用全局 WallpaperController：适配“单张壁纸”并支持 native/window 两种后端模式。
    // 注意：这里不涉及 transition（过渡效果由“轮播 manager”负责，并受“是否启用轮播”约束）。
    let controller = app.state::<WallpaperController>();
    let settings_state = app.state::<Settings>();
    let settings = settings_state.get_settings()?;

    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    controller.set_wallpaper(&abs, &settings.wallpaper_rotation_style)?;

    Ok(())
}

#[tauri::command]
fn migrate_images_from_json(state: tauri::State<Storage>) -> Result<usize, String> {
    state.migrate_from_json()
}

#[tauri::command]
fn get_plugin_vars(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<Option<Vec<plugin::VarDefinition>>, String> {
    state.get_plugin_vars(&plugin_id)
}

#[tauri::command]
fn save_plugin_config(
    plugin_id: String,
    config: HashMap<String, serde_json::Value>,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.save_plugin_config(&plugin_id, &config)
}

#[tauri::command]
fn load_plugin_config(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    state.load_plugin_config(&plugin_id)
}

#[tauri::command]
fn get_browser_plugins(state: tauri::State<PluginManager>) -> Result<Vec<BrowserPlugin>, String> {
    state.load_browser_plugins()
}

#[tauri::command]
fn import_plugin_from_zip(
    zip_path: String,
    state: tauri::State<PluginManager>,
) -> Result<Plugin, String> {
    let path = std::path::PathBuf::from(zip_path);
    state.install_plugin_from_zip(&path)
}

#[tauri::command]
fn install_browser_plugin(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<Plugin, String> {
    state.install_browser_plugin(plugin_id)
}

#[tauri::command]
fn toggle_plugin_favorite(
    plugin_id: String,
    favorite: bool,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.toggle_favorite(plugin_id, favorite)
}

#[tauri::command]
async fn get_gallery_image(image_path: String) -> Result<Vec<u8>, String> {
    use std::fs;
    use std::path::Path;

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))
}

#[tauri::command]
async fn get_plugin_image(
    plugin_id: String,
    image_path: String,
    state: tauri::State<'_, PluginManager>,
) -> Result<Vec<u8>, String> {
    // 找到插件文件
    let plugins_dir = state.get_plugins_directory();
    let entries = std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            if let Ok(manifest) = state.read_plugin_manifest(&path) {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let generated_id = format!("{}-{}", file_name, manifest.name);

                if generated_id == plugin_id {
                    return state.read_plugin_image(&path, &image_path);
                }
            }
        }
    }

    Err(format!("Plugin {} not found", plugin_id))
}

#[tauri::command]
async fn get_plugin_icon(
    plugin_id: String,
    state: tauri::State<'_, PluginManager>,
) -> Result<Option<Vec<u8>>, String> {
    // 找到插件文件
    let plugins_dir = state.get_plugins_directory();
    let entries = std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            if let Ok(manifest) = state.read_plugin_manifest(&path) {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let generated_id = format!("{}-{}", file_name, manifest.name);

                if generated_id == plugin_id {
                    return state.read_plugin_icon(&path);
                }
            }
        }
    }

    Err(format!("Plugin {} not found", plugin_id))
}

#[tauri::command]
fn get_settings(state: tauri::State<Settings>) -> Result<AppSettings, String> {
    state.get_settings()
}

#[tauri::command]
fn set_auto_launch(enabled: bool, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_auto_launch(enabled)
}

#[tauri::command]
fn set_max_concurrent_downloads(count: u32, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_max_concurrent_downloads(count)
}

#[tauri::command]
fn set_network_retry_count(count: u32, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_network_retry_count(count)
}

#[tauri::command]
fn set_image_click_action(action: String, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_image_click_action(action)
}

#[tauri::command]
fn set_gallery_columns(columns: u32, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_gallery_columns(columns)
}

#[tauri::command]
fn set_gallery_image_aspect_ratio_match_window(
    enabled: bool,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_gallery_image_aspect_ratio_match_window(enabled)
}

#[tauri::command]
fn set_gallery_page_size(size: u32, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_gallery_page_size(size)
}

#[tauri::command]
fn set_default_download_dir(
    dir: Option<String>,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_default_download_dir(dir)
}

#[tauri::command]
fn set_wallpaper_engine_dir(
    dir: Option<String>,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_wallpaper_engine_dir(dir)
}

#[tauri::command]
fn get_wallpaper_engine_myprojects_dir(
    state: tauri::State<Settings>,
) -> Result<Option<String>, String> {
    state.get_wallpaper_engine_myprojects_dir()
}

#[tauri::command]
fn get_default_images_dir(state: tauri::State<Storage>) -> Result<String, String> {
    Ok(state
        .get_images_dir()
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string())
}

#[tauri::command]
fn get_active_downloads(app: tauri::AppHandle) -> Result<Vec<ActiveDownloadInfo>, String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.get_active_downloads()
}

#[tauri::command]
fn add_run_config(config: RunConfig, state: tauri::State<Storage>) -> Result<RunConfig, String> {
    state.add_run_config(config.clone())?;
    Ok(config)
}

#[tauri::command]
fn get_run_configs(state: tauri::State<Storage>) -> Result<Vec<RunConfig>, String> {
    state.get_run_configs()
}

#[tauri::command]
fn delete_run_config(config_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.delete_run_config(&config_id)
}

#[tauri::command]
fn cancel_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.cancel_task(&task_id)?;
    Ok(())
}

#[tauri::command]
fn get_download_queue_size(app: tauri::AppHandle) -> Result<usize, String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.get_queue_size()
}

// 任务相关命令
#[tauri::command]
fn add_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.add_task(task)
}

#[tauri::command]
fn update_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.update_task(task)
}

#[tauri::command]
fn get_task(task_id: String, state: tauri::State<Storage>) -> Result<Option<TaskInfo>, String> {
    state.get_task(&task_id)
}

#[tauri::command]
fn get_all_tasks(state: tauri::State<Storage>) -> Result<Vec<TaskInfo>, String> {
    state.get_all_tasks()
}

#[tauri::command]
fn delete_task(task_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.delete_task(&task_id)
}

#[tauri::command]
fn get_task_images(
    task_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<ImageInfo>, String> {
    state.get_task_images(&task_id)
}

#[tauri::command]
fn get_task_images_paginated(
    task_id: String,
    page: usize,
    page_size: usize,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_task_images_paginated(&task_id, page, page_size)
}

// Windows：将文件列表写入剪贴板为 CF_HDROP，便于原生应用粘贴/拖拽识别
#[cfg(target_os = "windows")]
#[tauri::command]
fn set_wallpaper_rotation_enabled(
    enabled: bool,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.set_wallpaper_rotation_enabled(enabled)?;

    // 获取轮播器状态
    let rotator = app.state::<WallpaperRotator>();
    if enabled {
        rotator.start()?;
    } else {
        rotator.stop();

        // 如果关闭壁纸轮播且当前是窗口模式，关闭壁纸窗口
        let current_settings = state.get_settings()?;
        if current_settings.wallpaper_mode == "window" {
            if let Some(window) = app.get_webview_window("wallpaper") {
                if let Err(e) = window.hide() {
                    eprintln!("[WARN] 关闭壁纸窗口失败: {}", e);
                } else {
                    println!("[DEBUG] 已关闭壁纸窗口（壁纸轮播已禁用）");
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn set_wallpaper_rotation_album_id(
    album_id: Option<String>,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_wallpaper_rotation_album_id(album_id)
}

#[tauri::command]
fn set_wallpaper_rotation_interval_minutes(
    minutes: u32,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.set_wallpaper_rotation_interval_minutes(minutes)?;

    // 如果轮播器正在运行，重置定时器以应用新的间隔设置
    if let Some(rotator) = app.try_state::<WallpaperRotator>() {
        if rotator.is_running() {
            rotator.reset();
        }
    }

    Ok(())
}

#[tauri::command]
fn set_wallpaper_rotation_mode(mode: String, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_wallpaper_rotation_mode(mode)
}

#[tauri::command]
fn set_wallpaper_style(
    style: String,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    println!(
        "[DEBUG] set_wallpaper_style 被调用，传入的 style: {}",
        style
    );

    // 先保存设置
    state.set_wallpaper_style(style.clone())?;
    println!("[DEBUG] 已保存新 style: {}", style);

    // 原生模式下应用样式可能较慢（PowerShell/注册表/广播），放到后台线程避免前端卡顿
    let app_clone = app.clone();
    let style_clone = style.clone();
    std::thread::spawn(move || {
        let controller = app_clone.state::<WallpaperController>();
        let res = controller.active_manager().and_then(|m| {
            // 1) 先设置样式
            m.set_style(&style_clone, true)?;
            // 2) 再重载当前壁纸路径，强制桌面立即用新样式重新渲染
            //    （否则部分系统/场景只改注册表不会立刻重绘）
            if let Ok(path) = m.get_wallpaper_path() {
                if std::path::Path::new(&path).exists() {
                    let _ = m.set_wallpaper_path(&path, true);
                }
            }
            Ok(())
        });
        match res {
            Ok(_) => {
                let _ = app_clone.emit(
                    "wallpaper-style-apply-complete",
                    serde_json::json!({
                        "success": true,
                        "style": style_clone
                    }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-style-apply-complete",
                    serde_json::json!({
                        "success": false,
                        "style": style_clone,
                        "error": e
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn set_wallpaper_rotation_transition(
    transition: String,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    println!(
        "[DEBUG] set_wallpaper_rotation_transition 被调用，传入的 transition: {}",
        transition
    );

    // 未开启轮播时，不允许设置过渡效果（单张模式不支持 transition）
    let current_settings = state.get_settings()?;
    if !current_settings.wallpaper_rotation_enabled {
        return Err("未开启壁纸轮播，无法设置过渡效果".to_string());
    }

    // 先保存设置
    state.set_wallpaper_rotation_transition(transition.clone())?;
    println!("[DEBUG] 已保存新 transition: {}", transition);

    // 立即触发一次展示效果（先应用 transition，再切换一张壁纸）
    // 注意：对于 "none"（无过渡），只保存设置，不切换壁纸（避免触发系统默认的淡入效果）
    let app_clone = app.clone();
    let transition_clone = transition.clone();
    std::thread::spawn(move || {
        let controller = app_clone.state::<WallpaperController>();
        let rotator = app_clone.state::<WallpaperRotator>();

        let res: Result<(), String> = (|| {
            // 1) 先应用 transition（立即）
            let m = controller.active_manager()?;
            m.set_transition(&transition_clone, true)?;

            // 2) 对于 "none"（无过渡），不切换壁纸，只保存设置
            // 对于其他 transition（如 "fade"），触发一次"下一张"，让用户立刻看到过渡效果
            if transition_clone != "none" {
                rotator.rotate()?;
            }
            Ok(())
        })();

        match res {
            Ok(_) => {
                let _ = app_clone.emit(
                    "wallpaper-transition-apply-complete",
                    serde_json::json!({
                        "success": true,
                        "transition": transition_clone
                    }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-transition-apply-complete",
                    serde_json::json!({
                        "success": false,
                        "transition": transition_clone,
                        "error": e
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn set_wallpaper_mode(
    mode: String,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;

    let current_settings = state.get_settings()?;
    let old_mode = current_settings.wallpaper_mode.clone();

    // 如果模式和当前设置相同，直接返回成功
    if old_mode == mode {
        return Ok(());
    }

    // 在后台线程中执行可能耗时的操作，避免阻塞主线程
    let mode_clone = mode.clone();
    let old_mode_clone = old_mode.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let settings_state = app_clone.state::<Settings>();
        let rotator = app_clone.state::<WallpaperRotator>();
        let controller = app_clone.state::<WallpaperController>();

        // 关键：切换模式期间先暂停轮播，避免轮播线程仍按旧 mode（native）调用 SPI_SETDESKWALLPAPER，
        // 导致 Explorer 刷新把刚挂载的 window wallpaper “顶掉”，表现为“闪一下就没了”。
        let was_running = rotator.is_running();
        if was_running {
            rotator.stop();
        }

        // 读取最新设置（style/transition/是否启用轮播）
        let s = match settings_state.get_settings() {
            Ok(s) => s,
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("获取设置失败: {}", e)
                    }),
                );
                return;
            }
        };

        // 1) 从旧后端读取“当前壁纸路径”（尽量保持当前壁纸不变）
        let current_wallpaper = match controller
            .manager_for_mode(&old_mode_clone)
            .get_wallpaper_path()
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("切换模式时无法获取当前壁纸: {}", e);
                // 没有当前壁纸：仍允许切换模式（仅保存 mode），但不做 reapply
                match settings_state.set_wallpaper_mode(mode_clone.clone()) {
                    Ok(_) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": true,
                                "mode": mode_clone
                            }),
                        );
                    }
                    Err(e2) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": false,
                                "mode": mode_clone,
                                "error": format!("保存模式失败: {}", e2)
                            }),
                        );
                    }
                }
                return;
            }
        };

        // 2) 在目标后端上应用同一张壁纸（style 立即生效；transition 仅在轮播启用时预览）
        let target = controller.manager_for_mode(&mode_clone);
        // Windows 下，有时系统返回的“当前壁纸路径”可能不存在（例如主题缓存/临时文件）。
        // 切换到 window 模式时必须保证文件真实存在，否则 WindowWallpaperManager 会报 File does not exist。
        let resolved_wallpaper = if std::path::Path::new(&current_wallpaper).exists() {
            current_wallpaper.clone()
        } else {
            // 尝试从轮播画册里找一张确实存在的图片作为兜底
            let album_id = s.wallpaper_rotation_album_id.clone().unwrap_or_default();
            if album_id.is_empty() {
                current_wallpaper.clone()
            } else if let Some(storage) = app_clone.try_state::<Storage>() {
                let imgs = storage.get_album_images(&album_id).unwrap_or_default();
                let mut picked: Option<String> = None;
                for img in imgs {
                    if std::path::Path::new(&img.local_path).exists() {
                        picked = Some(img.local_path);
                        break;
                    }
                }
                picked.unwrap_or_else(|| current_wallpaper.clone())
            } else {
                current_wallpaper.clone()
            }
        };
        let apply_res: Result<(), String> = (|| {
            // 关键：确保目标后端已初始化（尤其是 window 模式需要提前把 WallpaperWindow 放进 manager 状态）
            // 否则会报 “窗口未初始化，请先调用 init 方法”，前端就会一直显示“切换中”。
            target.init(app_clone.clone())?;
            // 先切换壁纸路径
            target.set_wallpaper_path(&resolved_wallpaper, true)?;
            // 再应用样式
            target.set_style(&s.wallpaper_rotation_style, true)?;
            // 过渡效果属于轮播能力：只在轮播启用时做立即预览
            if s.wallpaper_rotation_enabled {
                // 最后应用transition
                target.set_transition(&s.wallpaper_rotation_transition, true)?;
            }
            Ok(())
        })();

        match apply_res {
            Ok(_) => {
                // 切换 away from window 模式时，清理 window 后端（隐藏壁纸窗口）
                if old_mode_clone == "window" && mode_clone != "window" {
                    controller
                        .manager_for_mode("window")
                        .cleanup()
                        .unwrap_or_else(|e| eprintln!("清理 window 资源失败: {}", e));
                }
                // 3) 应用成功后再持久化 mode
                if let Err(e) = settings_state.set_wallpaper_mode(mode_clone.clone()) {
                    let _ = app_clone.emit(
                        "wallpaper-mode-switch-complete",
                        serde_json::json!({
                            "success": false,
                            "mode": mode_clone,
                            "error": format!("保存模式失败: {}", e)
                        }),
                    );
                    return;
                }

                // 4) 轮播开启时重置定时器（切换模式也算一次“用户触发”）
                if s.wallpaper_rotation_enabled {
                    // 切换完成后再恢复轮播（若之前在跑或用户开启了轮播）
                    // 这里用 start 确保轮播线程按新 mode 工作
                    let _ = rotator.start();
                }

                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": true,
                        "mode": mode_clone
                    }),
                );
            }
            Err(e) => {
                eprintln!("切换到 {} 模式失败: {}", mode_clone, e);
                // 失败时恢复轮播（如果之前在运行）
                if was_running {
                    let _ = rotator.start();
                }
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("切换模式失败: {}", e)
                    }),
                );
            }
        };
    });
    // 立即返回，不等待后台线程完成
    // 前端会通过事件来获知切换结果
    Ok(())
}

#[tauri::command]
fn get_wallpaper_rotator_status(app: tauri::AppHandle) -> Result<bool, String> {
    let rotator = app.state::<WallpaperRotator>();
    Ok(rotator.is_running())
}

/// 获取系统原生模式支持的壁纸样式列表
#[tauri::command]
fn get_native_wallpaper_styles() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        // Windows 支持所有样式
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 原生支持较少，主要支持 fill 和 center
        Ok(vec!["fill".to_string(), "center".to_string()])
    }

    #[cfg(target_os = "linux")]
    {
        // Linux 取决于桌面环境，尝试检测并返回支持的样式
        // 默认返回所有样式，让用户选择（如果系统不支持会自动回退）
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        // 其他平台默认只支持 fill
        Ok(vec!["fill".to_string()])
    }
}

/// 隐藏主窗口（用于窗口关闭事件处理）
#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.webview_windows().values().next() {
        window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;
    } else {
        return Err("找不到主窗口".to_string());
    }
    Ok(())
}

/// 壁纸窗口前端 ready 后调用，用于触发一次"推送当前壁纸到壁纸窗口"。
/// 解决壁纸窗口尚未注册事件监听时，后端先 emit 导致事件丢失的问题。
#[tauri::command]
#[cfg(target_os = "windows")]
fn wallpaper_window_ready(app: tauri::AppHandle) -> Result<(), String> {
    // 标记窗口已完全初始化
    println!("壁纸窗口已就绪");
    WallpaperWindow::mark_ready();

    // // 前端 ready 之后，补推一次当前状态（避免启动/切换时事件在监听器注册前丢失）
    // let controller = app.state::<WallpaperController>();
    // let settings = app.state::<Settings>();
    // let s = settings.get_settings().unwrap_or_default();

    // // 只有在 window 模式下才需要补推到 wallpaper window
    // if s.wallpaper_mode == "window" {
    //     let target = controller.manager_for_mode("window");
    //     let _ = target.init(app.clone());

    //     // 优先使用 window manager 里记录的当前路径；没有则用系统当前壁纸（native）
    //     let mut path: Option<String> = target.get_wallpaper_path().ok();
    //     if path.as_ref().map_or(true, |p| p.is_empty()) {
    //         path = controller
    //             .manager_for_mode("native")
    //             .get_wallpaper_path()
    //             .ok();
    //     }

    //     if let Some(p) = path {
    //         if !p.is_empty() && std::path::Path::new(&p).exists() {
    //             let _ = target.set_wallpaper_path(&p, true);
    //             let _ = target.set_style(&s.wallpaper_rotation_style, true);
    //             if s.wallpaper_rotation_enabled {
    //                 let _ = target.set_transition(&s.wallpaper_rotation_transition, true);
    //             }
    //         } else {
    //             eprintln!("[DEBUG] wallpaper_window_ready: no valid wallpaper path to push");
    //         }
    //     }
    // }
    Ok(())
}

// Windows：将文件列表写入剪贴板为 CF_HDROP，便于原生应用粘贴/拖拽识别
#[cfg(target_os = "windows")]
#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("paths is empty".into());
    }

    // 构造双零结尾的 UTF-16 路径列表（以 '\0' 分隔，末尾再加 '\0'）
    let mut path_list = String::new();
    for (idx, p) in paths.iter().enumerate() {
        if idx > 0 {
            path_list.push('\0');
        }
        // 去掉 Windows 长路径前缀 \\?\
        let cleaned = p.trim_start_matches(r"\\?\");
        path_list.push_str(cleaned);
    }
    path_list.push('\0'); // 额外终止符

    let wide: Vec<u16> = path_list.encode_utf16().collect();
    let bytes_len = wide.len() * 2;
    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let total_size = dropfiles_size + bytes_len;

    unsafe {
        // GlobalAlloc 返回 HGLOBAL（指针），NULL 表示失败
        let h_global: *mut std::ffi::c_void = GlobalAlloc(GMEM_MOVEABLE, total_size);
        if h_global.is_null() {
            return Err("GlobalAlloc failed".into());
        }

        let ptr = GlobalLock(h_global);
        if ptr.is_null() {
            return Err("GlobalLock failed".into());
        }

        // 写入 DROPFILES
        let df_ptr = ptr as *mut DROPFILES;
        (*df_ptr).pFiles = dropfiles_size as u32;
        (*df_ptr).pt.x = 0;
        (*df_ptr).pt.y = 0;
        (*df_ptr).fNC = 0;
        (*df_ptr).fWide = 1; // UTF-16

        // 写入路径字符串
        let data_ptr = (ptr as usize + dropfiles_size) as *mut u8;
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, data_ptr, bytes_len);

        GlobalUnlock(h_global);

        if OpenClipboard(0) == 0 {
            return Err("OpenClipboard failed".into());
        }
        if EmptyClipboard() == 0 {
            let _ = CloseClipboard();
            return Err("EmptyClipboard failed".into());
        }

        // SetClipboardData 接管内存，不要释放 h_global
        let res = SetClipboardData(CF_HDROP_FORMAT, h_global as isize);
        if res == 0 {
            let _ = CloseClipboard();
            return Err("SetClipboardData failed".into());
        }

        CloseClipboard();
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn copy_files_to_clipboard(_paths: Vec<String>) -> Result<(), String> {
    Err("copy_files_to_clipboard is only supported on Windows".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化插件管理器
            let plugin_manager = PluginManager::new(app.app_handle().clone());
            app.manage(plugin_manager);

            // 初始化存储管理器
            let storage = Storage::new(app.app_handle().clone());
            storage
                .init()
                .map_err(|e| format!("Failed to initialize storage: {}", e))?;
            app.manage(storage);

            // 初始化设置管理器
            let settings = Settings::new(app.app_handle().clone());
            app.manage(settings);

            // 初始化下载队列管理器
            let download_queue = crawler::DownloadQueue::new(app.app_handle().clone());
            app.manage(download_queue);

            // 初始化全局壁纸控制器（基础 manager）
            let wallpaper_controller = WallpaperController::new(app.app_handle().clone());
            app.manage(wallpaper_controller);

            // 初始化壁纸轮播器
            let rotator = WallpaperRotator::new(app.app_handle().clone());
            app.manage(rotator);

            // 创建壁纸窗口（用于窗口模式）
            #[cfg(target_os = "windows")]
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                let _ = WebviewWindowBuilder::new(
                    app,
                    "wallpaper",
                    // 使用独立的 wallpaper.html，只渲染 WallpaperLayer 组件
                    WebviewUrl::App("wallpaper.html".into()),
                )
                // 给壁纸窗口一个固定标题，便于脚本/调试定位到正确窗口
                .title("Kabegami Wallpaper")
                .fullscreen(true)
                .decorations(false)
                // 设置窗口为透明，背景为透明
                .transparent(true)
                .visible(false)
                .skip_taskbar(true)
                .build();
            }

            // 创建系统托盘（使用 Tauri 2.0 内置 API）
            tray::setup_tray(app.app_handle().clone());

            // 初始化壁纸控制器，然后根据设置决定是否启动轮播
            let app_handle = app.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500)); // 延迟启动，确保应用完全初始化

                // 创建 Tokio runtime 用于异步初始化
                let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

                rt.block_on(async {
                    // 初始化壁纸控制器（如创建窗口等）
                    let controller = app_handle.state::<WallpaperController>();
                    if let Err(e) = controller.init().await {
                        eprintln!("初始化壁纸控制器失败: {}", e);
                    }

                    println!("初始化壁纸控制器完成");

                    // 初始化完成后：如果当前就是 window 模式，则start rotator
                    let settings = app_handle.state::<Settings>();
                    if let Ok(app_settings) = settings.get_settings() {
                        if app_settings.wallpaper_rotation_enabled {
                            let rotator = app_handle.state::<WallpaperRotator>();
                            if let Err(e) = rotator.start() {
                                eprintln!("启动壁纸轮播失败: {}", e);
                            }
                        }
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 任务相关命令
            add_task,
            update_task,
            get_task,
            get_all_tasks,
            delete_task,
            get_task_images,
            get_task_images_paginated,
            // 原有命令
            get_plugins,
            add_plugin,
            update_plugin,
            delete_plugin,
            crawl_images_command,
            get_images,
            get_images_paginated,
            get_albums,
            add_album,
            delete_album,
            add_images_to_album,
            get_album_images,
            get_album_preview,
            get_album_counts,
            get_images_count,
            delete_image,
            toggle_image_favorite,
            open_file_path,
            open_file_folder,
            set_wallpaper,
            migrate_images_from_json,
            get_browser_plugins,
            import_plugin_from_zip,
            install_browser_plugin,
            toggle_plugin_favorite,
            get_plugin_image,
            get_plugin_icon,
            get_gallery_image,
            get_plugin_vars,
            save_plugin_config,
            load_plugin_config,
            get_settings,
            set_auto_launch,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_image_click_action,
            set_gallery_columns,
            set_gallery_image_aspect_ratio_match_window,
            set_gallery_page_size,
            set_default_download_dir,
            set_wallpaper_engine_dir,
            get_wallpaper_engine_myprojects_dir,
            get_default_images_dir,
            get_active_downloads,
            add_run_config,
            get_run_configs,
            delete_run_config,
            cancel_task,
            get_download_queue_size,
            copy_files_to_clipboard,
            set_wallpaper_rotation_enabled,
            set_wallpaper_rotation_album_id,
            set_wallpaper_rotation_interval_minutes,
            set_wallpaper_rotation_mode,
            set_wallpaper_style,
            set_wallpaper_rotation_transition,
            set_wallpaper_mode,
            get_wallpaper_rotator_status,
            get_native_wallpaper_styles,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            hide_main_window,
            // Wallpaper Engine 导出
            export_album_to_we_project,
            export_images_to_we_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
