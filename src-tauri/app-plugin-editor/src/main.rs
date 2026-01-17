// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod plugin_editor;
mod daemon_client;

use kabegame_core::{
    plugin::{PluginConfig, PluginManifest},
    settings::AppSettings,
    storage::{ImageInfo, TaskInfo},
};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tauri::{Emitter, Manager};

/// 运行"当前编辑器中的脚本"，通过 daemon IPC 执行：
/// - 先将内容打包成临时 .kgpg（与导出逻辑一致）
/// - 通过 daemon IPC 运行任务（避免本地创建 TaskScheduler）
#[tauri::command]
async fn plugin_editor_run_task(
    plugin_id: String,
    task_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
    user_config: Option<HashMap<String, JsonValue>>,
    output_dir: Option<String>,
    output_album_id: Option<String>,
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

    // 将 user_config 转换为 plugin_args（daemon 会解析）
    // daemon 的 handle_plugin_run 期望 CLI 风格的参数（--key value）
    // 这里简化处理：将 user_config 的键值对转换为字符串参数
    let plugin_args = user_config
        .unwrap_or_default()
        .into_iter()
        .flat_map(|(k, v)| {
            // 将值转换为字符串
            let value_str = match v {
                JsonValue::String(s) => s,
                JsonValue::Bool(b) => b.to_string(),
                JsonValue::Number(n) => n.to_string(),
                JsonValue::Null => "".to_string(),
                _ => v.to_string(), // 对象、数组等序列化为 JSON 字符串
            };
            vec![format!("--{}", k), value_str]
        })
        .collect::<Vec<_>>();

    // 通过 daemon IPC 运行任务
    let req = kabegame_core::ipc::ipc::CliIpcRequest::PluginRun {
        plugin: tmp_kgpg.to_string_lossy().to_string(),
        output_dir,
        task_id: Some(task_id),
        output_album_id,
        plugin_args,
    };

    match kabegame_core::ipc::ipc::request(req).await {
        Ok(resp) if resp.ok => Ok(()),
        Ok(resp) => Err(resp
            .message
            .unwrap_or_else(|| "daemon returned error".to_string())),
        Err(e) => Err(format!("无法连接 daemon：{}", e)),
    }
}

