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

// Workspace 重构：主应用不再在本 crate 内定义这些模块，而是从 `kabegame-core` 复用。
use crawler::ActiveDownloadInfo;
use kabegame_core::{crawler, dedupe, plugin, settings, storage, tray, wallpaper};
use plugin::{
    BrowserPlugin, ImportPreview, Plugin, PluginDetail, PluginManager, PluginSource,
    StorePluginResolved, StoreSourceValidationResult,
};
use settings::{AppSettings, Settings, WindowState};
use std::fs;
#[cfg(debug_assertions)]
use storage::dedupe::DebugCloneImagesResult;
use storage::images::{PaginatedImages, RangedImages};
use storage::{Album, ImageInfo, RunConfig, Storage, TaskInfo};
use wallpaper::{WallpaperController, WallpaperRotator, WallpaperWindow};

use dedupe::DedupeManager;
#[cfg(target_os = "windows")]
use kabegame_core::virtual_drive::VirtualDriveService;
#[cfg(target_os = "windows")]
use kabegame_core::wallpaper_engine_export::{WeExportOptions, WeExportResult};

// 任务失败图片（用于 TaskDetail 展示 + 重试）
use storage::albums::AddToAlbumResult;
use storage::tasks::TaskFailedImage;

// ---- wrappers: tauri::command 必须在当前 app crate 中定义，不能直接复用依赖 crate 的 command 宏产物 ----

/// TaskDetail 专用：分页结果（字段名使用 camelCase，与前端 `PaginatedImages` 对齐）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskPaginatedImages {
    images: Vec<ImageInfo>,
    total: usize,
    page: usize,
    page_size: usize,
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
    storage: tauri::State<Storage>,
    settings: tauri::State<Settings>,
) -> Result<WeExportResult, String> {
    kabegame_core::wallpaper_engine_export::export_album_to_we_project(
        album_id,
        album_name,
        output_parent_dir,
        options,
        storage.inner(),
        settings.inner(),
    )
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
    settings: tauri::State<Settings>,
) -> Result<WeExportResult, String> {
    kabegame_core::wallpaper_engine_export::export_images_to_we_project(
        image_paths,
        title,
        output_parent_dir,
        options,
        settings.inner(),
    )
}

