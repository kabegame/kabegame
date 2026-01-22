// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

mod commands;
mod daemon_client;
mod event_listeners;
mod startup;
#[cfg(feature = "self-hosted")]
mod storage;
#[cfg(feature = "tray")]
mod tray;
mod wallpaper;

use commands::album::*;
use commands::daemon::*;
use commands::filesystem::{open_file_folder, open_file_path};
use commands::image::*;
use commands::misc::{clear_user_data, get_gallery_image, open_plugin_editor_window};
use commands::plugin::*;
#[cfg(feature = "self-hosted")]
use commands::settings::get_default_images_dir;
use commands::settings::*;
#[cfg(feature = "virtual-driver")]
use commands::settings::{set_album_drive_enabled, set_album_drive_mount_point};
#[cfg(feature = "self-hosted")]
use commands::storage::*;
use commands::task::*;
#[cfg(feature = "self-hosted")]
use commands::task::{local_add_task, local_get_all_tasks, local_get_task, local_update_task};
use commands::wallpaper::*;
#[cfg(target_os = "windows")]
use commands::wallpaper_engine::{export_album_to_we_project, export_images_to_we_project};
#[cfg(target_os = "windows")]
use commands::window::set_main_sidebar_blur;
#[cfg(target_os = "windows")]
use commands::window::wallpaper_window_ready;
use commands::window::*;

// ==================== Daemon IPC 命令（客户端侧 wrappers）====================
// 已迁移到 commands/daemon.rs

#[cfg(feature = "self-hosted")]
use kabegame_core::settings::Settings;
// app-main 默认只做 IPC client：不要直接依赖 kabegame_core::plugin（除非 self-hosted）
#[cfg(feature = "self-hosted")]
use kabegame_core::plugin;
#[cfg(feature = "self-hosted")]
use plugin::PluginManager;
#[cfg(feature = "self-hosted")]
use storage::images::PaginatedImages;
#[cfg(feature = "self-hosted")]
use storage::{Album, ImageInfo, Storage, TaskInfo};

// Wallpaper Engine 导出：走 daemon IPC（不直接依赖 core 的 Settings/Storage）
#[cfg(target_os = "windows")]
use wallpaper::WallpaperWindow;

#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
mod virtual_driver;
// 导入trait保证可用
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
use virtual_driver::{drive_service::VirtualDriveServiceTrait, VirtualDriveService};

use crate::commands::misc::{
    cancel_dedupe_gallery_by_hash_batched, start_dedupe_gallery_by_hash_batched,
};

// 任务失败图片（用于 TaskDetail 展示 + 重试）

// ---- wrappers: tauri::command 必须在当前 app crate 中定义，不能直接复用依赖 crate 的 command 宏产物 ----
// 所有命令已迁移到 commands 模块

// =========================
// Startup steps (split setup into small functions)
// =========================
// 启动步骤函数已迁移到 startup.rs

