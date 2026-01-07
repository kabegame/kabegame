// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use kabegame::{
    crawler,
    plugin::{PluginConfig, PluginManager, PluginManifest, VarDefinition},
    plugin_editor,
    settings::Settings,
    storage::Storage,
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
        url: String::new(),
        task_id,
        output_dir,
        user_config,
        output_album_id,
        plugin_file_path: Some(tmp_kgpg.to_string_lossy().to_string()),
    })?;
    Ok(())
}

// ---- wrappers: tauri::command 必须在当前 bin crate 中定义，不能直接复用 lib crate 的 command 宏产物 ----

#[tauri::command]
fn plugin_editor_check_rhai(script: String) -> Result<Vec<plugin_editor::EditorMarker>, String> {
    plugin_editor::plugin_editor_check_rhai(script)
}

#[tauri::command]
fn plugin_editor_test_rhai(
    script: String,
    var_defs: Vec<VarDefinition>,
    user_config: Option<HashMap<String, JsonValue>>,
    app: tauri::AppHandle,
) -> Result<plugin_editor::PluginEditorTestResult, String> {
    plugin_editor::plugin_editor_test_rhai(script, var_defs, user_config, app)
}

#[tauri::command]
fn plugin_editor_process_icon(image_path: String) -> Result<String, String> {
    plugin_editor::plugin_editor_process_icon(image_path)
}

#[tauri::command]
fn plugin_editor_export_kgpg(
    output_path: String,
    plugin_id: String,
    manifest: kabegame::plugin::PluginManifest,
    config: kabegame::plugin::PluginConfig,
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
fn get_active_downloads(app: tauri::AppHandle) -> Result<Vec<crawler::ActiveDownloadInfo>, String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.get_active_downloads()
}

#[tauri::command]
fn cancel_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let download_queue = app.state::<crawler::DownloadQueue>();
    download_queue.cancel_task(&task_id)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化插件管理器（TaskScheduler 在运行临时 .kgpg 时会用到）
            let plugin_manager = PluginManager::new(app.app_handle().clone());
            app.manage(plugin_manager);

            // 初始化存储（复用主程序的 DB / images_dir）
            let storage = Storage::new(app.app_handle().clone());
            storage
                .init()
                .map_err(|e| format!("Failed to initialize storage: {}", e))?;
            app.manage(storage);

            // 初始化设置（复用用户 settings.json）
            let settings = Settings::new(app.app_handle().clone());
            app.manage(settings);

            // 初始化下载队列（复用下载并发设置等）
            let download_queue = crawler::DownloadQueue::new(app.app_handle().clone());
            app.manage(download_queue);

            // 初始化主程序同款 TaskScheduler（10 worker 并发）
            let scheduler = crawler::TaskScheduler::new(app.app_handle().clone());
            app.manage(scheduler);

            // 直接创建并显示插件编辑器窗口（无需托盘）
            use tauri::{WebviewUrl, WebviewWindowBuilder};
            let _ = WebviewWindowBuilder::new(
                app,
                "plugin-editor",
                WebviewUrl::App("plugin-editor.html".into()),
            )
            .title("Kabegame Plugin Editor")
            .inner_size(1100.0, 760.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .visible(true)
            .center()
            .build();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // plugin editor existing commands
            plugin_editor_check_rhai,
            plugin_editor_test_rhai,
            plugin_editor_export_kgpg,
            plugin_editor_process_icon,
            // runner commands
            plugin_editor_run_task,
            get_active_downloads,
            cancel_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running kabegame-plugin-editor");
}