/// 调试命令：批量克隆图片记录，生成大量测试数据（仅开发构建可用）。
#[cfg(debug_assertions)]
#[tauri::command]
async fn debug_clone_images(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    count: usize,
    pool_size: Option<usize>,
    seed: Option<u64>,
) -> Result<DebugCloneImagesResult, String> {
    let pool_size = pool_size.unwrap_or(2000);
    let storage = storage.inner().clone();
    let app = app.clone();
    tokio::task::spawn_blocking(move || storage.debug_clone_images(app, count, pool_size, seed))
        .await
        .map_err(|e| format!("debug_clone_images task join error: {}", e))?
}

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

    // 轮播：避免加载大量 images 数据（百万级会明显卡顿）。
    // 只做“membership/existence + LIMIT/采样”级别的查询。
    let mut source_album_id = settings
        .wallpaper_rotation_album_id
        .clone()
        .unwrap_or_default();
    let mode = settings.wallpaper_rotation_mode.clone();

    // 优先：若 currentWallpaperImageId 仍然有效且属于当前来源，则继续用它。
    let mut chosen_id: Option<String> = None;
    if let Some(id) = cur_id.clone() {
        let in_source = if source_album_id.trim().is_empty() {
            // 画廊轮播：只要图片存在即可
            storage.find_image_by_id(&id)?.is_some()
        } else {
            storage
                .is_image_in_album(&source_album_id, &id)
                .unwrap_or(false)
        };

        if in_source {
            if let Some(img) = storage.find_image_by_id(&id)? {
                if Path::new(&img.local_path).exists() {
                    chosen_id = Some(id);
                }
            }
        }
    }

    // 否则：从来源里挑一张“存在且文件存在”的图片作为回退。
    if chosen_id.is_none() {
        chosen_id = if source_album_id.trim().is_empty() {
            storage.pick_existing_gallery_image_id(&mode)?
        } else {
            storage.pick_existing_album_image_id(&source_album_id, &mode)?
        };
    }

    // 若画册无可用图：回退到画廊
    if chosen_id.is_none() && !source_album_id.trim().is_empty() {
        source_album_id = "".to_string();
        settings_state.set_wallpaper_rotation_album_id(Some(source_album_id.clone()))?;
        settings = settings_state.get_settings()?;
        chosen_id = storage.pick_existing_gallery_image_id(&mode)?;
    }

    // 若画廊也无图：降级到非轮播并清空
    let Some(chosen_id) = chosen_id else {
        settings_state.set_wallpaper_rotation_enabled(false)?;
        settings_state.set_wallpaper_rotation_album_id(None)?;
        settings_state.set_current_wallpaper_image_id(None)?;
        return Ok(());
    };

    let image = storage
        .find_image_by_id(&chosen_id)?
        .ok_or_else(|| "选择的壁纸不存在".to_string())?;
    if !Path::new(&image.local_path).exists() {
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

/// 前端手动刷新“已安装源”：触发后端重扫 plugins-directory 并重建缓存
#[tauri::command]
fn refresh_installed_plugins_cache(state: tauri::State<PluginManager>) -> Result<(), String> {
    state.refresh_installed_plugins_cache()
}

/// 前端安装/更新后可调用：按 pluginId 局部刷新缓存
#[tauri::command]
fn refresh_installed_plugin_cache(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.refresh_installed_plugin_cache(&plugin_id)
}

#[tauri::command]
fn get_build_mode(state: tauri::State<PluginManager>) -> Result<String, String> {
    Ok(state.build_mode().to_string())
}

#[tauri::command]
fn delete_plugin(plugin_id: String, state: tauri::State<PluginManager>) -> Result<(), String> {
    state.delete(&plugin_id)
}

#[tauri::command]
fn crawl_images_command(
    plugin_id: String,
    task_id: String,
    output_dir: Option<String>,
    user_config: Option<HashMap<String, serde_json::Value>>, // 用户配置的变量
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
    app: tauri::AppHandle,
) -> Result<(), String> {
    let scheduler = app.state::<crawler::TaskScheduler>();
    scheduler.enqueue(crawler::CrawlTaskRequest {
        plugin_id,
        task_id,
        output_dir,
        user_config,
        http_headers: None,
        output_album_id,
        plugin_file_path: None,
    })?;
    Ok(())
}

/// 创建任务并立刻入队执行（合并 `add_task` + `crawl_images_command`）
#[tauri::command]
fn start_task(
    task: TaskInfo,
    app: tauri::AppHandle,
    state: tauri::State<Storage>,
) -> Result<(), String> {
    // 先落库
    state.add_task(task.clone())?;
    // 再入队（由 TaskScheduler 负责并发/取消/事件）
    let scheduler = app.state::<crawler::TaskScheduler>();
    scheduler.enqueue(crawler::CrawlTaskRequest {
        plugin_id: task.plugin_id,
        task_id: task.id,
        output_dir: task.output_dir,
        user_config: task.user_config,
        http_headers: task.http_headers,
        output_album_id: task.output_album_id,
        plugin_file_path: None,
    })?;
    Ok(())
}

#[tauri::command]
fn get_images(state: tauri::State<Storage>) -> Result<Vec<ImageInfo>, String> {
    state.get_all_images()
}

#[tauri::command]
fn get_images_paginated(
    page: usize,
    page_size: usize,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_images_paginated(page, page_size)
}

#[tauri::command]
fn get_images_range(
    offset: usize,
    limit: usize,
    state: tauri::State<Storage>,
) -> Result<RangedImages, String> {
    state.get_images_range(offset, limit)
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
fn add_album(
    app: tauri::AppHandle,
    name: String,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<Album, String> {
    let album = state.add_album(&name)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "add"
        }),
    );
    #[cfg(target_os = "windows")]
    {
        drive.notify_root_dir_changed();
    }
    Ok(album)
}

#[tauri::command]
fn rename_album(
    app: tauri::AppHandle,
    album_id: String,
    new_name: String,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    state.rename_album(&album_id, &new_name)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "rename"
        }),
    );
    #[cfg(target_os = "windows")]
    {
        drive.notify_root_dir_changed();
    }
    Ok(())
}

// --- Windows 虚拟盘（Dokan） ---

