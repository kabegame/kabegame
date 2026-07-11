// Shared modules (local + web)
pub(crate) mod core_init;

#[cfg(feature = "web")]
pub(crate) mod web;

// Web mode entry
#[cfg(feature = "web")]
mod web_assets;
#[cfg(feature = "web")]
mod web_import;

// Local (Tauri native) modules
#[cfg(not(feature = "web"))]
mod commands;

mod commands_core;
mod debug_ingest;

#[cfg(all(not(feature = "web"), target_os = "android"))]
mod compress_provider;
#[cfg(all(not(feature = "web"), target_os = "android"))]
mod content_io_provider;
#[cfg(any(not(target_os = "android"), not(feature = "web")))]
mod http_server;
mod ipc;
#[cfg(all(not(feature = "web"), target_os = "linux"))]
mod linux_desktop;
#[cfg(not(target_os = "android"))]
mod mcp_server;
pub mod startup;
#[cfg(all(not(feature = "web"), not(mobile)))]
mod tray;
#[cfg(all(not(feature = "web"), not(target_os = "android")))]
mod updater;
#[cfg(not(feature = "web"))]
mod utils;
#[cfg(feature = "standard")]
mod vd_listener;
#[cfg(not(feature = "web"))]
mod wallpaper;

// ---- local-only imports ----
#[cfg(not(feature = "web"))]
use commands::*;

/// 本次构建实际使用的 Tauri `Runtime` 具体类型。
///
/// 用于**不能带自由泛型 `<R>` 的场景**(全局单例 `static`、长期持有 `AppHandle`
/// 的结构体)。命令/函数仍优先用 `<R: Runtime>` 泛型;只有像 `WallpaperRotator`
/// 这种存进全局 `OnceLock` 的才用本别名。
///
/// 桌面 standard/light → CEF;Android → Wry。两条 run 路径分别用
/// `Builder::<Cef<EventLoopMessage>>` / `Builder::default()`,与此别名一致。
#[cfg(all(
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
pub(crate) type AppRuntime = tauri_runtime_cef::Cef<tauri::EventLoopMessage>;
#[cfg(all(
    not(feature = "web"),
    not(all(
        any(target_os = "linux", target_os = "windows", target_os = "macos"),
        feature = "standard"
    ))
))]
pub(crate) type AppRuntime = tauri::Wry;
#[cfg(not(feature = "web"))]
use core::fmt;
#[cfg(not(feature = "web"))]
use http_server::get_http_server_base_url;
use startup::*;
use std::process;
#[cfg(not(feature = "web"))]
use std::sync::Arc;
#[cfg(not(feature = "web"))]
use tauri::{AppHandle, Emitter, Listener, Manager};
#[cfg(all(not(feature = "web"), not(target_os = "android")))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg(all(not(feature = "web"), not(target_os = "android")))]
use crate::ipc::handlers::dispatch_request;
#[cfg(all(not(feature = "web"), not(target_os = "android")))]
use kabegame_core::ipc::events::{DaemonEvent, DaemonEventKind};
#[cfg(all(not(feature = "web"), not(target_os = "android")))]
use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
#[cfg(all(not(feature = "web"), not(target_os = "android")))]
use kabegame_core::storage::organize::OrganizeService;

#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;

#[cfg(not(target_os = "android"))]
use axum::{routing::get, Router};
use std::net::SocketAddr;

