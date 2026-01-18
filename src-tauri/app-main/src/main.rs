// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

#[cfg(feature = "self-host")]
mod storage;
#[cfg(feature = "tray")]
mod tray;
mod wallpaper;
mod daemon_client;
mod event_listeners;
mod commands;
mod startup;

// 导入命令模块（使用具体函数名避免冲突）
use commands::daemon::{
    check_daemon_status, get_images, get_images_paginated, get_albums, add_album, delete_album,
    get_all_tasks, get_task, add_task, update_task, delete_task, get_images_range,
    browse_gallery_provider, get_image_by_id, start_task,
};
use commands::plugin::{
    get_plugins, refresh_installed_plugins_cache, refresh_installed_plugin_cache,
    get_build_mode, delete_plugin, get_browser_plugins, get_plugin_sources, save_plugin_sources,
    get_store_plugins, get_plugin_detail, validate_plugin_source, preview_import_plugin,
    preview_store_install, import_plugin_from_zip, install_browser_plugin, get_plugin_image,
    get_plugin_image_for_detail, get_plugin_icon, get_remote_plugin_icon, get_plugin_vars,
};
use commands::filesystem::{open_file_path, open_file_folder};
use commands::window::{
    hide_main_window, fix_wallpaper_zorder, copy_files_to_clipboard,
};
#[cfg(target_os = "windows")]
use commands::window::wallpaper_window_ready;
use commands::window::set_main_sidebar_dwm_blur;
#[cfg(feature = "virtual-drive")]
use commands::virtual_drive::{mount_virtual_drive, unmount_virtual_drive, mount_virtual_drive_and_open_explorer};
#[cfg(feature = "self-host")]
use commands::storage::{local_get_images, local_get_images_paginated, local_get_albums, local_add_album, local_delete_album, migrate_images_from_json};
use commands::wallpaper::{
    set_wallpaper, set_wallpaper_by_image_id,
    get_current_wallpaper_image_id, clear_current_wallpaper_image_id, get_current_wallpaper_path,
    set_wallpaper_rotation_album_id, start_wallpaper_rotation, set_wallpaper_rotation_interval_minutes,
    set_wallpaper_rotation_mode, set_wallpaper_style, set_wallpaper_rotation_transition,
    set_wallpaper_mode, get_wallpaper_rotator_status, get_native_wallpaper_styles,
    set_wallpaper_rotation_enabled,
};
use commands::album::{
    rename_album, add_images_to_album, remove_images_from_album, get_album_images,
    get_album_image_ids, get_album_preview, get_album_counts, update_album_images_order,
};
use commands::image::{
    get_images_count, delete_image, remove_image, batch_delete_images, batch_remove_images,
    toggle_image_favorite, get_image_local_path_by_id,
};
use commands::settings::{
    get_settings, get_setting, get_favorite_album_id, set_auto_launch,
    set_max_concurrent_downloads, set_network_retry_count, set_image_click_action,
    set_gallery_image_aspect_ratio_match_window, set_gallery_image_aspect_ratio,
    get_desktop_resolution, set_auto_deduplicate, set_default_download_dir,
    set_wallpaper_engine_dir, get_wallpaper_engine_myprojects_dir, open_plasma_wallpaper_settings,
};
#[cfg(feature = "virtual-drive")]
use commands::settings::{set_album_drive_enabled, set_album_drive_mount_point};
#[cfg(feature = "self-host")]
use commands::settings::get_default_images_dir;
use commands::task::{
    add_run_config, update_run_config, get_run_configs, delete_run_config, cancel_task,
    get_active_downloads, confirm_task_rhai_dump, clear_finished_tasks, get_task_images,
    get_task_images_paginated, get_task_image_ids, get_task_failed_images,
};
#[cfg(feature = "self-host")]
use commands::task::{local_add_task, local_update_task, local_get_task, local_get_all_tasks};
#[cfg(target_os = "windows")]
use commands::wallpaper_engine::{export_album_to_we_project, export_images_to_we_project};
use commands::misc::{clear_user_data, open_plugin_editor_window, get_gallery_image};

// ==================== Daemon IPC 命令（客户端侧 wrappers）====================
// 已迁移到 commands/daemon.rs

#[cfg(feature = "self-host")]
use kabegame_core::settings::Settings;
// app-main 默认只做 IPC client：不要直接依赖 kabegame_core::plugin（除非 self-host）
#[cfg(feature = "self-host")]
use kabegame_core::plugin;
#[cfg(feature = "self-host")]
use plugin::PluginManager;
#[cfg(feature = "self-host")]
use storage::images::PaginatedImages;
#[cfg(feature = "self-host")]
use storage::{Album, ImageInfo, Storage, TaskInfo};
#[cfg(target_os = "windows")]
use wallpaper::WallpaperWindow;