#[cfg(target_os = "windows")]
#[tauri::command]
fn mount_virtual_drive(
    app: tauri::AppHandle,
    mount_point: String,
    storage: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    drive.mount(&mount_point, storage.inner().clone(), app)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn unmount_virtual_drive(drive: tauri::State<VirtualDriveService>) -> Result<bool, String> {
    drive.unmount()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn mount_virtual_drive_and_open_explorer(
    app: tauri::AppHandle,
    mount_point: String,
    storage: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    drive.mount(&mount_point, storage.inner().clone(), app)?;
    let open_path = drive.current_mount_point().unwrap_or(mount_point);
    std::process::Command::new("explorer")
        .arg(open_path)
        .spawn()
        .map_err(|e| format!("已挂载，但打开资源管理器失败: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_explorer(path: String) -> Result<(), String> {
    kabegame_core::shell_open::open_explorer(&path)
}

#[tauri::command]
fn delete_album(
    app: tauri::AppHandle,
    album_id: String,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    state.delete_album(&album_id)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "delete"
        }),
    );
    #[cfg(target_os = "windows")]
    {
        drive.notify_root_dir_changed();
    }
    Ok(())
}

#[tauri::command]
fn add_images_to_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<AddToAlbumResult, String> {
    let r = state.add_images_to_album(&album_id, &image_ids)?;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "add"
            ,"imageIds": image_ids
        }),
    );
    #[cfg(target_os = "windows")]
    {
        drive.notify_album_dir_changed(state.inner(), &album_id);
    }
    Ok(r)
}

#[tauri::command]
fn remove_images_from_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<usize, String> {
    let removed = state.remove_images_from_album(&album_id, &image_ids)?;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "remove"
            ,"imageIds": image_ids
        }),
    );
    #[cfg(target_os = "windows")]
    {
        drive.notify_album_dir_changed(state.inner(), &album_id);
    }
    Ok(removed)
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
fn get_images_count(state: tauri::State<Storage>) -> Result<usize, String> {
    state.get_total_count()
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

/// 启动“分批按 hash 去重”后台任务（前端应通过事件订阅进度/批量移除/完成）。
#[tauri::command]
fn start_dedupe_gallery_by_hash_batched(
    delete_files: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, Storage>,
    manager: tauri::State<'_, DedupeManager>,
) -> Result<(), String> {
    // 固定每批 10000（与你的需求一致）；后续如需可扩展为参数
    let batch_size = 10_000usize;
    manager.start_batched(app, state.inner().clone(), delete_files, batch_size)
}

/// 取消“分批按 hash 去重”后台任务。
#[tauri::command]
fn cancel_dedupe_gallery_by_hash_batched(
    manager: tauri::State<'_, DedupeManager>,
) -> Result<bool, String> {
    manager.cancel()
}

// 清理应用数据（仅用户数据，不包括应用本身）
#[tauri::command]
async fn clear_user_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = kabegame_core::app_paths::kabegame_data_dir();

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
    app: tauri::AppHandle,
    image_id: String,
    favorite: bool,
    state: tauri::State<Storage>,
    #[cfg(target_os = "windows")] drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    state.toggle_image_favorite(&image_id, favorite)?;

    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": kabegame_core::storage::FAVORITE_ALBUM_ID,
            "reason": if favorite { "add" } else { "remove" },
            "imageIds": [image_id]
        }),
    );

    #[cfg(target_os = "windows")]
    {
        drive.notify_album_dir_changed(state.inner(), kabegame_core::storage::FAVORITE_ALBUM_ID);
    }

    Ok(())
}

#[tauri::command]
fn open_file_path(file_path: String) -> Result<(), String> {
    kabegame_core::shell_open::open_path(&file_path)
}

#[tauri::command]
fn open_file_folder(file_path: String) -> Result<(), String> {
    kabegame_core::shell_open::reveal_in_folder(&file_path)
}

