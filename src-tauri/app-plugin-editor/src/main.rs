// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod plugin_editor;

use kabegame_core::{
    crawler,
    plugin::{BrowserPlugin, PluginConfig, PluginManager, PluginManifest},
    settings::{AppSettings, Settings},
    storage::{ImageInfo, Storage, TaskInfo},
};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tauri::Manager;

/// 运行“当前编辑器中的脚本”，但运行链路完全复用主程序：
/// - 先将内容打包成临时 .kgpg（与导出逻辑一致）
/// - 再走 `crawler::TaskScheduler` 的 worker（并发/取消/进度/下载队列统一）
#[tauri::command]
fn plugin_editor_run_task(
    plugin_id: String,
    task_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
    user_config: Option<HashMap<String, JsonValue>>,
    output_dir: Option<String>,
    output_album_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 临时 kgpg 路径（每个任务一个文件）
    let tmp_dir = std::env::temp_dir().join("kabegame-plugin-editor");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let tmp_kgpg = tmp_dir.join(format!("{}-{}.kgpg", plugin_id, task_id));

    plugin_editor::plugin_editor_export_kgpg(
        tmp_kgpg.to_string_lossy().to_string(),
        plugin_id.clone(),
        manifest,
        config,
        script,
        icon_rgb_base64,
    )?;

    let scheduler = app.state::<crawler::TaskScheduler>();
    scheduler.enqueue(crawler::CrawlTaskRequest {
        plugin_id,
        task_id,
        output_dir,
        user_config,
        http_headers: None,
        output_album_id,
        plugin_file_path: Some(tmp_kgpg.to_string_lossy().to_string()),
    })?;
    Ok(())
}

/// 创建任务并立刻执行（合并 `add_task` + `plugin_editor_run_task`）
#[tauri::command]
fn start_task(
    task: TaskInfo,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 与主程序一致：先落库
    let storage = app.state::<Storage>();
    if let Err(e) = storage.add_task(task.clone()) {
        eprintln!("[WARN] start_task 落库失败（将继续入队）：{e}");
    }

    // 再复用现有 runner：打包临时 kgpg + 入队 TaskScheduler
    plugin_editor_run_task(
        task.plugin_id.clone(),
        task.id.clone(),
        manifest,
        config,
        script,
        icon_rgb_base64,
        task.user_config.clone(),
        task.output_dir.clone(),
        task.output_album_id.clone(),
        app,
    )
}

// ---- wrappers: tauri::command 必须在当前 bin crate 中定义，不能直接复用 lib crate 的 command 宏产物 ----

#[tauri::command]
fn plugin_editor_check_rhai(script: String) -> Result<Vec<plugin_editor::EditorMarker>, String> {
    plugin_editor::plugin_editor_check_rhai(script)
}
#[tauri::command]
fn plugin_editor_process_icon(image_path: String) -> Result<String, String> {
    plugin_editor::plugin_editor_process_icon(image_path)
}

#[tauri::command]
fn plugin_editor_process_icon_bytes(image_bytes_base64: String) -> Result<String, String> {
    plugin_editor::plugin_editor_process_icon_bytes(image_bytes_base64)
}

#[tauri::command]
fn plugin_editor_export_kgpg(
    output_path: String,
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    plugin_editor::plugin_editor_export_kgpg(
        output_path,
        plugin_id,
        manifest,
        config,
        script,
        icon_rgb_base64,
    )
}

#[tauri::command]
fn plugin_editor_list_installed_plugins(
    state: tauri::State<PluginManager>,
) -> Result<Vec<BrowserPlugin>, String> {
    state.load_browser_plugins()
}

/// 前端手动刷新“已安装源”：触发后端重扫 plugins-directory 并重建缓存
#[tauri::command]
fn refresh_installed_plugins_cache(state: tauri::State<PluginManager>) -> Result<(), String> {
    state.refresh_installed_plugins_cache()
}

/// 插件编辑器导出安装/覆盖后：按 pluginId 局部刷新缓存
#[tauri::command]
fn refresh_installed_plugin_cache(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<(), String> {
    state.refresh_installed_plugin_cache(&plugin_id)
}

#[tauri::command]
fn get_plugin_icon(
    plugin_id: String,
    state: tauri::State<PluginManager>,
) -> Result<Option<Vec<u8>>, String> {
    state.get_plugin_icon_by_id(&plugin_id)
}

#[tauri::command]
fn plugin_editor_import_kgpg(
    state: tauri::State<PluginManager>,
    file_path: String,
) -> Result<plugin_editor::PluginEditorImportResult, String> {
    plugin_editor::plugin_editor_import_kgpg(&state, file_path)
}

#[tauri::command]
fn plugin_editor_import_installed(
    state: tauri::State<PluginManager>,
    plugin_id: String,
) -> Result<plugin_editor::PluginEditorImportResult, String> {
    let p = state
        .get_plugins_directory()
        .join(format!("{}.kgpg", plugin_id));
    plugin_editor::plugin_editor_import_kgpg(&state, p.to_string_lossy().to_string())
}

#[tauri::command]
fn plugin_editor_export_install(
    state: tauri::State<PluginManager>,
    overwrite: bool,
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    let plugins_dir = state.get_plugins_directory();
    std::fs::create_dir_all(&plugins_dir).map_err(|e| format!("创建插件目录失败: {}", e))?;
    let plugin_id_trimmed = plugin_id.trim().to_string();
    let target = plugins_dir.join(format!("{}.kgpg", plugin_id_trimmed));
    if target.exists() && !overwrite {
        return Err("PLUGIN_EXISTS".to_string());
    }
    plugin_editor::plugin_editor_export_kgpg(
        target.to_string_lossy().to_string(),
        plugin_id_trimmed.clone(),
        manifest,
        config,
        script,
        icon_rgb_base64,
    )?;
    // 导出安装/覆盖后：局部刷新缓存，避免前端反复读盘
    let _ = state.refresh_installed_plugin_cache(&plugin_id_trimmed);
    Ok(())
}

#[tauri::command]
fn plugin_editor_export_folder(
    output_dir: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    plugin_editor::plugin_editor_export_folder(
        output_dir,
        manifest,
        config,
        script,
        icon_rgb_base64,
    )
}

#[tauri::command]
fn plugin_editor_autosave_save(
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<String, String> {
    plugin_editor::plugin_editor_autosave_save(plugin_id, manifest, config, script, icon_rgb_base64)
}

#[tauri::command]
fn plugin_editor_autosave_load(
    state: tauri::State<PluginManager>,
) -> Result<Option<plugin_editor::PluginEditorImportResult>, String> {
    plugin_editor::plugin_editor_autosave_load(&state)
}

#[tauri::command]
fn plugin_editor_autosave_clear() -> Result<(), String> {
    plugin_editor::plugin_editor_autosave_clear()
}

#[tauri::command]
fn get_active_downloads(app: tauri::AppHandle) -> Result<Vec<crawler::ActiveDownloadInfo>, String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.get_active_downloads()
}

#[tauri::command]
fn cancel_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.cancel_task(&task_id)
}

