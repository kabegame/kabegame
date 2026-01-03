// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::Shell::DROPFILES,
    UI::WindowsAndMessaging::GetSystemMetrics,
};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

mod app_paths;
mod crawler;
mod plugin;
mod settings;
mod storage;
mod tray;
mod wallpaper;
mod wallpaper_engine_export;

use crawler::{crawl_images, ActiveDownloadInfo, CrawlResult};
use plugin::{
    BrowserPlugin, ImportPreview, Plugin, PluginDetail, PluginManager, PluginSource,
    StorePluginResolved, StoreSourceValidationResult,
};
use settings::{AppSettings, Settings, WindowState};
use std::fs;
use storage::{AddToAlbumResult, Album, ImageInfo, PaginatedImages, RunConfig, Storage, TaskInfo};
use wallpaper::{WallpaperController, WallpaperRotator, WallpaperWindow};
use wallpaper_engine_export::{export_album_to_we_project, export_images_to_we_project};

fn get_current_wallpaper_path_from_settings(app: &tauri::AppHandle) -> Option<String> {
    let settings = app.try_state::<Settings>()?.get_settings().ok()?;
    let id = settings.current_wallpaper_image_id?;
    let storage = app.try_state::<Storage>()?;
    storage
        .find_image_by_id(&id)
        .ok()
        .flatten()
        .map(|img| img.local_path)
}

fn choose_fallback_image_id(images: &[ImageInfo], mode: &str) -> Option<String> {
    if images.is_empty() {
        return None;
    }
    match mode {
        "random" => {
            let idx = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as usize)
                % images.len();
            Some(images[idx].id.clone())
        }
        _ => {
            // sequential: 取“第一张”（storage.get_album_images / get_all_images 已按 order 排序）
            Some(images[0].id.clone())
        }
    }
}

/// 启动时初始化“当前壁纸”并按规则回退/降级
///
/// 规则（按用户需求）：
/// - 非轮播：尝试设置 currentWallpaperImageId；失败则清空并停止
/// - 轮播：优先在轮播源中找到 currentWallpaperImageId；找不到则回退到轮播源的一张；源无可用则画册->画廊->关闭轮播并清空
fn init_wallpaper_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    let settings_state = app.state::<Settings>();
    let storage = app.state::<Storage>();
    let controller = app.state::<WallpaperController>();

    let mut settings = settings_state.get_settings()?;

    // 约定兼容：轮播启用但未配置来源（None） => 默认当作“画廊轮播”
    if settings.wallpaper_rotation_enabled && settings.wallpaper_rotation_album_id.is_none() {
        settings_state.set_wallpaper_rotation_album_id(Some("".to_string()))?;
        settings = settings_state.get_settings()?;
    }

    let cur_id = settings.current_wallpaper_image_id.clone();

    // 非轮播：只尝试还原当前壁纸
    if !settings.wallpaper_rotation_enabled {
        let Some(id) = cur_id else {
            return Ok(());
        };
        let image = storage
            .find_image_by_id(&id)?
            .ok_or_else(|| "当前壁纸记录不存在".to_string())?;
        if !Path::new(&image.local_path).exists() {
            settings_state.set_current_wallpaper_image_id(None)?;
            return Ok(());
        }
        if controller
            .set_wallpaper(&image.local_path, &settings.wallpaper_rotation_style)
            .is_err()
        {
            settings_state.set_current_wallpaper_image_id(None)?;
        }
        return Ok(());
    }

    // 轮播：从源里找 current；否则选源里一张；源无图则回退源/降级
    let mut source_album_id = settings.wallpaper_rotation_album_id.clone();
    let mut images: Vec<ImageInfo> = match source_album_id.as_deref() {
        Some(id) if !id.trim().is_empty() => storage.get_album_images(id).unwrap_or_default(),
        _ => storage.get_all_images().unwrap_or_default(),
    };

    // 若画册无图：回退到画廊
    if images.is_empty()
        && source_album_id
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    {
        source_album_id = Some("".to_string());
        settings_state.set_wallpaper_rotation_album_id(source_album_id.clone())?;
        settings = settings_state.get_settings()?;
        images = storage.get_all_images().unwrap_or_default();
    }

    // 若画廊也无图：降级到非轮播并清空
    if images.is_empty() {
        settings_state.set_wallpaper_rotation_enabled(false)?;
        settings_state.set_wallpaper_rotation_album_id(None)?;
        settings_state.set_current_wallpaper_image_id(None)?;
        return Ok(());
    }

    // 优先：源里能找到 currentWallpaperImageId
    let mut target_id: Option<String> = None;
    if let Some(id) = cur_id.clone() {
        if images.iter().any(|img| img.id == id) {
            target_id = Some(id);
        }
    }
    if target_id.is_none() {
        target_id = choose_fallback_image_id(&images, &settings.wallpaper_rotation_mode);
    }

    let Some(chosen_id) = target_id else {
        settings_state.set_current_wallpaper_image_id(None)?;
        return Ok(());
    };

    let image = storage
        .find_image_by_id(&chosen_id)?
        .ok_or_else(|| "选择的壁纸不存在".to_string())?;
    if !Path::new(&image.local_path).exists() {
        // 理论上不会发生（images 已过滤 exists），但兜底：清空并停止
        settings_state.set_current_wallpaper_image_id(None)?;
        return Ok(());
    }

    if controller
        .set_wallpaper(&image.local_path, &settings.wallpaper_rotation_style)
        .is_ok()
    {
        settings_state.set_current_wallpaper_image_id(Some(chosen_id))?;
    } else {
        settings_state.set_current_wallpaper_image_id(None)?;
    }

    Ok(())
}

