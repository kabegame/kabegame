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
mod wallpaper;
mod wallpaper_engine_export;

use crawler::{crawl_images, ActiveDownloadInfo, CrawlResult};
use plugin::{BrowserPlugin, Plugin, PluginManager};
use settings::{AppSettings, Settings};
use storage::{Album, ImageInfo, PaginatedImages, RunConfig, Storage, TaskInfo};
use wallpaper::{WallpaperRotator, WallpaperWindow};
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
fn set_wallpaper(file_path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Windows 使用 PowerShell 设置壁纸
        // 将路径转换为绝对路径并规范化
        let absolute_path = path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?
            .to_string_lossy()
            .to_string();

        // 使用更可靠的 PowerShell 脚本，使用双引号包裹路径
        let escaped_path = absolute_path.replace('"', "\"\"");
        let script = format!(
            r#"Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Wallpaper {{
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}}
"@; $result = [Wallpaper]::SystemParametersInfo(20, 0, "{}", 3); if ($result -eq 0) {{ throw "SystemParametersInfo failed" }}"#,
            escaped_path
        );

        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .map_err(|e| format!("Failed to execute PowerShell: {}", e))?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "Failed to set wallpaper. Error: {}, Output: {}",
                error, stdout
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 使用 osascript 设置壁纸
        let script = format!(
            r#"tell application "System Events" to tell every desktop to set picture to "{}""#,
            file_path
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to set wallpaper: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Linux 使用 gsettings (GNOME) 或 feh (其他桌面环境)
        // 先尝试 gsettings
        if Command::new("gsettings")
            .args([
                "set",
                "org.gnome.desktop.background",
                "picture-uri",
                &format!("file://{}", file_path),
            ])
            .spawn()
            .is_err()
        {
            // 如果 gsettings 失败，尝试 feh
            Command::new("feh")
                .args(["--bg-scale", &file_path])
                .spawn()
                .map_err(|e| format!("Failed to set wallpaper: {}", e))?;
        }
    }

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
) -> Result<(), String> {
    state.set_wallpaper_rotation_interval_minutes(minutes)
}

#[tauri::command]
fn set_wallpaper_rotation_mode(mode: String, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_wallpaper_rotation_mode(mode)
}