#[tauri::command]
async fn set_wallpaper(file_path: String, app: tauri::AppHandle) -> Result<(), String> {
    // 壁纸设置可能包含阻塞的系统调用（Windows API / Explorer 刷新等）。
    // 若在主线程执行，会导致前端 WebView “整页卡死”，因此必须放到 blocking 线程。
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::path::Path;

        let path = Path::new(&file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        // 使用全局 WallpaperController：适配“单张壁纸”并支持 native/window 两种后端模式。
        // 注意：这里不涉及 transition（过渡效果由“轮播 manager”负责，并受“是否启用轮播”约束）。
        let controller = app_clone.state::<WallpaperController>();
        let settings_state = app_clone.state::<Settings>();
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
        if let Some(storage) = app_clone.try_state::<Storage>() {
            if let Ok(found) = storage.find_image_by_path(&abs) {
                let _ = settings_state.set_current_wallpaper_image_id(found.map(|img| img.id));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// 按 imageId 设置壁纸，并同步更新 settings.currentWallpaperImageId
#[tauri::command]
async fn set_wallpaper_by_image_id(image_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::path::Path;

        let storage = app_clone.state::<Storage>();
        let settings_state = app_clone.state::<Settings>();
        let settings = settings_state.get_settings()?;

        let image = storage
            .find_image_by_id(&image_id)?
            .ok_or_else(|| "图片不存在".to_string())?;

        if !Path::new(&image.local_path).exists() {
            // 图片已被删除/移除/文件丢失：清空 currentWallpaperImageId
            let _ = settings_state.set_current_wallpaper_image_id(None);
            return Err("图片文件不存在".to_string());
        }

        let controller = app_clone.state::<WallpaperController>();
        controller.set_wallpaper(&image.local_path, &settings.wallpaper_rotation_style)?;

        settings_state.set_current_wallpaper_image_id(Some(image_id))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
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
    force_refresh: Option<bool>,
    state: tauri::State<'_, PluginManager>,
) -> Result<Vec<StorePluginResolved>, String> {
    state
        .fetch_store_plugins(source_id.as_deref(), force_refresh.unwrap_or(false))
        .await
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

// ============================
// task_failed_images
// ============================

#[tauri::command]
fn get_task_failed_images(
    task_id: String,
    state: tauri::State<Storage>,
) -> Result<Vec<TaskFailedImage>, String> {
    state.get_task_failed_images(&task_id)
}

/// 失败图片重试：走后端 download_image 队列（会触发 image-added）
#[tauri::command]
async fn retry_task_failed_image(
    app: tauri::AppHandle,
    failed_id: i64,
    state: tauri::State<'_, Storage>,
) -> Result<(), String> {
    // 在 spawn_blocking 之前先获取需要的数据
    let item = {
        let Some(item) = state.get_task_failed_image_by_id(failed_id)? else {
            return Err("失败图片记录不存在".to_string());
        };
        item.clone()
    };

    // 标记一次尝试（清空 last_error）
    let _ = state.update_task_failed_image_attempt(failed_id, "");

    // 取任务配置（输出目录/画册）
    let task = {
        let task = state
            .get_task(&item.task_id)?
            .ok_or_else(|| "任务不存在".to_string())?;
        task.clone()
    };

    let images_dir = task
        .output_dir
        .as_deref()
        .map(|s| std::path::PathBuf::from(s))
        .unwrap_or_else(|| crawler::get_default_images_dir());

    let start_time = if item.order > 0 {
        item.order as u64
    } else {
        // 兜底：使用当前时间戳，保证排序稳定
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    };

    // 为了不阻塞 UI，放到 blocking 线程
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dq = app_clone.state::<crawler::DownloadQueue>();
        dq.download_image(
            item.url.clone(),
            images_dir,
            item.plugin_id.clone(),
            item.task_id.clone(),
            start_time,
            task.output_album_id.clone(),
            task.http_headers.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
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
    state.get_plugin_icon_by_id(&plugin_id)
}

/// 商店列表 icon：KGPG v2 固定头部 + HTTP Range 读取（返回 PNG bytes）。
#[tauri::command]
async fn get_remote_plugin_icon(
    download_url: String,
    state: tauri::State<'_, PluginManager>,
) -> Result<Option<Vec<u8>>, String> {
    state.fetch_remote_plugin_icon_v2(&download_url).await
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
    Ok(kabegame_core::storage::FAVORITE_ALBUM_ID.to_string())
}

#[tauri::command]
fn set_restore_last_tab(enabled: bool, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_restore_last_tab(enabled)
}

#[tauri::command]
fn set_album_drive_enabled(enabled: bool, state: tauri::State<Settings>) -> Result<(), String> {
    state.set_album_drive_enabled(enabled)
}

#[tauri::command]
fn set_album_drive_mount_point(
    mount_point: String,
    state: tauri::State<Settings>,
) -> Result<(), String> {
    state.set_album_drive_mount_point(mount_point)
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
    // 同步调整 download worker 数量（全局并发下载）
    if let Some(download_queue) = app.try_state::<crawler::DownloadQueue>() {
        download_queue.set_desired_concurrency(count);
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
fn update_run_config(config: RunConfig, state: tauri::State<Storage>) -> Result<(), String> {
    state.update_run_config(config)
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

    // 同步更新任务状态：用户手动停止应为 canceled，而不是等 task worker 结束后被 completed 覆盖。
    // 注意：只有在任务存在且尚未终结（completed/failed/canceled）时才更新与发事件。
    let end = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let canceled_err = "Task canceled".to_string();

    if let Some(storage) = app.try_state::<Storage>() {
        if let Ok(Some(mut task)) = storage.get_task(&task_id) {
            let is_terminal = matches!(task.status.as_str(), "completed" | "failed" | "canceled");
            if !is_terminal {
                task.status = "canceled".to_string();
                task.end_time = Some(end);
                task.error = Some(canceled_err.clone());
                let _ = storage.update_task(task);

                // 前端优先靠 task-status 驱动 UI；同时保留 task-error 兼容旧逻辑
                let _ = app.emit(
                    "task-status",
                    serde_json::json!({
                        "taskId": task_id.clone(),
                        "status": "canceled",
                        "endTime": end,
                        "error": canceled_err.clone()
                    }),
                );
                let _ = app.emit(
                    "task-error",
                    serde_json::json!({
                        "taskId": task_id,
                        "error": canceled_err
                    }),
                );
            }
        }
    }
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

/// 将任务的 Rhai 失败 dump 标记为“已确认/已读”（用于任务列表右上角小按钮）
#[tauri::command]
fn confirm_task_rhai_dump(task_id: String, state: tauri::State<Storage>) -> Result<(), String> {
    state.confirm_task_rhai_dump(&task_id)
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

    // 先取出该任务关联的图片 id 列表（避免删除后无法判断是否包含"当前壁纸"）
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

/// 清除所有已完成、失败或取消的任务（保留 pending 和 running 的任务）
/// 返回被删除的任务数量
#[tauri::command]
fn clear_finished_tasks(state: tauri::State<Storage>) -> Result<usize, String> {
    state.clear_finished_tasks()
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
) -> Result<TaskPaginatedImages, String> {
    let offset = page.saturating_mul(page_size);
    let images = state.get_task_images_paginated(&task_id, offset, page_size)?;
    let total = state.get_task_image_ids(&task_id)?.len();
    Ok(TaskPaginatedImages {
        images,
        total,
        page,
        page_size,
    })
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
        // 2.5) 切换模式时：尽量保留/恢复该模式的 style/transition（按模式缓存）
        // - 优先“尽量保留当前值”：如果当前值在目标模式下仍可用，就沿用当前值
        // - 若当前值在目标模式下不可用：回退到目标模式的“上一次值”（若存在）
        // - 同时对 native 做 normalize，避免 slide/zoom 等不支持值污染全局设置
        let (style_to_apply, transition_to_apply) = match settings_state
            .swap_style_transition_for_mode_switch(&old_mode_clone, &mode_clone)
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[WARN] set_wallpaper_mode: swap_style_transition_for_mode_switch 失败: {}",
                    e
                );
                (
                    s.wallpaper_rotation_style.clone(),
                    s.wallpaper_rotation_transition.clone(),
                )
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
                style_to_apply
            );
            target.set_style(&style_to_apply, true)?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_style 完成");
            // 过渡效果属于轮播能力：只在轮播启用时做立即预览
            if s.wallpaper_rotation_enabled {
                // 最后应用transition
                eprintln!(
                    "[DEBUG] set_wallpaper_mode: 调用 target.set_transition: {}",
                    transition_to_apply
                );
                target.set_transition(&transition_to_apply, true)?;
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
            eprintln!("[DEBUG] fix_wallpaper_window_zorder: 修复壁纸窗口 Z-order (Windows 11 raised desktop)");

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

                eprintln!("[DEBUG] fix_wallpaper_window_zorder: ✓ 壁纸窗口 Z-order 已修复");
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

/// Windows：为主窗口左侧导航栏启用 DWM 模糊（BlurBehind + HRGN）。
/// - sidebar_width: 侧栏宽度（px）
#[tauri::command]
fn set_main_sidebar_dwm_blur(app: tauri::AppHandle, sidebar_width: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use std::mem::transmute;
        use tauri::Manager;
        use windows_sys::Win32::Foundation::BOOL;
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::Graphics::Dwm::{
            DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
        };
        use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject};
        use windows_sys::Win32::System::LibraryLoader::{
            GetModuleHandleW, GetProcAddress, LoadLibraryW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

        let Some(window) = app.get_webview_window("main") else {
            return Err("找不到主窗口".to_string());
        };

        let tauri_hwnd = window
            .hwnd()
            .map_err(|e| format!("获取主窗口 HWND 失败: {}", e))?;
        let hwnd: HWND = tauri_hwnd.0 as isize;

        #[cfg(debug_assertions)]
        eprintln!(
            "[DWM] set_main_sidebar_dwm_blur: sidebar_width={}",
            sidebar_width
        );

        if hwnd == 0 {
            return Err("hwnd is null".into());
        }

        // ---- 优先：SetWindowCompositionAttribute + ACCENT_ENABLE_ACRYLICBLURBEHIND（Win11 更常见/更稳定）----
        // 我们给“整个窗口”开启 acrylic，但由于主内容区域是不透明背景，视觉上只有侧栏（半透明）会显现毛玻璃。
        #[repr(C)]
        struct ACCENT_POLICY {
            accent_state: i32,
            accent_flags: i32,
            gradient_color: u32,
            animation_id: i32,
        }

        #[repr(C)]
        struct WINDOWCOMPOSITIONATTRIBDATA {
            attrib: i32,
            pv_data: *mut c_void,
            cb_data: u32,
        }

        // Undocumented: WCA_ACCENT_POLICY = 19
        const WCA_ACCENT_POLICY: i32 = 19;
        // Undocumented: ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
        const ACCENT_ENABLE_ACRYLICBLURBEHIND: i32 = 4;

        unsafe {
            // 动态加载：避免 MSVC 链接阶段找不到 __imp_SetWindowCompositionAttribute 导致 LNK2019
            unsafe fn wide(s: &str) -> Vec<u16> {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                OsStr::new(s).encode_wide().chain(Some(0)).collect()
            }

            type SetWcaFn =
                unsafe extern "system" fn(HWND, *mut WINDOWCOMPOSITIONATTRIBDATA) -> BOOL;

            let user32 = {
                let m = GetModuleHandleW(wide("user32.dll").as_ptr());
                if m != 0 {
                    m
                } else {
                    LoadLibraryW(wide("user32.dll").as_ptr())
                }
            };

            let set_wca: Option<SetWcaFn> = if user32 != 0 {
                // windows-sys 的 GetProcAddress 返回 Option<FARPROC>
                GetProcAddress(user32, b"SetWindowCompositionAttribute\0".as_ptr())
                    .map(|f| transmute(f))
            } else {
                None
            };

            // GradientColor 常见实现为 0xAABBGGRR；白色不受通道顺序影响。
            let accent = ACCENT_POLICY {
                accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
                accent_flags: 2,
                gradient_color: 0x99FFFFFF, // 半透明白
                animation_id: 0,
            };

            let mut data = WINDOWCOMPOSITIONATTRIBDATA {
                attrib: WCA_ACCENT_POLICY,
                pv_data: (&accent as *const ACCENT_POLICY) as *mut c_void,
                cb_data: std::mem::size_of::<ACCENT_POLICY>() as u32,
            };

            if let Some(set_wca) = set_wca {
                let ok = set_wca(hwnd, &mut data);
                if ok != 0 {
                    #[cfg(debug_assertions)]
                    eprintln!("[DWM] acrylic enabled via SetWindowCompositionAttribute");
                    return Ok(());
                }
            } else {
                #[cfg(debug_assertions)]
                eprintln!("[DWM] SetWindowCompositionAttribute not found (GetProcAddress)");
            }
        }

        #[cfg(debug_assertions)]
        eprintln!("[DWM] acrylic failed, fallback to DwmEnableBlurBehindWindow");

        if sidebar_width == 0 {
            unsafe {
                let bb = DWM_BLURBEHIND {
                    dwFlags: DWM_BB_ENABLE,
                    fEnable: 0 as BOOL,
                    hRgnBlur: 0,
                    fTransitionOnMaximized: 0 as BOOL,
                };
                let hr = DwmEnableBlurBehindWindow(hwnd, &bb);
                if hr != 0 {
                    return Err(format!(
                        "DwmEnableBlurBehindWindow(disable) failed: HRESULT=0x{hr:08X}"
                    ));
                }
            }
            return Ok(());
        }

        unsafe {
            let mut rect = std::mem::MaybeUninit::uninit();
            if GetClientRect(hwnd, rect.as_mut_ptr()) == 0 {
                return Err("GetClientRect failed".into());
            }
            let rect = rect.assume_init();
            let height = rect.bottom - rect.top;
            if height <= 0 {
                return Err("client rect height is invalid".into());
            }

            let width = (sidebar_width as i32).min(rect.right - rect.left).max(1);
            #[cfg(debug_assertions)]
            eprintln!(
                "[DWM] client_rect={}x{}, blur_width={}",
                rect.right - rect.left,
                rect.bottom - rect.top,
                width
            );
            let rgn = CreateRectRgn(0, 0, width, height);
            if rgn == 0 {
                return Err("CreateRectRgn failed".into());
            }

            let bb = DWM_BLURBEHIND {
                dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
                fEnable: 1 as BOOL,
                hRgnBlur: rgn,
                fTransitionOnMaximized: 0 as BOOL,
            };

            let hr = DwmEnableBlurBehindWindow(hwnd, &bb);
            let _ = DeleteObject(rgn);
            if hr != 0 {
                return Err(format!(
                    "DwmEnableBlurBehindWindow failed: HRESULT=0x{hr:08X}"
                ));
            }
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = sidebar_width;
        Ok(())
    }
}

/// 打开插件编辑器（以独立进程运行 kabegame-plugin-editor.exe）
///
/// 注意：我们不使用 Tauri sidecar 机制（因为它更适合“同一 app 的附属工具”）。
/// 这里直接从当前安装目录启动 `kabegame-plugin-editor.exe`，由安装脚本确保它与主程序在同一目录下。
#[tauri::command]
fn open_plugin_editor_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {e}"))?
        .parent()
        .ok_or_else(|| "无法获取当前可执行文件目录".to_string())?
        .to_path_buf();

    let editor_exe = exe_dir.join("kabegame-plugin-editor.exe");
    if !editor_exe.exists() {
        return Err(format!(
            "找不到插件编辑器可执行文件：{}\n请确认安装包已将其复制到安装目录。",
            editor_exe.display()
        ));
    }

    app.shell()
        .command(editor_exe)
        .spawn()
        .map_err(|e| format!("启动插件编辑器进程失败: {e}"))?;

    Ok(())
}

/// 修复壁纸窗口 Z-order（供前端在最小化等事件时调用）
#[tauri::command]
fn fix_wallpaper_zorder(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        fix_wallpaper_window_zorder(&app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
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

// =========================
// Startup steps (split setup into small functions)
// =========================

fn startup_step_cleanup_user_data_if_marked() -> bool {
    // 检查清理标记，如果存在则先清理旧数据目录
    let app_data_dir = kabegame_core::app_paths::kabegame_data_dir();
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
                            eprintln!("警告：无法完全清理数据目录，部分文件可能仍在使用中: {}", e);
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
    is_cleaning_data
}

fn startup_step_manage_plugin_manager(app: &mut tauri::App) {
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
        // 内置插件复制完成后，初始化/刷新一次已安装插件缓存（减少后续频繁读盘）
        let _ = pm.refresh_installed_plugins_cache();
    });
}

fn startup_step_manage_storage(app: &mut tauri::App) -> Result<(), String> {
    // 初始化存储管理器
    let storage = Storage::new(app.app_handle().clone());
    storage
        .init()
        .map_err(|e| format!("Failed to initialize storage: {}", e))?;
    // 应用启动时清理所有临时文件
    match storage.cleanup_temp_files() {
        Ok(count) => {
            if count > 0 {
                println!("启动时清理了 {} 个临时文件", count);
            }
        }
        Err(e) => {
            eprintln!("清理临时文件失败: {}", e);
        }
    }
    app.manage(storage);
    Ok(())
}

fn startup_step_manage_virtual_drive_service(app: &mut tauri::App) {
    // Windows：虚拟盘服务（Dokan）
    #[cfg(target_os = "windows")]
    {
        app.manage(VirtualDriveService::default());
    }
}

fn startup_step_manage_settings(app: &mut tauri::App) {
    // 初始化设置管理器
    let settings = Settings::new(app.app_handle().clone());
    app.manage(settings);
}

fn startup_step_auto_mount_album_drive(app: &tauri::AppHandle) {
    // Windows：按设置自动挂载画册盘（不自动弹出 Explorer）
    // 注意：挂载操作可能耗时（尤其是首次挂载或 Dokan 驱动初始化），放到后台线程避免阻塞启动
    #[cfg(target_os = "windows")]
    {
        let settings = app.state::<Settings>().get_settings().ok();
        if let Some(s) = settings {
            if s.album_drive_enabled {
                let mount_point = s.album_drive_mount_point.clone();
                let storage = app.state::<Storage>().inner().clone();
                let app_handle = app.clone();

                // 在后台线程中执行挂载，避免阻塞主线程
                tauri::async_runtime::spawn(async move {
                    // 稍等片刻确保所有服务已初始化完成
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                    let drive = app_handle.state::<VirtualDriveService>();
                    match drive.mount(&mount_point, storage, app_handle.clone()) {
                        Ok(_) => {
                            println!("启动时自动挂载画册盘成功: {}", mount_point);
                        }
                        Err(e) => {
                            eprintln!("启动时自动挂载画册盘失败: {} (挂载点: {})", e, mount_point);
                        }
                    }
                });
            }
        }
    }
}

fn startup_step_manage_dedupe_manager(app: &mut tauri::App) {
    // 初始化去重任务管理器（单例，允许 cancel）
    let dedupe_manager = DedupeManager::new();
    app.manage(dedupe_manager);
}

fn startup_step_restore_main_window_state(app: &tauri::AppHandle, is_cleaning_data: bool) {
    // 恢复窗口状态（如果不在清理数据模式）
    if is_cleaning_data {
        return;
    }
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
                if let Err(e) = main_window.set_position(tauri::LogicalPosition::new(x, y)) {
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

fn startup_step_manage_download_queue(app: &mut tauri::App) {
    // 初始化下载队列管理器
    let download_queue = crawler::DownloadQueue::new(app.app_handle().clone());
    app.manage(download_queue);
}

fn startup_step_mark_pending_tasks_as_failed(app: &tauri::AppHandle) {
    // 应用启动时，将所有 pending 和 running 状态的任务标记为失败
    let storage_for_cleanup = app.state::<Storage>();
    match storage_for_cleanup.mark_pending_running_tasks_as_failed() {
        Ok(count) => {
            if count > 0 {
                println!("启动时已将 {} 个 pending/running 任务标记为失败", count);
            }
        }
        Err(e) => {
            eprintln!("启动时标记任务为失败失败: {}", e);
        }
    }
}

fn startup_step_manage_task_scheduler(app: &mut tauri::App) {
    // 初始化 task 调度器（固定 10 个 task worker）
    // 注意：不再恢复 pending/running 任务，它们已在启动时被标记为失败
    let task_scheduler = crawler::TaskScheduler::new(app.app_handle().clone());
    app.manage(task_scheduler);
}

fn startup_step_manage_wallpaper_components(app: &mut tauri::App) {
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
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let is_cleaning_data = startup_step_cleanup_user_data_if_marked();
            startup_step_manage_plugin_manager(app);
            startup_step_manage_storage(app)?;
            startup_step_manage_virtual_drive_service(app);
            startup_step_manage_settings(app);
            startup_step_auto_mount_album_drive(app.app_handle());
            startup_step_manage_dedupe_manager(app);
            startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
            startup_step_manage_download_queue(app);
            startup_step_mark_pending_tasks_as_failed(app.app_handle());
            startup_step_manage_task_scheduler(app);
            startup_step_manage_wallpaper_components(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 任务相关命令
            add_task,
            start_task,
            update_task,
            get_task,
            get_all_tasks,
            confirm_task_rhai_dump,
            delete_task,
            clear_finished_tasks,
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            retry_task_failed_image,
            // 原有命令
            get_plugins,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_build_mode,
            delete_plugin,
            crawl_images_command,
            get_images,
            get_images_paginated,
            get_images_range,
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
            // Windows 虚拟盘
            #[cfg(target_os = "windows")]
            mount_virtual_drive,
            #[cfg(target_os = "windows")]
            unmount_virtual_drive,
            #[cfg(target_os = "windows")]
            mount_virtual_drive_and_open_explorer,
            #[cfg(target_os = "windows")]
            open_explorer,
            get_images_count,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            start_dedupe_gallery_by_hash_batched,
            cancel_dedupe_gallery_by_hash_batched,
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
            get_remote_plugin_icon,
            get_gallery_image,
            get_plugin_vars,
            get_settings,
            get_setting,
            get_favorite_album_id,
            set_auto_launch,
            set_album_drive_enabled,
            set_album_drive_mount_point,
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
            update_run_config,
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
            set_main_sidebar_dwm_blur,
            hide_main_window,
            open_plugin_editor_window,
            fix_wallpaper_zorder,
            // Wallpaper Engine 导出
            export_album_to_we_project,
            export_images_to_we_project,
            clear_user_data,
            // Debug: 生成大量测试图片数据
            #[cfg(debug_assertions)]
            debug_clone_images,
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
                } else if window.label() == "plugin-editor" {
                    // 插件编辑器窗口：阻止销毁，只隐藏
                    // 避免重新打开时需要动态创建窗口导致 Monaco editor 初始化问题
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