fn startup_steps(app: &mut tauri::App) {
    let is_cleaning_data = startup::startup_step_cleanup_user_data_if_marked(app.app_handle());
    #[cfg(feature = "self-hosted")]
    startup::startup_step_manage_plugin_manager(app);
    #[cfg(feature = "self-hosted")]
    startup::startup_step_manage_storage(app)?;
    #[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
    startup::startup_step_manage_virtual_drive_service(app);
    #[cfg(feature = "self-hosted")]
    startup::startup_step_manage_provider_runtime(app);
    #[cfg(feature = "self-hosted")]
    startup::startup_step_manage_settings(app);
    #[cfg(feature = "self-hosted")]
    startup::startup_step_warm_provider_cache(app.app_handle());
    #[cfg(feature = "self-hosted")]
    {
        // 本地 dedupe manager 已被 daemon-side DedupeService 替代
        // TODO: self hosted 需要加回来
    }
    startup::startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
    startup::startup_step_manage_wallpaper_components(app);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 启动连接状态监听任务（监听 IPC 连接状态变化）
            daemon_client::spawn_connection_status_watcher(app.app_handle().clone());

            // 确保 daemon 已启动并可用（如果不可用则自动启动）
            // 连接成功后启动事件监听器（统一连接入口）
            let app_handle_for_daemon = app.app_handle().clone();
            startup_steps(app);
            tauri::async_runtime::spawn(async move {
                println!("尝试连接 daemon...");
                // 先尝试检查 daemon 状态
                match daemon_client::try_connect_daemon().await {
                    Ok(_) => {
                        let timestamp = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();
                        println!("daemon 已就绪（status 检查成功）: {}", timestamp);
                        // 发送事件通知前端 daemon 已就绪
                        let _ = app_handle_for_daemon.emit("daemon-ready", serde_json::json!({}));
                        // 连接成功，启动事件监听器（使用统一连接）
                        daemon_client::init_event_listeners(app_handle_for_daemon.clone()).await;
                    }
                    Err(e) => {
                        // status 检查失败，尝试重启 daemon
                        println!("daemon 不可用，尝试重启...: {}", e);
                        match daemon_client::ensure_daemon_ready().await {
                            Ok(_) => {
                                eprintln!("daemon 已就绪（重启成功）");
                                // 连接成功，启动事件监听器（使用统一连接）
                                daemon_client::init_event_listeners(app_handle_for_daemon.clone())
                                    .await;
                                // 发送事件通知前端 daemon 已就绪
                                let _ = app_handle_for_daemon
                                    .emit("daemon-ready", serde_json::json!({}));
                            }
                            Err(_) => {
                                eprintln!("[WARN] 启动 daemon 失败，进入离线状态");
                                // 发送事件通知前端 daemon 离线
                                let _ = app_handle_for_daemon
                                    .emit("daemon-offline", serde_json::json!({}));
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ========== Daemon IPC 命令（需要 daemon 运行）==========
            check_daemon_status,
            reconnect_daemon,
            get_images,
            get_images_paginated,
            get_albums,
            add_album,
            delete_album,
            get_all_tasks,
            get_task,
            add_task,
            update_task,
            delete_task,
            // ========== 仍保留的本地命令（非 daemon 范围）==========
            confirm_task_rhai_dump,
            clear_finished_tasks,
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            // retry_task_failed_image（本地下载队列）已迁移到 daemon
            // 原有命令
            get_plugins,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_build_mode,
            delete_plugin,
            // crawl_images_command（本地任务调度）已迁移到 daemon
            get_images_range,
            browse_gallery_provider,
            get_image_by_id,
            rename_album,
            add_images_to_album,
            remove_images_from_album,
            get_album_images,
            get_album_image_ids,
            get_album_preview,
            get_album_counts,
            commands::filesystem::open_explorer,
            get_images_count,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            // start/cancel_dedupe_*（本地去重）已迁移到 daemon
            toggle_image_favorite,
            update_album_images_order,
            open_file_path,
            open_file_folder,
            set_wallpaper,
            set_wallpaper_by_image_id,
            get_current_wallpaper_image_id,
            clear_current_wallpaper_image_id,
            get_image_local_path_by_id,
            get_current_wallpaper_path,
            #[cfg(feature = "self-hosted")]
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
            get_favorite_album_id,
            // ========== Settings getters（前端 settings store 依赖）==========
            // deprecated 但保留：避免旧前端直接报 command not found
            get_settings,
            get_setting,
            get_auto_launch,
            get_max_concurrent_downloads,
            get_network_retry_count,
            get_image_click_action,
            get_gallery_image_aspect_ratio,
            get_auto_deduplicate,
            get_default_download_dir,
            get_wallpaper_engine_dir,
            get_wallpaper_rotation_enabled,
            get_wallpaper_rotation_album_id,
            get_wallpaper_rotation_interval_minutes,
            get_wallpaper_rotation_mode,
            get_wallpaper_rotation_style,
            get_wallpaper_rotation_transition,
            get_wallpaper_style_by_mode,
            get_wallpaper_transition_by_mode,
            get_wallpaper_mode,
            get_window_state,
            #[cfg(feature = "virtual-driver")]
            get_album_drive_enabled,
            #[cfg(feature = "virtual-driver")]
            get_album_drive_mount_point,
            set_auto_launch,
            #[cfg(feature = "virtual-driver")]
            set_album_drive_enabled,
            #[cfg(feature = "virtual-driver")]
            set_album_drive_mount_point,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_image_click_action,
            set_gallery_image_aspect_ratio,
            get_desktop_resolution,
            start_task,
            set_auto_deduplicate,
            set_default_download_dir,
            set_wallpaper_engine_dir,
            get_wallpaper_engine_myprojects_dir,
            open_plasma_wallpaper_settings,
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
            get_wallpaper_rotator_status,
            get_native_wallpaper_styles,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            set_main_sidebar_blur,
            hide_main_window,
            open_plugin_editor_window,
            #[cfg(target_os = "windows")]
            fix_wallpaper_zorder,
            start_dedupe_gallery_by_hash_batched,
            cancel_dedupe_gallery_by_hash_batched,
            // Wallpaper Engine 导出
            #[cfg(target_os = "windows")]
            export_album_to_we_project,
            #[cfg(target_os = "windows")]
            export_images_to_we_project,
            clear_user_data,
            // Debug: 生成大量测试图片数据
            // 注意：debug_clone_images 依赖本地 storage 扩展（已迁移期移除）
        ])
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            // 监听窗口关闭事件
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 阻止默认关闭行为
                    api.prevent_close();
                    // 不保存 window_state：用户要求每次居中弹出

                    // 隐藏主窗口（直接隐藏，不关闭）
                    if let Err(e) = window.hide() {
                        eprintln!("隐藏主窗口失败: {}", e);
                    } else {
                        // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
                        #[cfg(target_os = "windows")]
                        {
                            let app_handle = window.app_handle().clone();
                            tauri::async_runtime::spawn(async move {
                                commands::window::fix_wallpaper_window_zorder(app_handle).await;
                            });
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
