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
mod runtime_flags;
mod settings;
mod storage;
mod tray;
mod wallpaper;
mod wallpaper_engine_export;

use crawler::{crawl_images, ActiveDownloadInfo, CrawlResult};
use dirs;
use plugin::{
    BrowserPlugin, ImportPreview, Plugin, PluginDetail, PluginManager, PluginSource,
    StorePluginResolved, StoreSourceValidationResult,
};
use runtime_flags::{ForceDedupeStartResult, RuntimeFlags};
use settings::{AppSettings, Settings, WindowState};
use std::fs;
use std::path::PathBuf;
use storage::{Album, ImageInfo, PaginatedImages, RunConfig, Storage, TaskInfo};
#[cfg(target_os = "windows")]
use wallpaper::manager::GdiWallpaperManager;
use wallpaper::{WallpaperController, WallpaperRotator, WallpaperWindow};
use wallpaper_engine_export::{export_album_to_we_project, export_images_to_we_project};

#[tauri::command]
fn get_plugins(state: tauri::State<PluginManager>) -> Result<Vec<Plugin>, String> {
    state.get_all()
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

    // 获取设置，检查是否启用自动去重
    let settings_state = app.state::<Settings>();
    let auto_deduplicate = settings_state
        .get_settings()
        .ok()
        .map(|s| s.auto_deduplicate)
        .unwrap_or(false);

    // 运行时强制去重（手动去重期间无视设置）
    let force_deduplicate = app
        .try_state::<RuntimeFlags>()
        .map(|f| f.force_deduplicate())
        .unwrap_or(false);

    // 保存图片元数据到全局 store，关联 task_id
    for img_data in &result.images {
        let hash =
            compute_file_hash(std::path::Path::new(&img_data.local_path)).unwrap_or_else(|e| {
                eprintln!("[WARN] 计算文件哈希失败: {} - {}", img_data.local_path, e);
                String::new()
            });

        // 自动/强制去重：检查哈希是否已存在
        if auto_deduplicate || force_deduplicate {
            if !hash.is_empty() {
                if let Ok(Some(_existing)) = storage.find_image_by_hash(&hash) {
                    // 哈希已存在，跳过添加
                    eprintln!("[INFO] 跳过重复图片（哈希已存在）: {}", img_data.local_path);
                    continue;
                }
            } else {
                // 哈希计算失败，尝试通过文件路径检查是否已存在
                if let Ok(Some(_existing)) = storage.find_image_by_path(&img_data.local_path) {
                    eprintln!("[INFO] 跳过重复图片（路径已存在）: {}", img_data.local_path);
                    continue;
                }
            }
        }

        let crawled_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let image_info = ImageInfo {
            id: uuid::Uuid::new_v4().to_string(),
            url: img_data.url.clone(),
            local_path: img_data.local_path.clone(),
            plugin_id: plugin_id.clone(),
            task_id: Some(task_id.clone()),
            crawled_at,
            metadata: img_data.metadata.clone(),
            thumbnail_path: if img_data.thumbnail_path.trim().is_empty() {
                img_data.local_path.clone()
            } else {
                img_data.thumbnail_path.clone()
            },
            favorite: false,
            hash,
            order: Some(crawled_at as i64), // 默认 order = crawled_at（越晚越大）
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
    favorites_only: Option<bool>,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_images_paginated(page, page_size, plugin_id.as_deref(), favorites_only)
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
fn rename_album(
    album_id: String,
    new_name: String,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    state.rename_album(&album_id, &new_name)
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
fn remove_images_from_album(
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
) -> Result<usize, String> {
    state.remove_images_from_album(&album_id, &image_ids)
}

#[tauri::command]
fn get_album_images(
    album_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<ImageInfo>, String> {
    state.get_album_images(&album_id)
}

#[tauri::command]
fn get_album_image_ids(
    album_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<String>, String> {
    state.get_album_image_ids(&album_id)
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

#[tauri::command]
fn update_images_order(
    image_orders: Vec<(String, i64)>,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    state.update_images_order(&image_orders)
}

#[tauri::command]
fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    state.update_album_images_order(&album_id, &image_orders)
}

#[tauri::command]
fn update_albums_order(
    album_orders: Vec<(String, i64)>,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    state.update_albums_order(&album_orders)
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
fn remove_image(image_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.remove_image(&image_id)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DedupeGalleryResult {
    removed: usize,
    removed_ids: Vec<String>,
}

/// 对画廊按 hash 去重：保留一条记录，其余仅从画廊移除（不删除原图文件）
#[tauri::command]
fn dedupe_gallery_by_hash(state: tauri::State<Storage>) -> Result<DedupeGalleryResult, String> {
    let res = state.dedupe_gallery_by_hash_remove_only()?;
    Ok(DedupeGalleryResult {
        removed: res.removed,
        removed_ids: res.removed_ids,
    })
}

/// 开启“强制去重模式”。若当前有下载任务在跑，则会保持到下载队列空闲时自动关闭并通知前端。
#[tauri::command]
fn start_force_deduplicate(
    flags: tauri::State<RuntimeFlags>,
    download_queue: tauri::State<crawler::DownloadQueue>,
) -> Result<ForceDedupeStartResult, String> {
    // 先开启
    flags.set_force_deduplicate(true);
    flags.set_force_deduplicate_wait_until_idle(true);

    // 判断是否需要等待下载结束
    let queue_size = download_queue.get_queue_size().unwrap_or(0);
    let active = download_queue
        .get_active_downloads()
        .map(|v| v.len())
        .unwrap_or(0);
    let will_wait = queue_size > 0 || active > 0;

    // 如果当前没有任何下载，直接关闭等待（也避免前端卡 loading）
    if !will_wait {
        flags.set_force_deduplicate(false);
        flags.set_force_deduplicate_wait_until_idle(false);
    }

    Ok(ForceDedupeStartResult {
        will_wait_until_downloads_end: will_wait,
    })
}

/// 主动关闭“强制去重模式”（兜底/调试用）
#[tauri::command]
fn stop_force_deduplicate(flags: tauri::State<RuntimeFlags>) -> Result<(), String> {
    flags.set_force_deduplicate(false);
    flags.set_force_deduplicate_wait_until_idle(false);
    Ok(())
}

// 获取应用数据目录路径
fn get_app_data_dir_for_clear() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join("Kabegame")
}

// 清理应用数据（仅用户数据，不包括应用本身）
#[tauri::command]
async fn clear_user_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir_for_clear();

    if !app_data_dir.exists() {
        return Ok(()); // 目录不存在，无需清理
    }

    // 清除窗口状态（清理数据时不保存窗口位置）
    if let Some(settings_state) = app.try_state::<Settings>() {
        let _ = settings_state.clear_window_state();
    }

    // 方案：创建清理标记文件，在应用重启后清理
    // 这样可以避免删除正在使用的文件
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    fs::write(&cleanup_marker, "1")
        .map_err(|e| format!("Failed to create cleanup marker: {}", e))?;

    // 延迟重启，确保响应已发送
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        app.restart();
    });

    Ok(())
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

/// 获取当前正在使用的壁纸路径（与当前 wallpaper_mode 对应）
///
/// - 返回 `None` 表示当前后端没有记录壁纸（例如从未设置过 window/gdi 壁纸）
/// - 返回 `Some(path)` 表示当前后端记录的壁纸路径（不保证文件一定存在）
#[tauri::command]
fn get_current_wallpaper_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let controller = app.state::<WallpaperController>();
    let manager = match controller.active_manager() {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    match manager.get_wallpaper_path() {
        Ok(p) => Ok(Some(p)),
        Err(_) => Ok(None),
    }
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
fn get_plugin_sources(state: tauri::State<PluginManager>) -> Result<Vec<PluginSource>, String> {
    state.load_plugin_sources()
}

#[tauri::command]
fn save_plugin_sources(
    sources: Vec<PluginSource>,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.save_plugin_sources(&sources)
}

#[tauri::command]
async fn get_store_plugins(
    source_id: Option<String>,
    state: tauri::State<'_, PluginManager>,
) -> Result<Vec<StorePluginResolved>, String> {
    state.fetch_store_plugins(source_id.as_deref()).await
}

/// 统一的“源详情”加载：
/// - 本地已安装：从 plugins_directory 下的 .kgpg 读取
/// - 商店/官方源：根据 downloadUrl 远程下载到内存并解析（带缓存）
#[tauri::command]
async fn get_plugin_detail(
    plugin_id: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    state: tauri::State<'_, PluginManager>,
) -> Result<PluginDetail, String> {
    match download_url {
        Some(url) => {
            state
                .load_remote_plugin_detail(&plugin_id, &url, sha256.as_deref(), size_bytes)
                .await
        }
        None => state.load_installed_plugin_detail(&plugin_id),
    }
}

#[tauri::command]
async fn validate_plugin_source(
    index_url: String,
    state: tauri::State<'_, PluginManager>,
) -> Result<StoreSourceValidationResult, String> {
    state.validate_store_source_index(&index_url).await
}

#[tauri::command]
fn preview_import_plugin(
    zip_path: String,
    state: tauri::State<PluginManager>,
) -> Result<ImportPreview, String> {
    let path = std::path::PathBuf::from(zip_path);
    state.preview_import_from_zip(&path)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreInstallPreview {
    tmp_path: String,
    preview: ImportPreview,
}

/// 商店安装/更新：先下载到临时文件并做预览（版本变更/变更日志），由前端确认后再调用 import_plugin_from_zip 安装
#[tauri::command]
async fn preview_store_install(
    download_url: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    state: tauri::State<'_, PluginManager>,
) -> Result<StoreInstallPreview, String> {
    let tmp = state
        .download_plugin_to_temp(&download_url, sha256.as_deref(), size_bytes)
        .await?;
    let preview = state.preview_import_from_zip(&tmp)?;
    Ok(StoreInstallPreview {
        tmp_path: tmp.to_string_lossy().to_string(),
        preview,
    })
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
fn update_plugins_order(
    plugin_orders: Vec<(String, i64)>,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.update_plugins_order(&plugin_orders)
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
            let file_name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if file_name == plugin_id {
                return state.read_plugin_image(&path, &image_path);
            }
        }
    }

    Err(format!("Plugin {} not found", plugin_id))
}

/// 详情页渲染文档图片用：本地已安装/远程商店源统一入口
#[tauri::command]
async fn get_plugin_image_for_detail(
    plugin_id: String,
    image_path: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    state: tauri::State<'_, PluginManager>,
) -> Result<Vec<u8>, String> {
    state
        .load_plugin_image_for_detail(
            &plugin_id,
            download_url.as_deref(),
            sha256.as_deref(),
            size_bytes,
            &image_path,
        )
        .await
}

#[tauri::command]
async fn get_plugin_icon(
    plugin_id: String,
    state: tauri::State<'_, PluginManager>,
) -> Result<Option<Vec<u8>>, String> {
    // 找到插件文件（仅使用 file_name 作为 ID）
    let plugins_dir = state.get_plugins_directory();
    let entries = std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            let file_name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if file_name == plugin_id {
                return state.read_plugin_icon(&path);
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
fn set_restore_last_tab(enabled: bool, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_restore_last_tab(enabled)
}

#[tauri::command]
fn set_last_tab_path(path: Option<String>, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_last_tab_path(path)
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
fn set_auto_deduplicate(enabled: bool, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_auto_deduplicate(enabled)
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

/// 清空所有“等待队列”（不影响正在下载）
#[tauri::command]
fn clear_download_queue(app: tauri::AppHandle) -> Result<usize, String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.clear_queue()
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

    // 注意：此命令只负责“开关落盘/停播清理”，不负责启动轮播线程。
    // 轮播线程仅在“设置轮播画册ID”（或回落到画廊轮播）时启动，避免在未选择来源时启动后立刻退出/假死。
    if !enabled {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RotationStartResult {
    started: bool,
    source: String,           // "album" | "gallery"
    album_id: Option<String>, // source=album 时为 Some(id)，source=gallery 时为 Some("")（保留设置值）
}

#[tauri::command]
fn set_wallpaper_rotation_album_id(
    album_id: Option<String>,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 约定：
    // - Some(non-empty) => 轮播指定画册
    // - Some("")        => 轮播整个画廊（从当前壁纸开始）
    // - None            => 清空来源并停止轮播线程
    let normalized = album_id.map(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            "".to_string()
        } else {
            t
        }
    });

    state.set_wallpaper_rotation_album_id(normalized.clone())?;

    // 清空来源：停止线程（但不更改 enabled 开关）
    if normalized.is_none() {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
        return Ok(());
    }

    // 仅当“轮播已启用”时才尝试启动线程
    let settings = state.get_settings()?;
    if settings.wallpaper_rotation_enabled {
        let rotator = app.state::<WallpaperRotator>();
        let was_running = rotator.is_running();
        // 当选择为画廊轮播（空字符串）时：从当前壁纸开始
        let start_from_current = settings
            .wallpaper_rotation_album_id
            .as_deref()
            .map(|s| s.is_empty())
            .unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .map_err(|e| format!("启动轮播失败: {}", e))?;

        // 关键：如果轮播线程本来就在运行，用户“切换轮播来源/画册”应当立即切换一次，
        // 而不是等到下一次 interval 才切换。
        // - 仅在 was_running=true 时触发，避免“未运行 -> ensure_running 已经设置起始壁纸”时又额外切一次。
        if was_running {
            rotator
                .rotate()
                .map_err(|e| format!("立即切换失败: {}", e))?;
        }
    }

    Ok(())
}

/// 启动轮播（仅当 wallpaper_rotation_enabled=true）
///
/// - 若设置里保存了上次画册ID：优先尝试用画册轮播
/// - 若失败或未保存：回落到“画廊轮播”（album_id = ""），并从当前壁纸开始
#[tauri::command]
fn start_wallpaper_rotation(
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<RotationStartResult, String> {
    let settings = state.get_settings()?;
    if !settings.wallpaper_rotation_enabled {
        return Err("壁纸轮播未启用".to_string());
    }

    let rotator = app.state::<WallpaperRotator>();

    // 1) 优先尝试：如果保存了“上次画册ID”且非空，则先用画册轮播
    if let Some(saved) = settings.wallpaper_rotation_album_id.clone() {
        if !saved.trim().is_empty() {
            // 先不改设置，直接按当前设置尝试启动
            match rotator.ensure_running(false) {
                Ok(_) => {
                    return Ok(RotationStartResult {
                        started: true,
                        source: "album".to_string(),
                        album_id: Some(saved),
                    });
                }
                Err(e) => {
                    eprintln!(
                        "[WARN] start_wallpaper_rotation: saved album_id failed, fallback to gallery. err={}",
                        e
                    );
                }
            }
        }
    }

    // 2) 回落到画廊轮播：写入 album_id="" 并启动（从当前壁纸开始）
    state.set_wallpaper_rotation_album_id(Some("".to_string()))?;
    rotator.ensure_running(true)?;

    Ok(RotationStartResult {
        started: true,
        source: "gallery".to_string(),
        album_id: Some("".to_string()),
    })
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
            eprintln!("[DEBUG] set_wallpaper_mode: 开始应用模式 {}", mode_clone);
            // 关键：确保目标后端已初始化（尤其是 window 模式需要提前把 WallpaperWindow 放进 manager 状态）
            // 否则会报 “窗口未初始化，请先调用 init 方法”，前端就会一直显示“切换中”。
            eprintln!("[DEBUG] set_wallpaper_mode: 调用 target.init");
            target.init(app_clone.clone())?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.init 完成");
            // 先切换壁纸路径
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_wallpaper_path: {}",
                resolved_wallpaper
            );
            target.set_wallpaper_path(&resolved_wallpaper, true)?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_wallpaper_path 完成");
            // 再应用样式
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_style: {}",
                s.wallpaper_rotation_style
            );
            target.set_style(&s.wallpaper_rotation_style, true)?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_style 完成");
            // 过渡效果属于轮播能力：只在轮播启用时做立即预览
            if s.wallpaper_rotation_enabled {
                // 最后应用transition
                eprintln!(
                    "[DEBUG] set_wallpaper_mode: 调用 target.set_transition: {}",
                    s.wallpaper_rotation_transition
                );
                target.set_transition(&s.wallpaper_rotation_transition, true)?;
                eprintln!("[DEBUG] set_wallpaper_mode: target.set_transition 完成");
            }
            eprintln!("[DEBUG] set_wallpaper_mode: 应用模式完成");
            Ok(())
        })();

        match apply_res {
            Ok(_) => {
                eprintln!("[DEBUG] set_wallpaper_mode: apply_res 成功");
                // 切换 away from window 模式时，清理 window 后端（隐藏壁纸窗口）
                if old_mode_clone == "window" && mode_clone != "window" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 清理 window 资源");
                    controller
                        .manager_for_mode("window")
                        .cleanup()
                        .unwrap_or_else(|e| eprintln!("清理 window 资源失败: {}", e));
                }
                // 切换 away from gdi 模式时，清理 gdi 后端（销毁 GDI 窗口）
                // 注意：cleanup 可能阻塞（等待线程退出），但我们需要确保清理完成
                // 所以仍然同步执行，但会在日志中显示进度
                if old_mode_clone == "gdi" && mode_clone != "gdi" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 开始清理 gdi 资源（从 gdi 模式切换到其他模式）");
                    match controller.manager_for_mode("gdi").cleanup() {
                        Ok(_) => eprintln!("[DEBUG] set_wallpaper_mode: gdi 资源清理成功"),
                        Err(e) => eprintln!("[ERROR] 清理 gdi 资源失败: {}", e),
                    }
                }
                // 3) 应用成功后再持久化 mode
                eprintln!("[DEBUG] set_wallpaper_mode: 保存模式设置");
                if let Err(e) = settings_state.set_wallpaper_mode(mode_clone.clone()) {
                    eprintln!("[ERROR] set_wallpaper_mode: 保存模式失败: {}", e);
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
                eprintln!("[DEBUG] set_wallpaper_mode: 模式设置已保存");

                // 4) 轮播开启时重置定时器（切换模式也算一次“用户触发”）
                if s.wallpaper_rotation_enabled {
                    eprintln!("[DEBUG] set_wallpaper_mode: 恢复轮播");
                    // 切换完成后再恢复轮播（若之前在跑或用户开启了轮播）
                    // 这里用 start 确保轮播线程按新 mode 工作
                    let _ = rotator.start();
                }

                eprintln!("[DEBUG] set_wallpaper_mode: 发送成功事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": true,
                        "mode": mode_clone
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 成功事件已发送");
            }
            Err(e) => {
                eprintln!("[ERROR] 切换到 {} 模式失败: {}", mode_clone, e);
                // 失败时恢复轮播（如果之前在运行）
                if was_running {
                    let _ = rotator.start();
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 发送失败事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("切换模式失败: {}", e)
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 失败事件已发送");
            }
        };
    });
    // 立即返回，不等待后台线程完成
    // 前端会通过事件来获知切换结果
    Ok(())
}

#[tauri::command]
fn get_wallpaper_rotator_status(app: tauri::AppHandle) -> Result<String, String> {
    let rotator = app.state::<WallpaperRotator>();
    Ok(rotator.get_status())
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
        // 在隐藏窗口前保存窗口状态
        if window.label() == "main" {
            let position = window.outer_position().ok();
            let size = window.outer_size().ok();
            let maximized = window.is_maximized().unwrap_or(false);

            if let (Some(pos), Some(sz)) = (position, size) {
                let window_state = WindowState {
                    x: if maximized { None } else { Some(pos.x as f64) },
                    y: if maximized { None } else { Some(pos.y as f64) },
                    width: sz.width as f64,
                    height: sz.height as f64,
                    maximized,
                };

                // 保存窗口状态
                if let Some(settings_state) = app.try_state::<Settings>() {
                    if let Err(e) = settings_state.save_window_state(window_state) {
                        eprintln!("保存窗口状态失败: {}", e);
                    }
                }
            }
        }

        window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;
    } else {
        return Err("找不到主窗口".to_string());
    }
    Ok(())
}

/// 测试 GDI 壁纸窗口（仅用于测试）
#[tauri::command]
#[cfg(target_os = "windows")]
fn test_gdi_wallpaper(
    image_path: String,
    style: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::wallpaper::manager::WallpaperManager;
    use std::sync::Arc;
    use std::sync::OnceLock;

    // 全局单例，用于测试（实际应用中应该由 WallpaperController 管理）
    static GDI_MANAGER: OnceLock<Arc<GdiWallpaperManager>> = OnceLock::new();
    let gdi_manager = GDI_MANAGER.get_or_init(|| Arc::new(GdiWallpaperManager::new(app.clone())));

    // 初始化管理器
    gdi_manager
        .init(app.clone())
        .map_err(|e| format!("初始化 GDI 管理器失败: {}", e))?;

    // 设置图片
    let style_str = style.unwrap_or_else(|| "fill".to_string());
    gdi_manager
        .set_wallpaper(&image_path, &style_str, "none")
        .map_err(|e| format!("设置壁纸失败: {}", e))?;

    println!(
        "[TEST] GDI 壁纸管理器已设置图片: {}, 样式: {}",
        image_path, style_str
    );

    Ok(format!(
        "GDI 壁纸管理器测试成功！图片: {}, 样式: {}",
        image_path, style_str
    ))
}

/// 壁纸窗口前端 ready 后调用，用于触发一次"推送当前壁纸到壁纸窗口"。
/// 解决壁纸窗口尚未注册事件监听时，后端先 emit 导致事件丢失的问题。
#[tauri::command]
#[cfg(target_os = "windows")]
fn wallpaper_window_ready(_app: tauri::AppHandle) -> Result<(), String> {
    // 标记窗口已完全初始化
    println!("壁纸窗口已就绪");
    WallpaperWindow::mark_ready();
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
            // 检查清理标记，如果存在则先清理旧数据目录
            let app_data_dir = get_app_data_dir_for_clear();
            let cleanup_marker = app_data_dir.join(".cleanup_marker");
            let is_cleaning_data = cleanup_marker.exists();
            if is_cleaning_data {
                // 删除标记文件
                let _ = fs::remove_file(&cleanup_marker);
                // 尝试删除整个数据目录
                if app_data_dir.exists() {
                    // 使用多次重试，因为文件可能还在被其他进程使用
                    let mut retries = 5;
                    while retries > 0 {
                        match fs::remove_dir_all(&app_data_dir) {
                            Ok(_) => {
                                println!("成功清理应用数据目录");
                                break;
                            }
                            Err(e) => {
                                retries -= 1;
                                if retries == 0 {
                                    eprintln!(
                                        "警告：无法完全清理数据目录，部分文件可能仍在使用中: {}",
                                        e
                                    );
                                    // 尝试删除单个文件而不是整个目录
                                    // 至少删除数据库和设置文件
                                    let _ = fs::remove_file(app_data_dir.join("images.db"));
                                    let _ = fs::remove_file(app_data_dir.join("settings.json"));
                                    let _ = fs::remove_file(app_data_dir.join("plugins.json"));
                                } else {
                                    // 等待一段时间后重试
                                    std::thread::sleep(std::time::Duration::from_millis(200));
                                }
                            }
                        }
                    }
                }
            }

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

            // 运行时开关（不落盘）
            app.manage(RuntimeFlags::default());

            // 恢复窗口状态（如果不在清理数据模式）
            if !is_cleaning_data {
                if let Some(main_window) = app.get_webview_window("main") {
                    let settings = app.state::<Settings>();
                    if let Ok(Some(window_state)) = settings.get_window_state() {
                        // 恢复窗口大小
                        if let Err(e) = main_window.set_size(tauri::LogicalSize::new(
                            window_state.width,
                            window_state.height,
                        )) {
                            eprintln!("恢复窗口大小失败: {}", e);
                        }
                        // 恢复窗口位置
                        if let (Some(x), Some(y)) = (window_state.x, window_state.y) {
                            if let Err(e) =
                                main_window.set_position(tauri::LogicalPosition::new(x, y))
                            {
                                eprintln!("恢复窗口位置失败: {}", e);
                            }
                        }
                        // 恢复最大化状态
                        if window_state.maximized {
                            if let Err(e) = main_window.maximize() {
                                eprintln!("恢复窗口最大化状态失败: {}", e);
                            }
                        }
                    }
                }
            }

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
                .title("Kabegame Wallpaper")
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
            update_plugin,
            delete_plugin,
            crawl_images_command,
            get_images,
            get_images_paginated,
            get_albums,
            add_album,
            delete_album,
            rename_album,
            add_images_to_album,
            remove_images_from_album,
            get_album_images,
            get_album_image_ids,
            get_album_preview,
            get_album_counts,
            get_images_count,
            delete_image,
            remove_image,
            dedupe_gallery_by_hash,
            start_force_deduplicate,
            stop_force_deduplicate,
            toggle_image_favorite,
            update_images_order,
            update_album_images_order,
            update_albums_order,
            open_file_path,
            open_file_folder,
            set_wallpaper,
            get_current_wallpaper_path,
            test_gdi_wallpaper,
            migrate_images_from_json,
            get_browser_plugins,
            get_plugin_sources,
            save_plugin_sources,
            get_store_plugins,
            get_plugin_detail,
            validate_plugin_source,
            preview_import_plugin,
            preview_store_install,
            import_plugin_from_zip,
            install_browser_plugin,
            update_plugins_order,
            get_plugin_image,
            get_plugin_image_for_detail,
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
            set_auto_deduplicate,
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
            clear_download_queue,
            copy_files_to_clipboard,
            set_wallpaper_rotation_enabled,
            set_wallpaper_rotation_album_id,
            start_wallpaper_rotation,
            set_wallpaper_rotation_interval_minutes,
            set_wallpaper_rotation_mode,
            set_wallpaper_style,
            set_wallpaper_rotation_transition,
            set_wallpaper_mode,
            set_restore_last_tab,
            set_last_tab_path,
            set_restore_last_tab,
            set_last_tab_path,
            get_wallpaper_rotator_status,
            get_native_wallpaper_styles,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            hide_main_window,
            // Wallpaper Engine 导出
            export_album_to_we_project,
            export_images_to_we_project,
            clear_user_data,
        ])
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            // 监听窗口关闭事件，保存窗口状态
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    // 获取窗口状态
                    let position = window.outer_position().ok();
                    let size = window.outer_size().ok();
                    let maximized = window.is_maximized().unwrap_or(false);

                    if let (Some(pos), Some(sz)) = (position, size) {
                        // 如果窗口是最大化的，保存最大化前的状态
                        let window_state = WindowState {
                            x: if maximized { None } else { Some(pos.x as f64) },
                            y: if maximized { None } else { Some(pos.y as f64) },
                            width: sz.width as f64,
                            height: sz.height as f64,
                            maximized,
                        };

                        // 保存窗口状态
                        if let Some(settings_state) = window.app_handle().try_state::<Settings>() {
                            if let Err(e) = settings_state.save_window_state(window_state) {
                                eprintln!("保存窗口状态失败: {}", e);
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
