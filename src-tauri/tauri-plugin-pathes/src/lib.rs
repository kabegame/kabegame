use std::path::PathBuf;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(target_os = "android")]
mod mobile;

mod error;
mod models;

pub use error::{Error, Result};

/// Initializes the plugin and computes all app paths.
///
/// On Android: fetches paths from PathesPlugin.kt
/// On desktop: computes paths using dirs crate and Tauri path API
///
/// All paths are computed once at startup and initialized into kabegame-core::app_paths::AppPaths.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pathes")
        .setup(|app, api| {
            use kabegame_core::app_paths::{is_dev, repo_root_dir, AppPaths};

            #[cfg(target_os = "android")]
            {
                // Android: fetch paths from Kotlin plugin
                use mobile::Pathes;
                let pathes = mobile::init(app, api)?;

                let app_data_dir = pathes
                    .get_app_data_dir()
                    .map_err(|e| format!("Failed to get app data dir: {}", e))?;

                let cache_paths = pathes
                    .get_cache_paths()
                    .map_err(|e| format!("Failed to get cache paths: {}", e))?;

                let external_data_dir = pathes
                    .get_external_data_dir()
                    .map_err(|e| format!("Failed to get external data dir: {}", e))?;

                let data_dir = PathBuf::from(app_data_dir.dir);
                let cache_dir = PathBuf::from(cache_paths.internal);
                let temp_dir = cache_dir.clone(); // Android uses cacheDir for temp
                let resource_dir = app
                    .path()
                    .resolve("resources", tauri::path::BaseDirectory::Resource)
                    .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
                let exe_dir = None;
                let external_data_dir = Some(PathBuf::from(external_data_dir.dir));
                let pictures_dir = None;
                let compatibles_dir_path = external_data_dir
                    .as_ref()
                    .map(|dir| dir.join("compatibles"))
                    .unwrap_or_else(|| data_dir.join("compatibles"));

                let app_paths = AppPaths {
                    data_dir,
                    cache_dir,
                    temp_dir,
                    resource_dir,
                    exe_dir,
                    external_data_dir,
                    pictures_dir,
                    compatibles_dir_path,
                };

                AppPaths::init(app_paths)
                    .map_err(|e| format!("Failed to initialize AppPaths: {}", e))?;
                // 供 seed_bundled_plugins 在启动后取用
                app.manage(pathes);
            }

            #[cfg(not(target_os = "android"))]
            {
                // Desktop: compute paths using dirs crate
                use dirs;

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
                        .expect("Failed to get app data directory")
                        .join("Kabegame")
                };

                let cache_dir = if let Some(dev_debug_dir) = &dev_debug_dir {
                    dev_debug_dir.join("cache")
                } else {
                    dirs::cache_dir()
                        .expect("Failed to get cache dir")
                        .join("Kabegame")
                };

                let temp_dir = dev_debug_dir
                    .as_ref()
                    .map(|dev_debug_dir| dev_debug_dir.join("tmp"))
                    .unwrap_or_else(|| std::env::temp_dir().join("Kabegame"));

                let resource_dir = app
                    .path()
                    .resolve("resources", tauri::path::BaseDirectory::Resource)
                    .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));

                let external_data_dir = None;
                let pictures_dir = dirs::picture_dir();
                let compatibles_dir_path = data_dir.join("compatibles");

                let app_paths = AppPaths {
                    data_dir,
                    cache_dir,
                    temp_dir,
                    resource_dir,
                    exe_dir,
                    external_data_dir,
                    pictures_dir,
                    compatibles_dir_path,
                };

                AppPaths::init(app_paths)
                    .map_err(|e| format!("Failed to initialize AppPaths: {}", e))?;
            }

            Ok(())
        })
        .build()
}

/// Android：版本变化时（首次启动 / 应用更新）把 APK 内预置的 `.kgpg` 复制进用户插件目录。
///
/// 版本标记 `.bundled-plugins-version` 写在插件目录里，与当前安装包一致则跳过；
/// 同名插件以预置版本覆盖（与桌面 `PluginManager::seed_bundled_plugins` 一致）。
/// 阻塞直到复制完成，调用方应放在阻塞线程里，并在插件缓存初始化之前执行。
/// 尽力而为：失败只记录日志。
#[cfg(target_os = "android")]
pub fn seed_bundled_plugins<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(pathes) = app.try_state::<mobile::Pathes<R>>() else {
        tracing::warn!("seed_bundled_plugins: pathes 插件未初始化");
        return;
    };
    let target_dir = kabegame_core::app_paths::AppPaths::global().plugins_dir();
    match pathes.seed_bundled_plugins(target_dir.to_string_lossy().into_owned()) {
        Ok(res) if res.skipped => {}
        Ok(res) => tracing::info!(
            "seed_bundled_plugins: 版本 {}，复制 {} 个，失败 {} 个",
            res.version,
            res.copied,
            res.failed
        ),
        Err(e) => tracing::warn!("seed_bundled_plugins: {e}"),
    }
}
