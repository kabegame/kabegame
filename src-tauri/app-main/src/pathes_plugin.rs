/// 注册 Android Pathes 插件，用于获取缓存目录
#[cfg(target_os = "android")]
pub fn init_pathes_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use serde::Deserialize;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct CachePaths {
        internal: String,
        external: Option<String>,
    }

    tauri::plugin::Builder::new("pathes")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("app.kabegame.plugin", "PathesPlugin")?;
            
            // 调用插件获取路径
            let paths: CachePaths = tauri::async_runtime::block_on(
                handle.run_mobile_plugin_async("getCachePaths", ())
            ).map_err(|e| format!("Failed to get cache paths: {}", e))?;

            let internal = PathBuf::from(paths.internal);
            // 如果 external 为空，回退到 internal
            let external = paths.external.map(PathBuf::from).unwrap_or_else(|| internal.clone());

            kabegame_core::app_paths::init_android_cache_dirs(internal, external);
            
            Ok(())
        })
        .build()
}