fn init(
    #[cfg(not(feature = "web"))] app: &mut tauri::App<crate::AppRuntime>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    // 若有清理标记，必须在 init_globals 之前清理 data/cache，否则 DB 等已打开无法删除
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    let _ = cleanup_user_data_if_marked();

    #[cfg(feature = "web")]
    crate::core_init::init_app_paths_for_web()?;

    // 启动内置 Backend
    crate::core_init::init_globals()?;
    crate::debug_ingest::spawn_debug_event(
        std::env::var("KABEGAME_DEBUG_SESSION_ID").unwrap_or_else(|_| "backend".to_string()),
        "backend_started",
        serde_json::json!({
            "pid": process::id(),
            "feature_web": cfg!(feature = "web"),
            "debug_assertions": cfg!(debug_assertions),
        }),
    );
    // 在初始化全局状态后、初始化壁纸控制器前，检测并缓存 Linux 桌面环境
    #[cfg(all(target_os = "linux", not(feature = "web")))]
    {
        crate::linux_desktop::init_linux_desktop();
    }

    // 公共步骤
    start_event_loop(
        #[cfg(not(feature = "web"))]
        app.app_handle().clone(),
    );
    // 命令行带 --minimized 时不创建主窗口，避免窗口闪现；托盘/IPC 显示时由 ensure_main_window 再创建
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    if !startup::is_auto_startup() {
        if let Err(e) = create_main_window(&app.app_handle()) {
            return Err(Box::new(std::io::Error::other(e)));
        }
    }
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    if let Err(e) = init_crawler_webview_handler(app.app_handle().clone()) {
        eprintln!("Failed to init crawler webview handler: {}", e);
    }
    // 初始化壁纸控制器
    #[cfg(not(feature = "web"))]
    init_wallpaper_controller(app);
    // 启动 TaskScheduler（启动 DownloadQueue 的 worker）
    start_task_scheduler();
    // 初始化download worker
    init_download_workers();
    // 初始化任务阻塞worker线程池
    start_download_workers();
    // 启动事件转发任务
    start_event_forward_task();

    // 首次启动：处理打开kgpg文件启动参数（仅local）
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    if let Some(path) = startup::extract_kgpg_file_from_args() {
        let app_handle_clone = app.app_handle().clone();
        // 等待前端准备好
        app.app_handle().once("app-ready", move |_| {
            let _ = app_handle_clone.emit(
                "app-import-plugin",
                serde_json::json!({
                    "kgpgPath": path
                }),
            );
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        #[cfg(not(feature = "web"))]
        tauri::async_runtime::spawn(async {
            if let Err(e) = mcp_server::start_mcp_server().await {
                eprintln!("Failed to start MCP server: {}", e);
            }
        });

        startup::start_ipc_server(
            #[cfg(not(feature = "web"))]
            app.app_handle().clone(),
        );
    }
    #[cfg(all(target_os = "android", not(feature = "web")))]
    {
        let provider = content_io_provider::PickerContentIoProvider::new(app.app_handle().clone());
        let proxy = content_io_provider::ChannelContentIoProvider::new(provider);
        // 设置内容IO提供者
        kabegame_core::crawler::content_io::set_content_io_provider(Box::new(proxy));

        let compress_provider =
            compress_provider::PluginVideoCompressProvider::new(app.app_handle().clone());
        let compress_proxy =
            compress_provider::ChannelVideoCompressProvider::new(compress_provider);
        if let Err(e) =
            kabegame_core::crawler::downloader::compress::set_android_video_compress_provider(
                Arc::new(compress_proxy),
            )
        {
            eprintln!("[VideoCompress] Failed to set android compress provider: {e}");
        }
    }

    spawn_startup_local_folder_sync();
    spawn_realtime_folder_sync_if_enabled();

    // 桌面端自动更新：初始化后端权威状态机单例 + 启动首检&24h 调度
    #[cfg(all(not(feature = "web"), not(target_os = "android")))]
    {
        let _ = updater::UpdaterService::init_global(std::sync::Arc::new(
            updater::UpdaterService::new(),
        ));
        updater::spawn_schedule();
    }

    // 初始化插件缓存
    init_kgpg_plugin();

    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    tauri::async_runtime::block_on(http_server::start_http_server())
        .map_err(|e| format!("Cannot start http server: {}", e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_startup_local_folder_sync() {
    let fut = async {
        let reports = kabegame_core::local_folder::sync_all_local_folder_albums().await;
        if !reports.is_empty() {
            let added: usize = reports.iter().map(|report| report.added).sum();
            let deleted: usize = reports.iter().map(|report| report.deleted).sum();
            let reimported: usize = reports.iter().map(|report| report.reimported).sum();
            let skipped_unchanged = reports
                .iter()
                .filter(|report| report.skipped_unchanged)
                .count();
            println!(
                "[local_folder] startup sync done: {} albums, +{added}/-{deleted}/~{reimported}, skipped_unchanged={skipped_unchanged}",
                reports.len()
            );
        }
    };

    #[cfg(feature = "web")]
    tokio::spawn(fut);
    #[cfg(not(feature = "web"))]
    tauri::async_runtime::spawn(fut);
}

#[cfg(not(target_os = "macos"))]
fn spawn_startup_local_folder_sync() {}

#[cfg(all(
    not(feature = "web"),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn spawn_realtime_folder_sync_if_enabled() {
    tauri::async_runtime::spawn(async {
        if kabegame_core::settings::Settings::global().get_realtime_folder_sync() {
            kabegame_core::local_folder::watch::set_enabled(true).await;
        }
    });
}

#[cfg(not(all(
    not(feature = "web"),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
)))]
fn spawn_realtime_folder_sync_if_enabled() {}

// ---- web entry point ----
#[cfg(feature = "web")]
pub fn run() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");

    rt.block_on(async move {
        if let Err(e) = init() {
            eprintln!("服务器初始化失败: {}", e);
            process::exit(1);
        }

        tokio::spawn(async { crate::web_import::gc_stale_uploads().await });

        // web 无前端弹窗确认：启动时自动触发所有漏跑的定时任务
        tokio::spawn(async {
            match kabegame_core::scheduler::collect_missed_runs_now() {
                Ok(items) if !items.is_empty() => {
                    let ids: Vec<String> = items.iter().map(|i| i.config_id.clone()).collect();
                    println!("  ✓ Auto-running {} missed schedule(s)", ids.len());
                    kabegame_core::scheduler::run_missed_configs(&ids);
                    let _ = kabegame_core::scheduler::Scheduler::global()
                        .reload_config("")
                        .await;
                }
                Ok(_) => {}
                Err(e) => eprintln!("  ✗ Failed to collect missed runs: {e}"),
            }
        });

        let router = Router::new()
            .route("/__ping", get(|| async { "ok" }))
            .merge(crate::http_server::file_routes_web())
            .merge(crate::web_import::api_routes())
            .merge(crate::mcp_server::mcp_nest())
            .merge(crate::web::web_routes())
            .fallback_service(crate::web_assets::static_assets_router());

        let addr: SocketAddr = "0.0.0.0:7490".parse().unwrap();
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("Failed to bind 0.0.0.0:7490");
        println!("  ✓ Web server listening on {addr}");
        axum::serve(listener, router)
            .await
            .expect("Web server exited unexpectedly");
    });
}