#[tauri::command]
fn set_wallpaper_rotation_style(
    style: String,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    println!(
        "[DEBUG] set_wallpaper_rotation_style 被调用，传入的 style: {}",
        style
    );

    // 先获取当前设置，以便在重新应用时使用正确的 transition 值
    let current_settings = state.get_settings()?;
    let transition = current_settings.wallpaper_rotation_transition.clone();
    println!("[DEBUG] 当前设置中的 transition: {}", transition);
    println!(
        "[DEBUG] 当前设置中的 style (旧值): {}",
        current_settings.wallpaper_rotation_style
    );

    state.set_wallpaper_rotation_style(style.clone())?;
    println!("[DEBUG] 已保存新 style: {}", style);

    // 如果轮播已启用，在后台线程中重新应用当前壁纸以使用新设置
    if current_settings.wallpaper_rotation_enabled {
        println!(
            "[DEBUG] 轮播已启用，准备在后台重新应用壁纸，使用 style: {}, transition: {}",
            style, transition
        );
        let app_handle = app.app_handle().clone();
        let style_clone = style.clone();
        let transition_clone = transition.clone();
        // 在后台线程中执行，避免阻塞 UI
        std::thread::spawn(move || {
            if let Some(rotator) = app_handle.try_state::<WallpaperRotator>() {
                if let Err(e) =
                    rotator.reapply_current_wallpaper(Some(&style_clone), Some(&transition_clone))
                {
                    // 如果重新应用失败（可能没有当前壁纸），只记录错误但不阻止设置保存
                    eprintln!("重新应用当前壁纸失败: {}", e);
                }
            }
        });
    } else {
        println!("[DEBUG] 轮播未启用，跳过重新应用壁纸");
    }

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

    // 先获取当前设置，以便在重新应用时使用正确的 style 值
    let current_settings = state.get_settings()?;
    let style = current_settings.wallpaper_rotation_style.clone();
    println!("[DEBUG] 当前设置中的 style: {}", style);
    println!(
        "[DEBUG] 当前设置中的 transition (旧值): {}",
        current_settings.wallpaper_rotation_transition
    );

    state.set_wallpaper_rotation_transition(transition.clone())?;
    println!("[DEBUG] 已保存新 transition: {}", transition);

    // 如果轮播已启用，在后台线程中重新应用当前壁纸以使用新设置
    if current_settings.wallpaper_rotation_enabled {
        println!(
            "[DEBUG] 轮播已启用，准备在后台重新应用壁纸，使用 style: {}, transition: {}",
            style, transition
        );
        let app_handle = app.app_handle().clone();
        let style_clone = style.clone();
        let transition_clone = transition.clone();
        // 在后台线程中执行，避免阻塞 UI
        std::thread::spawn(move || {
            if let Some(rotator) = app_handle.try_state::<WallpaperRotator>() {
                if let Err(e) =
                    rotator.reapply_current_wallpaper(Some(&style_clone), Some(&transition_clone))
                {
                    // 如果重新应用失败（可能没有当前壁纸），只记录错误但不阻止设置保存
                    eprintln!("重新应用当前壁纸失败: {}", e);
                }
            }
        });
    } else {
        println!("[DEBUG] 轮播未启用，跳过重新应用壁纸");
    }

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

    // 先临时保存新设置（以便 reapply_current_wallpaper 能读取到新模式）
    // 如果后续失败，会恢复原设置
    state.set_wallpaper_mode(mode.clone())?;

    // 在后台线程中执行可能耗时的操作，避免阻塞主线程
    let mode_clone = mode.clone();
    let old_mode_clone = old_mode.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let rotator = app_clone.state::<WallpaperRotator>();
        let state_inner = app_clone.state::<Settings>();

        // 尝试重新应用当前壁纸（使用新模式）
        match rotator.reapply_current_wallpaper(None, None) {
            Ok(_) => {
                // 如果轮播器正在运行，先停止它（这会重置定时器）
                let was_running = rotator.is_running();
                if was_running {
                    rotator.stop();
                    // 等待一小段时间确保定时器线程退出
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if let Err(e) = rotator.start() {
                        eprintln!("重新启动轮播器失败: {}", e);
                    }
                }
                // 切换成功，发送成功事件
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

                // 检查失败原因：只有在"没有当前壁纸"的情况下，才切换到下一张
                // 其他失败原因（如窗口创建失败、文件不存在等）应该返回错误，而不是切换到下一张
                let is_no_current_wallpaper = e.contains("没有当前壁纸");

                if mode_clone == "window" && is_no_current_wallpaper {
                    // 只有在没有当前壁纸的情况下，才尝试切换下一张用于初始化窗口
                    eprintln!("[DEBUG] 切换到 window 模式但没有当前壁纸，尝试切换下一张用于初始化");
                    // 再次设置新模式（因为 rotate_once_now 也会读取设置）
                    let _ = state_inner.set_wallpaper_mode(mode_clone.clone());

                    match rotator.rotate_once_now() {
                        Ok(_) => {
                            // 切换成功，发送成功事件
                            let _ = app_clone.emit(
                                "wallpaper-mode-switch-complete",
                                serde_json::json!({
                                    "success": true,
                                    "mode": mode_clone
                                }),
                            );
                        }
                        Err(rotate_err) => {
                            eprintln!("切换下一张壁纸也失败: {}", rotate_err);
                            // 恢复原设置
                            let _ = state_inner.set_wallpaper_mode(old_mode_clone.clone());
                            // 发送失败事件
                            let _ = app_clone.emit(
                                "wallpaper-mode-switch-complete",
                                serde_json::json!({
                                    "success": false,
                                    "mode": mode_clone,
                                    "error": format!("切换模式失败: {}", rotate_err)
                                }),
                            );
                        }
                    }
                } else {
                    // 其他失败情况（有当前壁纸但应用失败，或非 window 模式），恢复原设置并返回错误
                    // 非 window 模式，恢复原设置
                    let _ = state_inner.set_wallpaper_mode(old_mode_clone.clone());

                    // 发送失败事件
                    let _ = app_clone.emit(
                        "wallpaper-mode-switch-complete",
                        serde_json::json!({
                            "success": false,
                            "mode": mode_clone,
                            "error": format!("切换模式失败: {}", e)
                        }),
                    );
                }
            }
        }
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

/// 壁纸窗口前端 ready 后调用，用于触发一次“推送当前壁纸到壁纸窗口”。
/// 解决壁纸窗口尚未注册事件监听时，后端先 emit 导致事件丢失的问题。
#[tauri::command]
fn wallpaper_window_ready(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 标记窗口已完全初始化
    #[cfg(target_os = "windows")]
    WallpaperWindow::mark_ready();

    let settings_state = app.state::<Settings>();
    let s = settings_state
        .get_settings()
        .map_err(|e| format!("获取设置失败: {}", e))?;

    // 只有在窗口模式下才需要推送到 wallpaper window
    if s.wallpaper_mode != "window" {
        return Ok(());
    }

    let rotator = app.state::<WallpaperRotator>();

    // 尝试重新应用当前壁纸；若当前还没设置过壁纸，则尝试立刻切换一张
    if rotator
        .reapply_current_wallpaper(
            Some(&s.wallpaper_rotation_style),
            Some(&s.wallpaper_rotation_transition),
        )
        .is_err()
    {
        let _ = rotator.rotate_once_now();
    }

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
            // 延迟初始化，确保窗口已经创建
            let handle = app.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));

                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
                    Manager,
                };

                // 创建菜单项
                let show_item =
                    match MenuItem::with_id(&handle, "show", "显示窗口", true, None::<&str>) {
                        Ok(item) => item,
                        Err(e) => {
                            eprintln!("创建菜单项失败: {}", e);
                            return;
                        }
                    };
                let hide_item =
                    match MenuItem::with_id(&handle, "hide", "隐藏窗口", true, None::<&str>) {
                        Ok(item) => item,
                        Err(e) => {
                            eprintln!("创建菜单项失败: {}", e);
                            return;
                        }
                    };
                let next_wallpaper_item = match MenuItem::with_id(
                    &handle,
                    "next_wallpaper",
                    "下一张壁纸",
                    true,
                    None::<&str>,
                ) {
                    Ok(item) => item,
                    Err(e) => {
                        eprintln!("创建菜单项失败: {}", e);
                        return;
                    }
                };
                let debug_wallpaper_item = match MenuItem::with_id(
                    &handle,
                    "debug_wallpaper",
                    "调试：打开壁纸窗口",
                    true,
                    None::<&str>,
                ) {
                    Ok(item) => item,
                    Err(e) => {
                        eprintln!("创建菜单项失败: {}", e);
                        return;
                    }
                };
                let popup_wallpaper_item = match MenuItem::with_id(
                    &handle,
                    "popup_wallpaper",
                    "调试：弹出壁纸窗口(3秒)",
                    true,
                    None::<&str>,
                ) {
                    Ok(item) => item,
                    Err(e) => {
                        eprintln!("创建菜单项失败: {}", e);
                        return;
                    }
                };
                let popup_wallpaper_detach_item = match MenuItem::with_id(
                    &handle,
                    "popup_wallpaper_detach",
                    "调试：脱离桌面层弹出(3秒)",
                    true,
                    None::<&str>,
                ) {
                    Ok(item) => item,
                    Err(e) => {
                        eprintln!("创建菜单项失败: {}", e);
                        return;
                    }
                };
                let quit_item = match MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)
                {
                    Ok(item) => item,
                    Err(e) => {
                        eprintln!("创建菜单项失败: {}", e);
                        return;
                    }
                };

                // 创建菜单
                let menu = match Menu::with_items(
                    &handle,
                    &[
                        &show_item,
                        &hide_item,
                        &next_wallpaper_item,
                        &debug_wallpaper_item,
                        &popup_wallpaper_item,
                        &popup_wallpaper_detach_item,
                        &quit_item,
                    ],
                ) {
                    Ok(menu) => menu,
                    Err(e) => {
                        eprintln!("创建菜单失败: {}", e);
                        return;
                    }
                };

                // 创建托盘图标
                let icon = match handle.default_window_icon() {
                    Some(icon) => icon.clone(),
                    None => {
                        eprintln!("无法获取默认图标");
                        return;
                    }
                };

                let handle_clone1 = handle.clone();
                let handle_clone2 = handle.clone();
                let _tray = match TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .tooltip("Kabegami")
                    .on_menu_event(move |_tray, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) =
                                    handle_clone1.webview_windows().values().next()
                                {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "hide" => {
                                if let Some(window) =
                                    handle_clone1.webview_windows().values().next()
                                {
                                    let _ = window.hide();
                                }
                            }
                            "quit" => {
                                // 优雅地退出应用
                                handle_clone1.exit(0);
                            }
                            "next_wallpaper" => {
                                // 后台切换下一张壁纸，避免阻塞托盘事件线程
                                let app_handle = handle_clone1.clone();
                                std::thread::spawn(move || {
                                    use tauri::Manager;
                                    let rotator = app_handle.state::<WallpaperRotator>();
                                    if let Err(e) = rotator.rotate_once_now() {
                                        eprintln!("托盘切换下一张壁纸失败: {}", e);
                                    }
                                });
                            }
                            "debug_wallpaper" => {
                                // 打开一个普通可见窗口（不挂到桌面层），用于确认 WallpaperLayer 是否在渲染/收事件
                                let app_handle = handle_clone1.clone();
                                std::thread::spawn(move || {
                                    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

                                    if let Some(w) =
                                        app_handle.get_webview_window("wallpaper_debug")
                                    {
                                        let _ = w.show();
                                        let _ = w.set_focus();
                                        return;
                                    }

                                    let _ = WebviewWindowBuilder::new(
                                        &app_handle,
                                        "wallpaper_debug",
                                        WebviewUrl::App("index.html".into()),
                                    )
                                    .title("Kabegami Wallpaper Debug")
                                    .resizable(true)
                                    .decorations(true)
                                    .transparent(false)
                                    .visible(true)
                                    .skip_taskbar(false)
                                    .inner_size(900.0, 600.0)
                                    .build();
                                });
                            }
                            "popup_wallpaper" => {
                                // 临时把 wallpaper 窗口弹出到前台 3 秒，用于确认 wallpaper 窗口实际是否在渲染 WallpaperLayer
                                let app_handle = handle_clone1.clone();
                                std::thread::spawn(move || {
                                    use tauri::Manager;
                                    if let Some(w) = app_handle.get_webview_window("wallpaper") {
                                        // 兜底推送一次当前壁纸到 wallpaper webview，避免因为窗口模式挂载失败导致窗口内容空白
                                        let rotator = app_handle.state::<WallpaperRotator>();
                                        let _ = rotator.debug_push_current_to_wallpaper_windows();

                                        let _ = w.show();
                                        let _ = w.set_always_on_top(true);
                                        let _ = w.set_focus();
                                        std::thread::sleep(std::time::Duration::from_secs(3));
                                        let _ = w.set_always_on_top(false);
                                        // 调试弹出结束后自动隐藏，避免“看起来一直在最上层”造成误解
                                        let _ = w.hide();
                                    } else {
                                        eprintln!("wallpaper 窗口不存在，无法弹出");
                                    }
                                });
                            }
                            "popup_wallpaper_detach" => {
                                // 关键调试：把 wallpaper 窗口从桌面层临时脱离，作为普通窗口弹出 3 秒，再挂回桌面层
                                // 用于确认“窗口渲染没问题，问题只在挂载层级/可见性”。
                                let app_handle = handle_clone1.clone();
                                std::thread::spawn(move || {
                                    use tauri::Manager;
                                    if let Some(w) = app_handle.get_webview_window("wallpaper") {
                                        // 兜底推送一次当前壁纸到 wallpaper webview，避免因为窗口模式挂载失败导致窗口内容空白
                                        let rotator = app_handle.state::<WallpaperRotator>();
                                        let _ = rotator.debug_push_current_to_wallpaper_windows();

                                        #[cfg(target_os = "windows")]
                                        {
                                            if let Err(e) =
                                                WallpaperWindow::debug_detach_popup_3s(&w)
                                            {
                                                eprintln!("调试脱离桌面层弹出失败: {}", e);
                                            }
                                        }
                                        #[cfg(not(target_os = "windows"))]
                                        {
                                            eprintln!("popup_wallpaper_detach 仅支持 Windows");
                                        }
                                    } else {
                                        eprintln!("wallpaper 窗口不存在，无法调试脱离弹出");
                                    }
                                });
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(move |_tray, event| {
                        // 在 Windows 上，右键点击会自动显示菜单，不需要额外处理
                        // 左键点击可以切换窗口显示/隐藏
                        if let TrayIconEvent::Click { button, .. } = event {
                            // 只在左键点击时切换窗口，右键点击会由系统自动显示菜单
                            if button == MouseButton::Left {
                                if let Some(window) =
                                    handle_clone2.webview_windows().values().next()
                                {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = window.hide();
                                    } else {
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                }
                            }
                            // 右键点击（MouseButton::Right）会由系统自动显示菜单，不需要处理
                        }
                    })
                    .build(&handle)
                {
                    Ok(tray) => tray,
                    Err(e) => {
                        eprintln!("创建系统托盘失败: {}", e);
                        return;
                    }
                };
            });

            // 处理窗口关闭事件 - 隐藏而不是退出
            // 延迟处理，确保窗口已经创建
            let handle_clone = app.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                if let Some(window) = handle_clone.webview_windows().values().next() {
                    let window_clone = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = window_clone.hide();
                        }
                    });
                }
            });

            // 如果设置中启用了轮播，启动轮播服务
            let settings = app.state::<Settings>();
            if let Ok(app_settings) = settings.get_settings() {
                if app_settings.wallpaper_rotation_enabled {
                    let rotator = app.state::<WallpaperRotator>();
                    if let Err(e) = rotator.start() {
                        eprintln!("启动壁纸轮播失败: {}", e);
                    }
                }
            }

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
            set_wallpaper_rotation_style,
            set_wallpaper_rotation_transition,
            set_wallpaper_mode,
            get_wallpaper_rotator_status,
            wallpaper_window_ready,
            // Wallpaper Engine 导出
            export_album_to_we_project,
            export_images_to_we_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