// Wallpaper Engine 导出：走 daemon IPC（不直接依赖 core 的 Settings/Storage）
#[cfg(feature = "virtual-drive")]
mod virtual_drive;
// 导入trait保证可用
#[cfg(feature = "virtual-drive")]
use virtual_drive::{drive_service::VirtualDriveServiceTrait, VirtualDriveService};

use crate::commands::misc::{cancel_dedupe_gallery_by_hash_batched, start_dedupe_gallery_by_hash_batched};

// 任务失败图片（用于 TaskDetail 展示 + 重试）

// ---- wrappers: tauri::command 必须在当前 app crate 中定义，不能直接复用依赖 crate 的 command 宏产物 ----
// 所有命令已迁移到 commands 模块

// =========================
// Startup steps (split setup into small functions)
// =========================
// 启动步骤函数已迁移到 startup.rs

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let is_cleaning_data = startup::startup_step_cleanup_user_data_if_marked(app.app_handle());
            #[cfg(feature = "self-host")]
            startup::startup_step_manage_plugin_manager(app);
            #[cfg(feature = "self-host")]
            startup::startup_step_manage_storage(app)?;
            #[cfg(feature = "virtual-drive")]
            startup::startup_step_manage_virtual_drive_service(app);
            #[cfg(feature = "self-host")]
            startup::startup_step_manage_provider_runtime(app);
            #[cfg(feature = "self-host")]
            startup::startup_step_manage_settings(app);
            #[cfg(feature = "self-host")]
            startup::startup_step_warm_provider_cache(app.app_handle());
            #[cfg(feature = "virtual-drive")]
            startup::startup_step_auto_mount_album_drive(app.app_handle());
            #[cfg(feature = "self-host")]
            {
                // 本地 dedupe manager 已被 daemon-side DedupeService 替代
                // TODO: self hosted 需要加回来
            }
            startup::startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
            startup::startup_step_manage_wallpaper_components(app);

            // 确保 daemon 已启动并可用（如果不可用则自动启动）
            let app_handle_for_daemon = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                match daemon_client::ensure_daemon_ready(&app_handle_for_daemon).await {
                    Ok(_) => {
                        // 发送事件通知前端 daemon 已就绪
                        let _ = app_handle_for_daemon.emit("daemon-ready", serde_json::json!({}));
                    }
                    Err(e) => {
                        eprintln!("[WARN] 启动 daemon 失败: {}", e);
                        // 获取 daemon 路径用于错误提示
                        let daemon_path = kabegame_core::daemon_startup::find_daemon_executable(Some(&app_handle_for_daemon))
                            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
                        // 发送事件通知前端 daemon 启动失败
                        let _ = app_handle_for_daemon.emit(
                            "daemon-startup-failed",
                            serde_json::json!({ 
                                "error": e,
                                "daemon_path": daemon_path.display().to_string()
                            }),
                        );
                    }
                }
            });

            // 启动事件监听器（从 daemon 轮询事件并转发到前端）
            let app_handle_for_events = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                event_listeners::init_event_listeners(app_handle_for_events).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ========== Daemon IPC 命令（需要 daemon 运行）==========
            check_daemon_status,
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
            // 虚拟盘
            #[cfg(feature = "virtual-drive")]
            mount_virtual_drive,
            #[cfg(feature = "virtual-drive")]
            unmount_virtual_drive,
            #[cfg(feature = "virtual-drive")]
            mount_virtual_drive_and_open_explorer,
            // TODO: 跨平台实现
            #[cfg(target_os = "windows")]
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
            #[cfg(feature = "self-host")]
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
            #[cfg(feature = "virtual-drive")]
            set_album_drive_enabled,
            #[cfg(feature = "virtual-drive")]
            set_album_drive_mount_point,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_image_click_action,
            set_gallery_image_aspect_ratio_match_window,
            set_gallery_image_aspect_ratio,
            get_desktop_resolution,
            start_task,
            set_auto_deduplicate,
            set_default_download_dir,
            set_wallpaper_engine_dir,
            get_wallpaper_engine_myprojects_dir,
            open_plasma_wallpaper_settings,
            #[cfg(feature = "self-host")]
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
            set_main_sidebar_dwm_blur,
            hide_main_window,
            open_plugin_editor_window,
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



