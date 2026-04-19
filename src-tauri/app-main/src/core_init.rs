use std::sync::Arc;
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime, VdNewUnifiedRoot},
    scheduler::Scheduler,
    settings::Settings,
    storage::Storage,
};
#[cfg(not(target_os = "android"))]
use kabegame_core::storage::organize::OrganizeService;
#[cfg(all(not(target_os = "android"), not(any(kabegame_mode = "light")), feature = "local"))]
use kabegame_core::virtual_driver::VirtualDriveService;

/// Feature-gated async spawn helper.
/// In local (Tauri) mode tauri::async_runtime::spawn must be used — tokio::spawn
/// does not work from the synchronous setup() callback context.
/// In web mode we run inside our own tokio::Runtime::block_on, so tokio::spawn is fine.
fn spawn_bg<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    #[cfg(feature = "local")]
    tauri::async_runtime::spawn(fut);
    #[cfg(feature = "web")]
    tokio::spawn(fut);
}

/// 统一初始化全局状态（local 与 web 共用主流程，桌面端多出 DedupeService/VD 等用 cfg 收束）
pub fn init_globals() -> Result<(), String> {
    println!("Kabegame v{} bootstrap...", env!("CARGO_PKG_VERSION"));
    println!("Initializing Globals...");

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    println!("  ✓ Settings initialized");

    // 同步后端 i18n 语言（从配置恢复）
    {
        let lang = Settings::global().get_language();
        kabegame_i18n::sync_locale(lang.as_deref());
    }

    PluginManager::init_global()
        .map_err(|e| format!("Failed to initialize plugin manager: {}", e))?;
    println!("  ✓ Plugin manager initialized");

    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;
    let failed_count = Storage::global()
        .mark_pending_running_tasks_as_failed()
        .unwrap_or(0);
    if failed_count > 0 {
        println!("  ✓ Marked {failed_count} pending/running task(s) as failed");
    }
    println!("  ✓ Storage initialized");
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

    kabegame_core::ipc::server::EventBroadcaster::init_global(1000)
        .map_err(|e| format!("EventBroadcaster: {}", e))?;
    kabegame_core::ipc::server::SubscriptionManager::init_global()
        .map_err(|e| format!("SubscriptionManager: {}", e))?;
    kabegame_core::emitter::GlobalEmitter::init_global()
        .map_err(|e| format!("GlobalEmitter: {}", e))?;
    println!("  ✓ Event broadcaster and emitter initialized");

    println!("  ✓ Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    println!("  ✓ DownloadQueue initialized");

    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    println!("  ✓ TaskScheduler initialized");
    Scheduler::init_global().map_err(|e| format!("Failed to initialize scheduler: {}", e))?;
    spawn_bg(async {
        if let Err(e) = Scheduler::global().start().await {
            eprintln!("Failed to start scheduler: {}", e);
        }
    });
    println!("  ✓ Auto scheduler initialized");

    {
        let cfg = ProviderCacheConfig::default();
        let root = Arc::new(VdNewUnifiedRoot);
        if let Err(e) = ProviderRuntime::init_global(root, cfg) {
            return Err(format!("ProviderRuntime init failed: {}", e));
        }
    }
    println!("  ✓ ProviderRuntime initialized");

    // 桌面端 local mode：OrganizeService、VD 等全局单例
    #[cfg(all(not(target_os = "android"), feature = "local"))]
    {
        OrganizeService::init_global(Arc::new(OrganizeService::new()))?;

        #[cfg(not(kabegame_mode = "light"))]
        {
            VirtualDriveService::init_global()
                .map_err(|e| format!("Failed to init VD service: {}", e))?;
            let virtual_drive_service = VirtualDriveService::global();
            println!("  ✓ Virtual drive support enabled");

            #[cfg(target_os = "windows")]
            {
                let vd_service_for_listener = virtual_drive_service.clone();
                spawn_bg(async move {
                    crate::vd_listener::start_vd_event_listener(vd_service_for_listener).await;
                    println!("  ✓ Virtual drive event listener started");
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
                        eprintln!("Auto mount failed: {}", e);
                    } else if let Ok(Err(e)) = mount_result {
                        eprintln!("Auto mount failed: {}", e);
                    }
                }
            });
        }

        return Ok(());
    }

    #[cfg(target_os = "android")]
    return Ok(());

    #[cfg(feature = "web")]
    Ok(())
}

/// Initialize AppPaths for web mode without Tauri.
/// All paths computed using dirs crate and std::env — zero Tauri dependency.
#[cfg(feature = "web")]
pub fn init_app_paths_for_web() -> Result<(), String> {
    use kabegame_core::app_paths::{is_dev, repo_root_dir, AppPaths};

    let data_dir = if is_dev() {
        repo_root_dir()
            .map(|r| r.join("data"))
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .or_else(|| dirs::data_dir())
                    .expect("cannot determine data dir")
                    .join("Kabegame")
            })
    } else {
        dirs::data_local_dir()
            .or_else(|| dirs::data_dir())
            .expect("cannot determine data dir")
            .join("Kabegame")
    };

    let cache_dir = if is_dev() {
        repo_root_dir()
            .map(|r| r.join("cache"))
            .unwrap_or_else(|| {
                dirs::cache_dir()
                    .expect("cannot determine cache dir")
                    .join("Kabegame")
            })
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

    let app_paths = AppPaths {
        data_dir,
        cache_dir,
        temp_dir: std::env::temp_dir().join("Kabegame"),
        resource_dir,
        exe_dir,
        external_data_dir: None,
        pictures_dir: dirs::picture_dir(),
    };

    AppPaths::init(app_paths).map_err(|e| format!("AppPaths init failed: {e}"))
}
