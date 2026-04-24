//! Plugin 相关请求

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::plugin::PluginManager;

pub async fn handle_plugin_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        IpcRequest::PluginGetPlugins => Some(get_plugins().await),

        IpcRequest::PluginGetDetail { plugin_id } => Some(get_plugin_detail(plugin_id).await),

        IpcRequest::PluginDelete { plugin_id } => Some(delete_plugin(plugin_id).await),

        IpcRequest::PluginImport { kgpg_path } => Some(import_plugin(kgpg_path).await),

        IpcRequest::PluginGetPluginSources => Some(get_plugin_sources().await),

        IpcRequest::PluginValidateSource { index_url } => {
            Some(validate_plugin_source(index_url).await)
        }

        IpcRequest::PluginAddSource {
            id,
            name,
            index_url,
        } => Some(add_plugin_source(id.clone(), name.clone(), index_url.clone()).await),

        IpcRequest::PluginUpdateSource {
            id,
            name,
            index_url,
        } => Some(update_plugin_source(id.clone(), name.clone(), index_url.clone()).await),

        IpcRequest::PluginDeleteSource { id } => Some(delete_plugin_source(id.clone()).await),

        IpcRequest::PluginGetStorePlugins {
            source_id,
            force_refresh,
            revalidate_if_stale_after_secs,
        } => Some(
            get_store_plugins(
                source_id.as_deref(),
                *force_refresh,
                *revalidate_if_stale_after_secs,
            )
            .await,
        ),

        IpcRequest::PluginPreviewImport { zip_path } => {
            Some(preview_import_plugin(zip_path).await)
        }
        IpcRequest::PluginGetRemoteIconV2 {
            download_url,
            source_id,
            plugin_id,
        } => Some(
            get_remote_plugin_icon_v2(download_url, source_id.as_deref(), plugin_id.as_deref())
                .await,
        ),

        IpcRequest::PluginRun { .. } => {
            // 运行请求由主程序处理，此处不处理
            None
        }

        _ => None,
    }
}

async fn get_plugins() -> IpcResponse {
    let plugin_manager = PluginManager::global();
    if let Err(e) = plugin_manager.ensure_installed_cache_initialized().await {
        return IpcResponse::err(e);
    }
    match plugin_manager.get_all().await {
        Ok(plugins) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn get_plugin_detail(plugin_id: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_installed_plugin_detail(plugin_id).await {
        Ok(detail) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(detail).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn delete_plugin(plugin_id: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.delete(plugin_id).await {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

async fn import_plugin(kgpg_path: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::Path::new(kgpg_path);
    match plugin_manager.install_plugin_from_kgpg(path).await {
        Ok(plugin) => {
            IpcResponse::ok_with_data("imported", serde_json::json!({ "pluginId": plugin.id }))
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn get_plugin_vars(plugin_id: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.get_plugin_vars(plugin_id).await {
        Ok(Some(vars)) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(vars).unwrap_or_default())
        }
        Ok(None) => IpcResponse::ok_with_data("ok", serde_json::json!([])),
        Err(e) => IpcResponse::err(e),
    }
}

async fn get_plugin_sources() -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_plugin_sources() {
        Ok(sources) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(sources).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn validate_plugin_source(index_url: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.validate_store_source_index(index_url).await {
        Ok(result) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(result).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn add_plugin_source(id: Option<String>, name: String, index_url: String) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.add_plugin_source(id, name, index_url) {
        Ok(source) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(source).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn update_plugin_source(id: String, name: String, index_url: String) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.update_plugin_source(id, name, index_url) {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}

async fn delete_plugin_source(id: String) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.delete_plugin_source(id) {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}

async fn get_store_plugins(
    source_id: Option<&str>,
    force_refresh: bool,
    revalidate_if_stale_after_secs: Option<u64>,
) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager
        .fetch_store_plugins(source_id, force_refresh, revalidate_if_stale_after_secs)
        .await
    {
        Ok(plugins) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn preview_import_plugin(zip_path: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::PathBuf::from(zip_path);
    match plugin_manager.preview_import_from_kgpg(&path).await {
        Ok(plugin) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(plugin).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn preview_store_install(source_id: &str, plugin_id: &str) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    let cached_path = match plugin_manager
        .ensure_plugin_cached(source_id, plugin_id)
        .await
    {
        Ok(p) => p,
        Err(e) => return IpcResponse::err(e),
    };
    let plugin = match plugin_manager.preview_import_from_kgpg(&cached_path).await {
        Ok(p) => p,
        Err(e) => return IpcResponse::err(e),
    };
    IpcResponse::ok_with_data(
        "ok",
        serde_json::json!({
            "tmpPath": cached_path.to_string_lossy().to_string(),
            "plugin": plugin,
        }),
    )
}

async fn get_remote_plugin_icon_v2(
    download_url: &str,
    source_id: Option<&str>,
    plugin_id: Option<&str>,
) -> IpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager
        .fetch_remote_plugin_icon_v2(download_url, source_id, plugin_id)
        .await
    {
        Ok(b) => b,
        Err(e) => return IpcResponse::err(e),
    };
    match bytes {
        Some(b) => IpcResponse::ok_with_bytes("ok", "image/png", b),
        None => IpcResponse::ok("no icon"),
    }
}
