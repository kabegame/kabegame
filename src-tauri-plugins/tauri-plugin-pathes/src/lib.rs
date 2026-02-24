use std::path::PathBuf;
use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
  Manager
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
      use kabegame_core::app_paths::{AppPaths, is_dev, repo_root_dir};

      #[cfg(target_os = "android")]
      {
        // Android: fetch paths from Kotlin plugin
        use mobile::Pathes;
        let pathes = mobile::init(app, api)?;
        
        let app_data_dir = pathes.get_app_data_dir()
          .map_err(|e| format!("Failed to get app data dir: {}", e))?;
        
        let cache_paths = pathes.get_cache_paths()
          .map_err(|e| format!("Failed to get cache paths: {}", e))?;
        
        let external_data_dir = pathes.get_external_data_dir()
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
        
        // Android: builtin plugins are extracted to data_dir/builtin-plugins
        let builtin_plugins_dir = data_dir.join("builtin-plugins");

        let app_paths = AppPaths {
          data_dir,
          cache_dir,
          temp_dir,
          resource_dir,
          exe_dir,
          external_data_dir,
          pictures_dir,
          builtin_plugins_dir,
        };

        AppPaths::init(app_paths)
          .map_err(|e| format!("Failed to initialize AppPaths: {}", e))?;
      }

      #[cfg(not(target_os = "android"))]
      {
        // Desktop: compute paths using dirs crate
        use dirs;
        
        let data_dir = if is_dev() {
          if let Some(repo_root) = repo_root_dir() {
            repo_root.join("data")
          } else {
            dirs::data_local_dir()
              .or_else(|| dirs::data_dir())
              .expect("Failed to get app data directory")
              .join("Kabegame")
          }
        } else {
          dirs::data_local_dir()
            .or_else(|| dirs::data_dir())
            .expect("Failed to get app data directory")
            .join("Kabegame")
        };

        let cache_dir = dirs::cache_dir()
          .expect("Failed to get cache dir")
          .join("Kabegame");
        
        let temp_dir = std::env::temp_dir().join("Kabegame");
        
        let resource_dir = app
          .path()
          .resolve("resources", tauri::path::BaseDirectory::Resource)
          .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
        
        let exe_dir = std::env::current_exe()
          .ok()
          .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
        
        let external_data_dir = None;
        let pictures_dir = dirs::picture_dir();
        
        // Desktop: builtin plugins location depends on dev/prod
        let builtin_plugins_dir = if is_dev() {
          // Dev: try repo/src-tauri/app-main/resources/plugins first
          if let Some(repo_root) = repo_root_dir() {
            let dev_path = repo_root
              .join("src-tauri")
              .join("app-main")
              .join("resources")
              .join("plugins");
            if dev_path.exists() {
              dev_path
            } else {
              resource_dir.join("plugins")
            }
          } else {
            resource_dir.join("plugins")
          }
        } else {
          // Prod: use resource_dir/plugins
          resource_dir.join("plugins")
        };

        let app_paths = AppPaths {
          data_dir,
          cache_dir,
          temp_dir,
          resource_dir,
          exe_dir,
          external_data_dir,
          pictures_dir,
          builtin_plugins_dir,
        };

        AppPaths::init(app_paths)
          .map_err(|e| format!("Failed to initialize AppPaths: {}", e))?;
      }

      Ok(())
    })
    .build()
}
