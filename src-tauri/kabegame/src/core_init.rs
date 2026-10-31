use kabegame_core::storage::hidden_cleanup::HiddenCleanupService;
#[cfg(not(target_os = "android"))]
use kabegame_core::storage::organize::OrganizeService;
use kabegame_core::storage::startup_state::{self, StartupPhase};
#[cfg(all(not(target_os = "android"), feature = "standard"))]
use kabegame_core::virtual_driver::VirtualDriveService;
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    plugin::PluginManager,
    scheduler::Scheduler,
    settings::Settings,
    storage::Storage,
};
use std::sync::Arc;

/// Feature-gated async spawn helper.
/// In local (Tauri) mode tauri::async_runtime::spawn must be used — tokio::spawn
/// does not work from the synchronous setup() callback context.
/// In web mode we run inside our own tokio::Runtime::block_on, so tokio::spawn is fine.
fn spawn_bg<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    #[cfg(not(feature = "web"))]
    tauri::async_runtime::spawn(fut);
    #[cfg(feature = "web")]
    tokio::spawn(fut);
}

/// 毫秒级初始化：Settings、i18n 与事件广播。桌面端在主线程、主窗口创建之前调用
/// （窗口与 `start_event_loop` 依赖它们）；local 与 web 共用。
pub fn init_fast_globals() -> Result<(), String> {
    tracing::info!("Kabegame v{} bootstrap...", env!("CARGO_PKG_VERSION"));
    tracing::debug!("Initializing Globals...");
    startup_state::set(StartupPhase::Settings);

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    tracing::info!("Settings initialized");

    // 同步后端 i18n 语言（从配置恢复）
    {
        let lang = Settings::global().get_language();
        kabegame_i18n::sync_locale(lang.as_deref());
    }

    // 事件广播只依赖自身，提前到这里让事件循环在重型初始化之前就绪。
    kabegame_core::ipc::server::EventBroadcaster::init_global(1000)
        .map_err(|e| format!("EventBroadcaster: {}", e))?;
    kabegame_core::ipc::server::SubscriptionManager::init_global()
        .map_err(|e| format!("SubscriptionManager: {}", e))?;
    kabegame_core::emitter::GlobalEmitter::init_global()
        .map_err(|e| format!("GlobalEmitter: {}", e))?;
    tracing::info!("Event broadcaster and emitter initialized");
    Ok(())
}