// ---- local (Tauri) entry point ----

#[cfg(all(
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
pub fn run() {
    // 不再手动 push "main" 窗口:base config `windows: []`,主窗口由 setup 的
    // `startup::create_main_window` 统一创建(与 Wry 路径完全一致)。Phase 3 minimal
    // 时没挂 setup 才需要那个临时 window push;4.2 挂上 configure_app 后,push 会和
    // create_main_window 撞 "main" label 导致窗口创建失败 → 黑屏。
    let ctx = tauri::generate_context!();
    let app = configure_app(tauri::Builder::<crate::AppRuntime>::new())
        .build(ctx)
        .expect("error while building tauri CEF application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        handle_macos_run_event(app_handle, event);
    });
}

#[cfg(all(not(feature = "web"), target_os = "macos"))]
fn handle_macos_run_event(app_handle: &tauri::AppHandle<AppRuntime>, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::Reopen { .. } => {
            if let Err(e) = startup::ensure_main_window(app_handle.clone()) {
                eprintln!("[macOS] Dock 点击显示主窗口失败: {e}");
            }
        }
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    use std::ffi::OsStr;

                    if path.extension() == Some(OsStr::new("kgpg")) {
                        let _ = app_handle.emit(
                            "app-import-plugin",
                            serde_json::json!({ "kgpgPath": path.to_string_lossy() }),
                        );
                    } else {
                        eprintln!("[KGPG_DEBUG] [macOS] ✗ 无法将路径转换为字符串: {:?}", path);
                    }
                } else {
                    eprintln!("[KGPG_DEBUG] [macOS] ✗ 无法从 URL 提取文件路径: {url}");
                }
            }
        }
        _ => {}
    }
}