#[tauri::command]
fn get_task_images(app: tauri::AppHandle, task_id: String) -> Result<Vec<ImageInfo>, String> {
    let storage = app.state::<Storage>();
    storage.get_task_images(&task_id)
}

#[tauri::command]
fn add_task(app: tauri::AppHandle, task: TaskInfo) -> Result<(), String> {
    let storage = app.state::<Storage>();
    storage.add_task(task)
}

#[tauri::command]
fn get_task(app: tauri::AppHandle, task_id: String) -> Result<Option<TaskInfo>, String> {
    let storage = app.state::<Storage>();
    storage.get_task(&task_id)
}

#[tauri::command]
fn get_all_tasks(app: tauri::AppHandle) -> Result<Vec<TaskInfo>, String> {
    let storage = app.state::<Storage>();
    storage.get_all_tasks()
}

/// 将任务的 Rhai 失败 dump 标记为“已确认/已读”（用于任务列表右上角小按钮）
#[tauri::command]
fn confirm_task_rhai_dump(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let storage = app.state::<Storage>();
    storage.confirm_task_rhai_dump(&task_id)
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

/// 清除所有已完成、失败或取消的任务（保留 pending 和 running 的任务）
/// 返回被删除的任务数量
#[tauri::command]
fn clear_finished_tasks(state: tauri::State<Storage>) -> Result<usize, String> {
    state.clear_finished_tasks()
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

// ---- settings mutators (keep consistent with app-main; plugin-editor 需要可落盘配置) ----

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
fn get_default_images_dir(state: tauri::State<Storage>) -> Result<String, String> {
    Ok(state
        .get_images_dir()
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string())
}

#[tauri::command]
fn open_file_path(file_path: String) -> Result<(), String> {
    kabegame_core::shell_open::open_path(&file_path)
}

#[tauri::command]
fn plugin_editor_exit_app(app: tauri::AppHandle) -> Result<(), String> {
    // 直接退出整个 plugin-editor 进程，避免前端 close/destroy 在 onCloseRequested 中不生效或循环触发。
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化插件管理器（TaskScheduler 在运行临时 .kgpg 时会用到）
            let plugin_manager = PluginManager::new();
            app.manage(plugin_manager);

            // 初始化存储（复用主程序的 DB / images_dir）
            let storage = Storage::new();
            storage
                .init()
                .map_err(|e| format!("Failed to initialize storage: {}", e))?;
            app.manage(storage);

            // 初始化设置（复用用户 settings.json）
            let settings = Settings::new();
            app.manage(settings);

            // 初始化下载队列（复用下载并发设置等）
            let download_queue = crawler::DownloadQueue::new(&settings, Some(app.app_handle().clone()));
            app.manage(download_queue);

            // 初始化主程序同款 TaskScheduler（10 worker 并发）
            let scheduler = crawler::TaskScheduler::new(app.app_handle().clone());
            app.manage(scheduler);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // plugin editor existing commands
            plugin_editor_check_rhai,
            plugin_editor_export_kgpg,
            plugin_editor_process_icon,
            plugin_editor_process_icon_bytes,
            // import/export extras
            plugin_editor_list_installed_plugins,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_plugin_icon,
            plugin_editor_import_kgpg,
            plugin_editor_import_installed,
            plugin_editor_export_install,
            plugin_editor_export_folder,
            // autosave
            plugin_editor_autosave_save,
            plugin_editor_autosave_load,
            plugin_editor_autosave_clear,
            // runner commands
            plugin_editor_run_task,
            start_task,
            get_active_downloads,
            cancel_task,
            // task images (for popup grid)
            get_task_images,
            // task persistence (reuse main behavior)
            add_task,
            get_task,
            get_all_tasks,
            confirm_task_rhai_dump,
            delete_task,
            clear_finished_tasks,
            // image ops (keep consistent with app-main; used by task images context menu)
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            // settings (for shared click behavior, etc.)
            get_settings,
            get_setting,
            get_favorite_album_id,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_auto_deduplicate,
            set_default_download_dir,
            get_default_images_dir,
            open_file_path,
            // lifecycle
            plugin_editor_exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running kabegame-plugin-editor");
}