#[tauri::command]
fn get_plugins(state: tauri::State<PluginManager>) -> Result<Vec<Plugin>, String> {
    state.get_all()
}

#[tauri::command]
fn get_build_mode(state: tauri::State<PluginManager>) -> Result<String, String> {
    Ok(state.build_mode().to_string())
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
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
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
        // 优先使用"默认下载目录"，否则回退到应用内置 images 目录
        match settings_state
            .get_settings()
            .ok()
            .and_then(|s| s.default_download_dir)
        {
            Some(dir) => std::path::PathBuf::from(dir),
            None => storage.get_images_dir(),
        }
    };

    // 使用提供的用户配置
    let final_user_config = user_config.clone();

    let result = crawl_images(
        &plugin,
        &url,
        &task_id,
        images_dir,
        app.clone(),
        final_user_config,
        output_album_id.clone(),
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

    // 注意：图片通过异步下载队列处理，下载完成时会在 crawler/mod.rs 中应用去重逻辑
    // result.images 始终为空（这是特性，不是 bug），因此这里不需要处理图片列表

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
fn get_image_by_id(
    image_id: String,
    state: tauri::State<Storage>,
) -> Result<Option<ImageInfo>, String> {
    state.find_image_by_id(&image_id)
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
) -> Result<storage::AddToAlbumResult, String> {
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

#[tauri::command]
fn get_images_count(
    plugin_id: Option<String>,
    state: tauri::State<Storage>,
) -> Result<usize, String> {
    state.get_total_count(plugin_id.as_deref())
}

#[tauri::command]
fn delete_image(
    image_id: String,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<(), String> {
    state.delete_image(&image_id)?;
    let s = settings.get_settings().unwrap_or_default();
    if s.current_wallpaper_image_id.as_deref() == Some(image_id.as_str()) {
        let _ = settings.set_current_wallpaper_image_id(None);
    }
    Ok(())
}

#[tauri::command]
fn remove_image(
    image_id: String,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<(), String> {
    state.remove_image(&image_id)?;
    let s = settings.get_settings().unwrap_or_default();
    if s.current_wallpaper_image_id.as_deref() == Some(image_id.as_str()) {
        let _ = settings.set_current_wallpaper_image_id(None);
    }
    Ok(())
}

#[tauri::command]
fn batch_delete_images(
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<(), String> {
    state.batch_delete_images(&image_ids)?;
    let s = settings.get_settings().unwrap_or_default();
    if let Some(current_id) = &s.current_wallpaper_image_id {
        if image_ids.contains(current_id) {
            let _ = settings.set_current_wallpaper_image_id(None);
        }
    }
    Ok(())
}

#[tauri::command]
fn batch_remove_images(
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<(), String> {
    state.batch_remove_images(&image_ids)?;
    let s = settings.get_settings().unwrap_or_default();
    if let Some(current_id) = &s.current_wallpaper_image_id {
        if image_ids.contains(current_id) {
            let _ = settings.set_current_wallpaper_image_id(None);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DedupeGalleryResult {
    removed: usize,
    removed_ids: Vec<String>,
}

/// 对画廊按 hash 去重：保留一条记录，其余移除。可选是否删除磁盘原文件。
#[tauri::command]
fn dedupe_gallery_by_hash(
    delete_files: bool,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<DedupeGalleryResult, String> {
    let res = state.dedupe_gallery_by_hash(delete_files)?;
    let s = settings.get_settings().unwrap_or_default();
    if let Some(cur) = s.current_wallpaper_image_id.as_deref() {
        if res.removed_ids.iter().any(|id| id == cur) {
            let _ = settings.set_current_wallpaper_image_id(None);
        }
    }
    Ok(DedupeGalleryResult {
        removed: res.removed,
        removed_ids: res.removed_ids,
    })
}

// 清理应用数据（仅用户数据，不包括应用本身）
#[tauri::command]
async fn clear_user_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = crate::app_paths::kabegame_data_dir();

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

    // 维护全局“当前壁纸”（imageId）
    // - 若能从 DB 根据 local_path 找到 image：写入该 imageId
    // - 否则清空（避免残留旧值）
    if let Some(storage) = app.try_state::<Storage>() {
        if let Ok(found) = storage.find_image_by_path(&abs) {
            let _ = settings_state.set_current_wallpaper_image_id(found.map(|img| img.id));
        }
    }

    Ok(())
}

/// 按 imageId 设置壁纸，并同步更新 settings.currentWallpaperImageId
#[tauri::command]
fn set_wallpaper_by_image_id(image_id: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    let storage = app.state::<Storage>();
    let settings_state = app.state::<Settings>();
    let settings = settings_state.get_settings()?;

    let image = storage
        .find_image_by_id(&image_id)?
        .ok_or_else(|| "图片不存在".to_string())?;

    if !Path::new(&image.local_path).exists() {
        // 图片已被删除/移除/文件丢失：清空 currentWallpaperImageId
        let _ = settings_state.set_current_wallpaper_image_id(None);
        return Err("图片文件不存在".to_string());
    }

    let controller = app.state::<WallpaperController>();
    controller.set_wallpaper(&image.local_path, &settings.wallpaper_rotation_style)?;

    settings_state.set_current_wallpaper_image_id(Some(image_id))?;
    Ok(())
}

#[tauri::command]
fn get_current_wallpaper_image_id(state: tauri::State<Settings>) -> Result<Option<String>, String> {
    let s = state.get_settings()?;
    Ok(s.current_wallpaper_image_id)
}

#[tauri::command]
fn clear_current_wallpaper_image_id(state: tauri::State<Settings>) -> Result<(), String> {
    state.set_current_wallpaper_image_id(None)
}

/// 根据 imageId 取图片本地路径（用于 UI 展示/定位）
#[tauri::command]
fn get_image_local_path_by_id(
    image_id: String,
    state: tauri::State<Storage>,
) -> Result<Option<String>, String> {
    Ok(state.find_image_by_id(&image_id)?.map(|img| img.local_path))
}

/// 获取当前正在使用的壁纸路径（与当前 wallpaper_mode 对应）
///
/// - 返回 `None` 表示当前后端没有记录壁纸（例如从未设置过 window/gdi 壁纸）
/// - 返回 `Some(path)` 表示当前后端记录的壁纸路径（不保证文件一定存在）
#[tauri::command]
fn get_current_wallpaper_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(get_current_wallpaper_path_from_settings(&app))
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
fn get_setting(key: String, state: tauri::State<Settings>) -> Result<serde_json::Value, String> {
    let settings = state.get_settings()?;
    let v = serde_json::to_value(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    v.get(&key)
        .cloned()
        .ok_or_else(|| format!("Unknown setting key: {}", key))
}

#[tauri::command]
fn get_favorite_album_id() -> Result<String, String> {
    Ok(crate::storage::FAVORITE_ALBUM_ID.to_string())
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
fn set_max_concurrent_downloads(
    count: u32,
    state: tauri::State<Settings>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.set_max_concurrent_downloads(count)?;
    // 通知所有等待的任务重新检查并发数设置
    if let Some(download_queue) = app.try_state::<crawler::DownloadQueue>() {
        download_queue.notify_all_waiting();
    }
    Ok(())
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
fn set_gallery_image_aspect_ratio_match_window(
    enabled: bool,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_gallery_image_aspect_ratio_match_window(enabled)
}

#[tauri::command]
fn set_gallery_image_aspect_ratio(
    aspect_ratio: Option<String>,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_gallery_image_aspect_ratio(aspect_ratio)
}

#[tauri::command]
fn get_desktop_resolution() -> Result<(u32, u32), String> {
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
        // 其他平台可以返回默认值或实现相应逻辑
        Ok((1920, 1080))
    }
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
fn delete_task(
    app: tauri::AppHandle,
    task_id: String,
    state: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<(), String> {
    // 如果任务正在运行，先标记为取消，阻止后续入库
    let download_queue = app.state::<crawler::DownloadQueue>();
    let _ = download_queue.cancel_task(&task_id);

    // 先取出该任务关联的图片 id 列表（避免删除后无法判断是否包含“当前壁纸”）
    let ids = state.get_task_image_ids(&task_id).unwrap_or_default();
    state.delete_task(&task_id)?;
    let s = settings.get_settings().unwrap_or_default();
    if let Some(cur) = s.current_wallpaper_image_id.as_deref() {
        if ids.iter().any(|id| id == cur) {
            let _ = settings.set_current_wallpaper_image_id(None);
        }
    }
    Ok(())
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

#[tauri::command]
fn get_task_image_ids(
    task_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<String>, String> {
    state.get_task_image_ids(&task_id)
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
    fallback: bool,           // 是否发生“画册 -> 画廊”的回退
    warning: Option<String>,  // 需要提示给用户的警告（例如回退原因）
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
        // 当选择为画廊轮播（空字符串）时：从当前壁纸开始
        let start_from_current = settings
            .wallpaper_rotation_album_id
            .as_deref()
            .map(|s| s.is_empty())
            .unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .map_err(|e| format!("启动轮播失败: {}", e))?;
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
    let mut did_fallback = false;
    let mut warning: Option<String> = None;

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
                        fallback: false,
                        warning: None,
                    });
                }
                Err(e) => {
                    // 画册为空：直接失败，不回退
                    if e.contains("画册内没有图片") {
                        return Err(e);
                    }
                    // 画册不存在：回退到画廊
                    if e.contains("画册不存在") {
                        eprintln!(
                            "[WARN] start_wallpaper_rotation: saved album_id missing, fallback to gallery. err={}",
                        e
                    );
                        did_fallback = true;
                        warning = Some("上次选择的画册不存在，已回退到画廊轮播".to_string());
                    } else {
                        // 其他错误：不擅自回退，直接失败
                        return Err(e);
                    }
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
        fallback: did_fallback,
        warning,
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
            if let Some(path) = get_current_wallpaper_path_from_settings(&app_clone) {
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
        let current_wallpaper = match get_current_wallpaper_path_from_settings(&app_clone) {
            Some(p) => p,
            None => {
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
        // 先做一次“温和清洗”：去掉 Windows 长路径前缀（\\?\）与前后空格，避免部分 API 返回的格式影响 exists 判断
        let current_cleaned = current_wallpaper
            .trim()
            .trim_start_matches(r"\\?\")
            .to_string();

        let resolved_wallpaper = if std::path::Path::new(&current_cleaned).exists() {
            current_cleaned.clone()
        } else {
            // 兜底策略（按你的需求）：当“当前壁纸文件不存在”时，直接从【画廊】按轮播策略挑一张存在的图片
            // - sequential：取画廊排序中的第一张存在图片（与轮播的顺序语义一致）
            // - random：从所有存在图片中随机挑一张
            let picked_from_gallery: Option<String> = (|| {
                let storage = app_clone.try_state::<Storage>()?;
                let images = storage.get_all_images().ok()?;
                let existing: Vec<_> = images
                    .into_iter()
                    .filter(|img| std::path::Path::new(&img.local_path).exists())
                    .collect();
                if existing.is_empty() {
                    return None;
                }
                match s.wallpaper_rotation_mode.as_str() {
                    "sequential" => Some(existing[0].local_path.clone()),
                    _ => {
                        let idx = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos() as usize)
                            % existing.len();
                        Some(existing[idx].local_path.clone())
                    }
                }
            })();

            if let Some(p) = picked_from_gallery {
                eprintln!(
                    "[WARN] set_wallpaper_mode: 当前壁纸文件不存在，将从画廊选择兜底图片: {} (原路径: {})",
                    p, current_wallpaper
                );
                p
            } else {
                // 找不到可用图片：这里直接保留“不可用路径”，让后续 set_wallpaper_path 抛错并走失败事件，
                // 但错误信息会更聚焦（比单纯 File does not exist 更容易理解）
                current_cleaned.clone()
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
            // 如果 resolved_wallpaper 仍然不存在，给一个更可读的错误（尤其是"从未设置过壁纸/系统返回缓存路径"的场景）
            if !std::path::Path::new(&resolved_wallpaper).exists() {
                let error_msg = if old_mode_clone == "native" {
                    format!(
                        "无法切换到窗口模式：当前系统壁纸文件不存在（可能是主题缓存或临时文件），且画廊中没有可用图片。请先在画廊中添加图片，或手动设置一张壁纸后再切换。\n原路径: {}",
                        resolved_wallpaper
                    )
                } else {
                    format!(
                        "无法切换到窗口模式：壁纸文件不存在，且画廊中没有可用图片作为兜底。请先在画廊中添加图片。\n路径: {}",
                        resolved_wallpaper
                    )
                };
                return Err(error_msg);
            }
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

/// 修复壁纸窗口的 Z-order（确保在 DefView 之下，WorkerW 之上）
#[cfg(target_os = "windows")]
fn fix_wallpaper_window_zorder(app: &tauri::AppHandle) {
    use tauri::Manager;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
    };

    // 检查是否是窗口模式
    let is_window_mode = if let Some(settings_state) = app.try_state::<Settings>() {
        if let Ok(settings) = settings_state.get_settings() {
            settings.wallpaper_mode == "window"
        } else {
            false
        }
    } else {
        false
    };

    if !is_window_mode {
        return;
    }

    // 获取壁纸窗口
    let Some(wallpaper_window) = app.get_webview_window("wallpaper") else {
        return;
    };

    let Ok(tauri_hwnd) = wallpaper_window.hwnd() else {
        return;
    };
    let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

    unsafe {
        fn wide(s: &str) -> Vec<u16> {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            OsStr::new(s).encode_wide().chain(Some(0)).collect()
        }

        const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;
        const HWND_TOP: HWND = 0;

        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return;
        }

        let ex_style = GetWindowLongPtrW(progman, GWL_EXSTYLE) as u32;
        let is_raised_desktop = (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0;

        if is_raised_desktop {
            eprintln!("[DEBUG] hide_main_window: 修复壁纸窗口 Z-order (Windows 11 raised desktop)");

            // 查找 DefView
            let shell_dll_defview = FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );

            if shell_dll_defview != 0 {
                // 确保 DefView 在顶部
                ShowWindow(shell_dll_defview, SW_SHOW);
                SetWindowPos(
                    shell_dll_defview,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                // 查找并提升 SysListView32
                let folder_view = FindWindowExW(
                    shell_dll_defview,
                    0,
                    wide("SysListView32").as_ptr(),
                    std::ptr::null(),
                );
                if folder_view != 0 {
                    ShowWindow(folder_view, SW_SHOW);
                    SetWindowPos(
                        folder_view,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }

                // 确保壁纸窗口在 DefView 之下
                SetWindowPos(
                    tauri_hwnd,
                    shell_dll_defview as HWND,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                eprintln!("[DEBUG] hide_main_window: ✓ 壁纸窗口 Z-order 已修复");
            }
        }
    }
}

/// 隐藏主窗口（用于窗口关闭事件处理）
#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    // 明确获取主窗口，而不是使用 values().next()（可能获取到壁纸窗口）
    let Some(window) = app.get_webview_window("main") else {
        return Err("找不到主窗口".to_string());
    };

    // 在隐藏窗口前保存窗口状态
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

    window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;

    // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
    #[cfg(target_os = "windows")]
    {
        fix_wallpaper_window_zorder(&app);
    }

    Ok(())
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
            let app_data_dir = crate::app_paths::kabegame_data_dir();
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

            // 每次启动：异步覆盖复制内置插件到用户插件目录（确保可用性/不变性）
            let app_handle_plugins = app.app_handle().clone();
            std::thread::spawn(move || {
                let pm = app_handle_plugins.state::<PluginManager>();
                if let Err(e) = pm.ensure_prepackaged_plugins_installed() {
                    eprintln!("[WARN] 启动时安装内置插件失败: {}", e);
                }
            });

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

                    // 启动时：按规则恢复/回退“当前壁纸”
                    if let Err(e) = init_wallpaper_on_startup(&app_handle) {
                        eprintln!("启动时初始化壁纸失败: {}", e);
                    }

                    // 初始化完成后：若轮播仍启用，则启动轮播线程
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
            get_task_image_ids,
            // 原有命令
            get_plugins,
            get_build_mode,
            update_plugin,
            delete_plugin,
            crawl_images_command,
            get_images,
            get_images_paginated,
            get_image_by_id,
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
            batch_delete_images,
            batch_remove_images,
            dedupe_gallery_by_hash,
            toggle_image_favorite,
            update_images_order,
            update_album_images_order,
            update_albums_order,
            open_file_path,
            open_file_folder,
            set_wallpaper,
            set_wallpaper_by_image_id,
            get_current_wallpaper_image_id,
            clear_current_wallpaper_image_id,
            get_image_local_path_by_id,
            get_current_wallpaper_path,
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
            get_plugin_image,
            get_plugin_image_for_detail,
            get_plugin_icon,
            get_gallery_image,
            get_plugin_vars,
            get_settings,
            get_setting,
            get_favorite_album_id,
            set_auto_launch,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_image_click_action,
            set_gallery_image_aspect_ratio_match_window,
            set_gallery_image_aspect_ratio,
            get_desktop_resolution,
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
            // 监听窗口关闭事件
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 阻止默认关闭行为
                    api.prevent_close();
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

                    // 隐藏主窗口（直接隐藏，不关闭）
                    if let Err(e) = window.hide() {
                        eprintln!("隐藏主窗口失败: {}", e);
                    } else {
                        // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
                        #[cfg(target_os = "windows")]
                        {
                            fix_wallpaper_window_zorder(window.app_handle());
                        }
                    }
                } else if window.label().starts_with("wallpaper") {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