/// 重型初始化：PluginManager、Storage（schema 迁移 + 被依赖的回填）、调度器与各 Service。
/// 桌面端与 Android 在独立线程里调用（期间启动页经 `startup_state` 显示进度），web 顺序调用。
/// 不得包含必须在主线程执行的调用（托盘、壁纸控制器等放在 app 层的 `init_post`）。
pub fn init_heavy_globals() -> Result<(), String> {
    startup_state::set(StartupPhase::Plugins);
    PluginManager::init_global()
        .map_err(|e| format!("Failed to initialize plugin manager: {}", e))?;
    tracing::info!("Plugin manager initialized");

    // 迁移与阻塞回填的进度由 Storage::new() 直接写进 startup_state。
    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;
    // 网页壁纸目录索引（file: 闸门与网页壁纸拉取的数据源）：必须先于任何网页壁纸 iframe 就绪。
    // 主窗口要等启动页 Ready 才会打开预览、壁纸窗口在 init_post 才建，所以放在这里而不是 init_post。
    // 网页壁纸只在 Windows 提供。
    #[cfg(all(not(feature = "web"), target_os = "windows"))]
    crate::wallpaper::wpe_web_dir_index::init_wpe_web_dir_index();
    startup_state::set(StartupPhase::Services);
    let failed_count = Storage::global()
        .mark_pending_running_tasks_as_failed()
        .unwrap_or(0);
    if failed_count > 0 {
        tracing::info!("Marked {failed_count} pending/running task(s) as failed");
    }
    tracing::info!("Storage initialized");
    // 收藏画册使用当前 locale 的 i18n 名称（与语言切换时 set_favorite_album_name 一致）
    let raw = kabegame_i18n::t!("albums.favorite");
    let name = if raw == "albums.favorite" {
        "收藏"
    } else {
        raw.as_str()
    };
    let _ = Storage::global().set_favorite_album_name(name);
    // 官方插件源使用当前 locale 的 i18n 名称（与语言切换时 set_official_source_name 一致）
    let raw_source_name = kabegame_i18n::t!("plugins.officialGithubReleaseSourceName");
    let source_name = if raw_source_name == "plugins.officialGithubReleaseSourceName" {
        kabegame_core::storage::plugin_sources::OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME
    } else {
        raw_source_name.as_str()
    };
    let _ = Storage::global()
        .plugin_sources()
        .set_official_source_name(source_name);

    tracing::info!("Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    tracing::info!("DownloadQueue initialized");

    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    tracing::info!("TaskScheduler initialized");
    Scheduler::init_global().map_err(|e| format!("Failed to initialize scheduler: {}", e))?;
    spawn_bg(async {
        if let Err(e) = Scheduler::global().start().await {
            tracing::warn!("Failed to start scheduler: {}", e);
        }
    });
    tracing::info!("Auto scheduler initialized");

    tracing::info!("ProviderRuntime deferred until kgpg plugin init");

    // OrganizeService 在 local 和 web 模式下均需要（非 Android）
    #[cfg(not(target_os = "android"))]
    OrganizeService::init_global(Arc::new(OrganizeService::new()))?;
    HiddenCleanupService::init_global(Arc::new(HiddenCleanupService::new()))?;

    // 桌面端 standard mode：VD 等全局单例（light 与 android 桌面分支跳过 VD）
    #[cfg(all(not(target_os = "android"), feature = "standard"))]
    {
        VirtualDriveService::init_global()
            .map_err(|e| format!("Failed to init VD service: {}", e))?;
        let virtual_drive_service = VirtualDriveService::global();
        tracing::info!("Virtual drive support enabled");

        #[cfg(target_os = "windows")]
        {
            let vd_service_for_listener = virtual_drive_service.clone();
            spawn_bg(async move {
                crate::vd_listener::start_vd_event_listener(vd_service_for_listener).await;
                tracing::info!("Virtual drive event listener started");
            });
        }

        let vd_service_for_mount = virtual_drive_service.clone();
        spawn_bg(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let enabled = Settings::global().get_album_drive_enabled();
            let mount_point = Settings::global().get_album_drive_mount_point();
            if enabled && !mount_point.is_empty() {
                use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
                let mount_result = tokio::task::spawn_blocking({
                    let vd_service = vd_service_for_mount.clone();
                    let mount_point = mount_point.clone();
                    move || vd_service.mount(mount_point.as_str())
                })
                .await;
                if let Err(e) = mount_result {
                    tracing::warn!("Auto mount failed: {}", e);
                } else if let Ok(Err(e)) = mount_result {
                    tracing::warn!("Auto mount failed: {}", e);
                }
            }
        });
    }

    #[cfg(any(feature = "web", not(target_os = "android")))]
    crate::web::init_registry();

    Ok(())
}

/// Initialize AppPaths for web mode without Tauri.
/// All paths computed using dirs crate and std::env — zero Tauri dependency.
#[cfg(feature = "web")]
pub fn init_app_paths_for_web() -> Result<(), String> {
    use kabegame_core::app_paths::{is_dev, repo_root_dir, AppPaths};

    let dev_debug_dir = if is_dev() {
        repo_root_dir().map(|repo_root| repo_root.join(".kabegame").join("debug"))
    } else {
        None
    };

    let data_dir = if let Some(dev_debug_dir) = &dev_debug_dir {
        dev_debug_dir.join("data")
    } else {
        dirs::data_local_dir()
            .or_else(|| dirs::data_dir())
            .expect("cannot determine data dir")
            .join("Kabegame")
    };

    let cache_dir = if let Some(dev_debug_dir) = &dev_debug_dir {
        dev_debug_dir.join("cache")
    } else {
        dirs::cache_dir()
            .expect("cannot determine cache dir")
            .join("Kabegame")
    };

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()));

    let resource_dir = exe_dir
        .as_deref()
        .map(|d| d.join("resources"))
        .unwrap_or_else(|| std::env::temp_dir().join("Kabegame").join("resources"));

    let compatibles_dir_path = data_dir.join("compatibles");
    let app_paths = AppPaths {
        data_dir,
        cache_dir,
        temp_dir: dev_debug_dir
            .as_ref()
            .map(|dev_debug_dir| dev_debug_dir.join("tmp"))
            .unwrap_or_else(|| std::env::temp_dir().join("Kabegame")),
        resource_dir,
        exe_dir,
        external_data_dir: None,
        pictures_dir: dirs::picture_dir(),
        compatibles_dir_path,
    };

    AppPaths::init(app_paths).map_err(|e| format!("AppPaths init failed: {e}"))
}