/// 创建任务并立刻执行（合并 `add_task` + `plugin_editor_run_task`）
#[tauri::command]
async fn start_task(
    task: TaskInfo,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    // 与主程序一致：先落库
    let task_v = serde_json::to_value(task.clone())
        .map_err(|e| format!("Failed to serialize task: {}", e))?;
    if let Err(e) = daemon_client::get_ipc_client().storage_add_task(task_v).await {
        eprintln!("[WARN] start_task 落库失败（将继续入队）：{e}");
    }

    // 再复用现有 runner：打包临时 kgpg + 通过 daemon IPC 运行
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
    )
    .await
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
async fn plugin_editor_list_installed_plugins() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_browser_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 前端手动刷新"已安装源"：触发后端重扫 plugins-directory 并重建缓存
#[tauri::command]
async fn refresh_installed_plugins_cache() -> Result<(), String> {
    // daemon 侧会在 get_plugins 时刷新 installed cache
    let _ = daemon_client::get_ipc_client()
        .plugin_get_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

/// 插件编辑器导出安装/覆盖后：按 pluginId 局部刷新缓存
#[tauri::command]
async fn refresh_installed_plugin_cache(plugin_id: String) -> Result<(), String> {
    // 触发一次 detail 加载，相当于"按 id 刷新缓存"
    let _ = daemon_client::get_ipc_client()
        .plugin_get_detail(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn get_plugin_icon(plugin_id: String) -> Result<Option<Vec<u8>>, String> {
    use base64::Engine;
    let v = daemon_client::get_ipc_client()
        .plugin_get_icon(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64_opt = v.get("base64").and_then(|x| x.as_str()).map(|s| s.to_string());
    let Some(b64) = b64_opt else { return Ok(None) };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    Ok(Some(bytes))
}

#[tauri::command]
fn plugin_editor_import_kgpg(file_path: String) -> Result<plugin_editor::PluginEditorImportResult, String> {
    plugin_editor::plugin_editor_import_kgpg(file_path)
}

#[tauri::command]
async fn plugin_editor_import_installed(plugin_id: String) -> Result<plugin_editor::PluginEditorImportResult, String> {
    // 通过 daemon 刷新缓存，然后读取文件
    let _ = daemon_client::get_ipc_client()
        .plugin_get_detail(plugin_id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    
    // 从插件目录读取文件
    let plugins_dir = kabegame_core::plugin::plugins_directory_for_readonly();
    let p = plugins_dir.join(format!("{}.kgpg", plugin_id));
    plugin_editor::plugin_editor_import_kgpg(p.to_string_lossy().to_string())
}

#[tauri::command]
async fn plugin_editor_export_install(
    overwrite: bool,
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    let plugins_dir = kabegame_core::plugin::plugins_directory_for_readonly();
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
    // 导出安装/覆盖后：通过 daemon 刷新缓存
    let _ = daemon_client::get_ipc_client()
        .plugin_get_detail(plugin_id_trimmed)
        .await;
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
fn plugin_editor_autosave_load() -> Result<Option<plugin_editor::PluginEditorImportResult>, String> {
    plugin_editor::plugin_editor_autosave_load()
}

#[tauri::command]
fn plugin_editor_autosave_clear() -> Result<(), String> {
    plugin_editor::plugin_editor_autosave_clear()
}

#[tauri::command]
async fn get_active_downloads() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client().get_active_downloads().await
}

#[tauri::command]
async fn cancel_task(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client().task_cancel(task_id).await
}

#[tauri::command]
async fn get_task_images(task_id: String) -> Result<Vec<ImageInfo>, String> {
    let v = daemon_client::get_ipc_client().storage_get_task_images(task_id).await?;
    serde_json::from_value(v).map_err(|e| format!("Failed to parse task images: {}", e))
}

#[tauri::command]
async fn add_task(task: TaskInfo) -> Result<(), String> {
    let task_v = serde_json::to_value(task).map_err(|e| format!("Failed to serialize task: {}", e))?;
    daemon_client::get_ipc_client().storage_add_task(task_v).await
}

#[tauri::command]
async fn get_task(task_id: String) -> Result<Option<TaskInfo>, String> {
    let v = daemon_client::get_ipc_client().storage_get_task(task_id).await?;
    serde_json::from_value(v).map_err(|e| format!("Failed to parse task: {}", e))
}

#[tauri::command]
async fn get_all_tasks() -> Result<Vec<TaskInfo>, String> {
    let v = daemon_client::get_ipc_client().storage_get_all_tasks().await?;
    serde_json::from_value(v).map_err(|e| format!("Failed to parse tasks: {}", e))
}

/// 将任务的 Rhai 失败 dump 标记为"已确认/已读"（用于任务列表右上角小按钮）
#[tauri::command]
async fn confirm_task_rhai_dump(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client().storage_confirm_task_rhai_dump(task_id).await
}

#[tauri::command]
async fn delete_task(task_id: String) -> Result<(), String> {
    // 先取消任务（如果正在运行）
    let _ = daemon_client::get_ipc_client().task_cancel(task_id.clone()).await;

    // 获取任务关联的图片 ID 列表
    let ids = daemon_client::get_ipc_client()
        .storage_get_task_image_ids(task_id.clone())
        .await
        .unwrap_or_default();
    
    // 删除任务
    daemon_client::get_ipc_client().storage_delete_task(task_id).await?;
    
    // 如果当前壁纸在被删除的图片中，清除当前壁纸设置
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if let Some(cur) = settings_v.get("current_wallpaper_image_id").and_then(|v| v.as_str()) {
        if ids.iter().any(|id| id == cur) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn delete_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client().storage_delete_image(image_id.clone()).await?;
    
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if settings_v.get("current_wallpaper_image_id").and_then(|v| v.as_str()) == Some(image_id.as_str()) {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
async fn remove_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client().storage_remove_image(image_id.clone()).await?;
    
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if settings_v.get("current_wallpaper_image_id").and_then(|v| v.as_str()) == Some(image_id.as_str()) {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
async fn batch_delete_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client().storage_batch_delete_images(image_ids.clone()).await?;
    
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if let Some(current_id) = settings_v.get("current_wallpaper_image_id").and_then(|v| v.as_str()) {
        if image_ids.contains(&current_id.to_string()) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn batch_remove_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client().storage_batch_remove_images(image_ids.clone()).await?;
    
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if let Some(current_id) = settings_v.get("current_wallpaper_image_id").and_then(|v| v.as_str()) {
        if image_ids.contains(&current_id.to_string()) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

/// 清除所有已完成、失败或取消的任务（保留 pending 和 running 的任务）
/// 返回被删除的任务数量
#[tauri::command]
async fn clear_finished_tasks() -> Result<usize, String> {
    daemon_client::get_ipc_client().storage_clear_finished_tasks().await
}

#[tauri::command]
async fn check_daemon_status() -> Result<serde_json::Value, String> {
    daemon_client::try_connect_daemon().await
}

#[tauri::command]
async fn get_settings() -> Result<AppSettings, String> {
    let v = daemon_client::get_ipc_client().settings_get().await?;
    serde_json::from_value(v).map_err(|e| format!("Failed to parse settings: {}", e))
}

#[tauri::command]
async fn get_setting(key: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client().settings_get_key(key).await
}

#[tauri::command]
fn get_favorite_album_id() -> Result<String, String> {
    Ok(kabegame_core::storage::FAVORITE_ALBUM_ID.to_string())
}

// ---- settings mutators (keep consistent with app-main; plugin-editor 需要可落盘配置) ----

#[tauri::command]
async fn set_max_concurrent_downloads(count: u32) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_max_concurrent_downloads(count)
        .await
}

#[tauri::command]
async fn set_network_retry_count(count: u32) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_network_retry_count(count)
        .await
}

#[tauri::command]
async fn set_auto_deduplicate(enabled: bool) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_auto_deduplicate(enabled)
        .await
}

#[tauri::command]
async fn set_default_download_dir(dir: Option<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .settings_set_default_download_dir(dir)
        .await
}

#[tauri::command]
async fn get_default_images_dir() -> Result<String, String> {
    // 通过 daemon 获取设置中的默认下载目录，如果没有则使用默认路径
    let settings_v = daemon_client::get_ipc_client().settings_get().await?;
    if let Some(dir) = settings_v.get("default_download_dir").and_then(|v| v.as_str()) {
        if !dir.is_empty() {
            return Ok(dir.to_string());
        }
    }
    
    // 如果没有设置，使用默认路径（与 Storage::get_images_dir 逻辑一致）
    // 注意：这里简化处理，直接使用应用数据目录，因为获取系统图片目录需要 dirs crate
    // 如果需要精确匹配 Storage 的逻辑，可以通过 daemon 获取
    let images_dir = kabegame_core::app_paths::kabegame_data_dir().join("images");
    
    Ok(images_dir
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
            // 启动 daemon（如果未运行）
            let app_handle = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                match daemon_client::ensure_daemon_ready(&app_handle).await {
                    Ok(_) => {
                        // 发送事件通知前端 daemon 已就绪
                        let _ = app_handle.emit("daemon-ready", serde_json::json!({}));
                        
                        // 初始化事件监听器（将 daemon IPC 事件转发为 Tauri 事件）
                        kabegame_core::ipc::init_event_listeners(app_handle.clone()).await;
                    }
                    Err(e) => {
                        eprintln!("[WARN] Failed to ensure daemon ready: {}", e);
                        // 获取 daemon 路径用于错误提示
                        let daemon_path = kabegame_core::daemon_startup::find_daemon_executable(Some(&app_handle))
                            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
                        // 发送事件通知前端 daemon 启动失败
                        let _ = app_handle.emit(
                            "daemon-startup-failed",
                            serde_json::json!({ 
                                "error": e,
                                "daemon_path": daemon_path.display().to_string()
                            }),
                        );
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // daemon status check
            check_daemon_status,
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