/// 把全套插件 / setup / invoke_handler 装进 builder。Wry 与 CEF(Linux)两条 run
/// 路径共用它,保证 CEF 下后端能力与 Wry 完全一致。`crate::AppRuntime` 按 cfg 解析为
/// `Wry` 或 `Cef`,因此本函数在每个具体 build 里是单态的。
#[cfg(not(feature = "web"))]
pub(crate) fn configure_app(
    builder: tauri::Builder<crate::AppRuntime>,
) -> tauri::Builder<crate::AppRuntime> {
    // 先注册 pathes，在 .setup() 前完成 AppPaths 初始化，供 Settings/Storage 等使用
    let mut builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_pathes::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_picker::init());
        builder = builder.plugin(tauri_plugin_share::init());
        builder = builder.plugin(tauri_plugin_compress::init());
        builder = builder.plugin(tauri_plugin_wallpaper::init());
        builder = builder.plugin(tauri_plugin_task_notification::init());
        builder = builder.plugin(tauri_plugin_android_battery_optimization::init());
    }

    #[cfg(not(target_os = "android"))]
    {
        // builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
        // 爬虫窗口关闭时仅隐藏不销毁，便于设置中再次打开；遨游窗口关闭时清除会话状态并通知前端
        builder = builder.on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label().starts_with("crawler-") {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label().starts_with("surf-") {
                    commands::surf::notify_surf_session_closed(
                        &window.app_handle(),
                        Some(window.label()),
                    );
                }
            }
            _ => {}
        });
    }

    builder
        .setup(|app| {
            if let Err(e) = init(app) {
                #[cfg(not(feature = "web"))]
                utils::show_error(
                    app.app_handle(),
                    kabegame_i18n::t!("dialog.initFatalError", detail = e.to_string()),
                );
                eprintln!("应用初始化过程中出现了错误！:{}", e);
            }
            Ok(())
        })
        // 维护这些命令还要维护 permissions/main.toml
        .invoke_handler(tauri::generate_handler![
            // --- Albums ---
            get_albums,
            add_album,
            delete_album,
            rename_album,
            move_album,
            get_album_preview,
            add_images_to_album,
            add_task_images_to_album,
            remove_images_from_album,
            update_album_images_order,
            get_favorite_album_id,
            #[cfg(all(not(target_os = "android"), not(feature = "web")))]
            add_local_folder_album,
            sync_local_folder_album,
            sync_local_folder_albums,
            // --- Images ---
            get_image_by_id,
            get_image_metadata,
            get_image_metadata_full,
            get_gallery_image,
            copy_image_to_clipboard,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            get_images_count,
            get_gallery_plugin_groups,
            get_gallery_media_type_counts,
            get_album_media_type_counts,
            get_gallery_time_filter_data,
            pathql_entry,
            pathql_list,
            pathql_fetch,
            toggle_image_favorite,
            // --- Tasks ---
            get_all_tasks,
            get_tasks_page,
            get_task,
            add_task,
            delete_task,
            start_task,
            cancel_task,
            clear_finished_tasks,
            get_task_failed_images,
            get_all_failed_images,
            get_task_logs,
            retry_task_failed_image,
            retry_failed_images,
            cancel_retry_failed_image,
            cancel_retry_failed_images,
            delete_failed_images,
            delete_task_failed_image,
            get_active_downloads,
            #[cfg(not(target_os = "android"))]
            surf_start_session,
            #[cfg(not(target_os = "android"))]
            surf_close_session,
            #[cfg(not(target_os = "android"))]
            surf_get_session_status,
            #[cfg(not(target_os = "android"))]
            surf_list_records,
            #[cfg(not(target_os = "android"))]
            surf_get_all_records,
            #[cfg(not(target_os = "android"))]
            surf_get_records_by_ids,
            #[cfg(not(target_os = "android"))]
            surf_get_record,
            #[cfg(not(target_os = "android"))]
            surf_get_record_images,
            #[cfg(not(target_os = "android"))]
            surf_update_root_url,
            #[cfg(not(target_os = "android"))]
            surf_update_name,
            #[cfg(not(target_os = "android"))]
            surf_delete_record,
            #[cfg(not(target_os = "android"))]
            surf_get_cookies,
            #[cfg(not(target_os = "android"))]
            surf_open_devtools,
            #[cfg(not(target_os = "android"))]
            surf_go_back,
            #[cfg(not(target_os = "android"))]
            surf_go_forward,
            #[cfg(not(target_os = "android"))]
            surf_reload,
            #[cfg(not(target_os = "android"))]
            surf_navigate,
            #[cfg(not(target_os = "android"))]
            surf_report_url,
            // --- Run Configs ---
            get_run_configs,
            get_run_config,
            add_run_config,
            update_run_config,
            delete_run_config,
            copy_run_config,
            get_missed_runs,
            run_missed_configs,
            dismiss_missed_configs,
            // --- Plugins ---
            get_plugins,
            refresh_plugins,
            get_plugin_detail,
            delete_plugin,
            install_from_store,
            get_plugin_sources,
            get_plugin_data,
            add_plugin_source,
            update_plugin_source,
            delete_plugin_source,
            validate_plugin_source,
            get_store_plugins,
            preview_import_plugin,
            preview_store_install,
            import_plugin_from_zip,
            get_remote_plugin_icon,
            get_plugin_default_config,
            ensure_plugin_default_config,
            save_plugin_default_config,
            reset_plugin_default_config,
            get_build_mode,
            // --- Settings ---
            get_settings,
            get_language,
            set_language,
            get_auto_launch,
            set_auto_launch,
            get_auto_open_crawler_webview,
            set_auto_open_crawler_webview,
            get_import_recommended_schedule_enabled,
            set_import_recommended_schedule_enabled,
            get_max_concurrent_downloads,
            set_max_concurrent_downloads,
            get_max_concurrent_tasks,
            set_max_concurrent_tasks,
            get_download_interval_ms,
            set_download_interval_ms,
            get_network_retry_count,
            set_network_retry_count,
            get_image_click_action,
            set_image_click_action,
            get_gallery_image_aspect_ratio,
            set_gallery_image_aspect_ratio,
            get_gallery_image_object_position,
            set_gallery_image_object_position,
            get_auto_deduplicate,
            set_auto_deduplicate,
            get_realtime_folder_sync,
            set_realtime_folder_sync,
            get_default_download_dir,
            set_default_download_dir,
            get_default_images_dir,
            get_desktop_resolution,
            #[cfg(not(target_os = "android"))]
            clear_user_data,
            // --- Wallpaper ---
            // set_wallpaper,
            set_wallpaper_mode,
            set_wallpaper_by_image_id,
            get_current_wallpaper_image_id,
            clear_current_wallpaper_image_id,
            get_current_wallpaper_path,
            set_wallpaper_rotation_enabled,
            get_wallpaper_rotation_enabled,
            set_wallpaper_rotation_album_id,
            get_wallpaper_rotation_album_id,
            set_wallpaper_rotation_include_subalbums,
            get_wallpaper_rotation_include_subalbums,
            start_wallpaper_rotation,
            set_wallpaper_rotation_interval_minutes,
            get_wallpaper_rotation_interval_minutes,
            set_wallpaper_rotation_mode,
            get_wallpaper_rotation_mode,
            set_wallpaper_style,
            get_wallpaper_style_by_mode,
            get_wallpaper_rotation_style,
            set_wallpaper_rotation_transition,
            get_wallpaper_rotation_transition,
            get_wallpaper_transition_by_mode,
            get_wallpaper_mode,
            get_wallpaper_volume,
            set_wallpaper_volume,
            get_wallpaper_video_playback_rate,
            set_wallpaper_video_playback_rate,
            get_wallpaper_disabled,
            set_wallpaper_disabled,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            fix_wallpaper_zorder,
            // --- Virtual Drive ---
            #[cfg(feature = "standard")]
            get_album_drive_enabled,
            #[cfg(feature = "standard")]
            set_album_drive_enabled,
            #[cfg(feature = "standard")]
            get_album_drive_mount_point,
            #[cfg(feature = "standard")]
            set_album_drive_mount_point,
            #[cfg(feature = "standard")]
            get_album_drive_driver_installed,
            #[cfg(all(feature = "standard", target_os = "windows"))]
            install_album_drive_driver,
            // --- Window ---
            hide_main_window,
            #[cfg(not(target_os = "android"))]
            toggle_fullscreen,
            get_window_state,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            wallpaper_window_ready,
            // --- Filesystem ---
            open_explorer,
            open_file_path,
            open_file_folder,
            open_album_virtual_drive_folder,
            // --- Misc ---
            exit_app,
            #[cfg(not(target_os = "android"))]
            check_for_updates,
            #[cfg(not(target_os = "android"))]
            get_updater_state,
            #[cfg(not(target_os = "android"))]
            download_update,
            #[cfg(not(target_os = "android"))]
            cancel_download,
            #[cfg(not(target_os = "android"))]
            apply_update_and_restart,
            #[cfg(not(target_os = "android"))]
            open_dev_webview,
            #[cfg(not(target_os = "android"))]
            crawl_get_context,
            #[cfg(not(target_os = "android"))]
            crawl_run_script,
            #[cfg(not(target_os = "android"))]
            crawl_exit,
            #[cfg(not(target_os = "android"))]
            crawl_error,
            #[cfg(not(target_os = "android"))]
            crawl_task_log,
            #[cfg(not(target_os = "android"))]
            crawl_add_progress,
            #[cfg(not(target_os = "android"))]
            crawl_download_image,
            #[cfg(not(target_os = "android"))]
            surf_download_image,
            #[cfg(not(target_os = "android"))]
            crawl_media_begin,
            #[cfg(not(target_os = "android"))]
            crawl_media_chunk,
            #[cfg(not(target_os = "android"))]
            crawl_media_end,
            #[cfg(not(target_os = "android"))]
            crawl_to,
            #[cfg(not(target_os = "android"))]
            crawl_back,
            #[cfg(not(target_os = "android"))]
            crawl_update_page_state,
            #[cfg(not(target_os = "android"))]
            crawl_update_state,
            #[cfg(not(target_os = "android"))]
            crawl_page_ready,
            #[cfg(not(target_os = "android"))]
            crawl_clear_site_data,
            #[cfg(not(target_os = "android"))]
            show_crawler_window,
            get_file_drop_supported_types,
            get_file_drop_kinds,
            proxy_fetch,
            get_supported_image_types,
            set_supported_image_formats,
            get_linux_desktop_env,
            is_plasma_wallpaper_plugin_installed,
            get_http_server_base_url,
            #[cfg(not(target_os = "android"))]
            start_organize,
            #[cfg(not(target_os = "android"))]
            get_organize_total_count,
            #[cfg(not(target_os = "android"))]
            get_organize_run_state,
            #[cfg(not(target_os = "android"))]
            cancel_organize,
            // --- Share (Android) ---
            #[cfg(target_os = "android")]
            share_file,
        ])
}

#[cfg(all(
    not(feature = "web"),
    not(all(
        any(target_os = "linux", target_os = "windows", target_os = "macos"),
        feature = "standard"
    ))
))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = configure_app(tauri::Builder::default())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle: &tauri::AppHandle, _event| {});
}
