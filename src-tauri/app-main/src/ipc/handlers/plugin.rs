//! Plugin 相关请求

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::plugin::PluginManager;

pub async fn handle_plugin_request(req: &CliIpcRequest) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::PluginGetPlugins => Some(get_plugins().await),

        CliIpcRequest::PluginGetDetail { plugin_id } => Some(get_plugin_detail(plugin_id).await),

        CliIpcRequest::PluginDelete { plugin_id } => Some(delete_plugin(plugin_id).await),

        CliIpcRequest::PluginImport { kgpg_path } => Some(import_plugin(kgpg_path).await),

        CliIpcRequest::PluginGetPluginSources => Some(get_plugin_sources().await),

        CliIpcRequest::PluginValidateSource { index_url } => {
            Some(validate_plugin_source(index_url).await)
        }

        CliIpcRequest::PluginAddSource {
            id,
            name,
            index_url,
        } => Some(add_plugin_source(id.clone(), name.clone(), index_url.clone()).await),

        CliIpcRequest::PluginUpdateSource {
            id,
            name,
            index_url,
        } => Some(update_plugin_source(id.clone(), name.clone(), index_url.clone()).await),

        CliIpcRequest::PluginDeleteSource { id } => Some(delete_plugin_source(id.clone()).await),

        CliIpcRequest::PluginGetStorePlugins {
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

        CliIpcRequest::PluginPreviewImport { zip_path } => {
            Some(preview_import_plugin(zip_path).await)
        }
        CliIpcRequest::PluginGetRemoteIconV2 {
            download_url,
            source_id,
            plugin_id,
        } => Some(
            get_remote_plugin_icon_v2(download_url, source_id.as_deref(), plugin_id.as_deref())
                .await,
        ),

        CliIpcRequest::PluginGetImageForDetail {
            plugin_id,
            image_path,
            source_id,
        } => Some(
            get_plugin_image_for_detail(plugin_id, image_path, source_id.as_deref()).await,
        ),

        CliIpcRequest::PluginRun { .. } => {
            // 运行请求由主程序处理，此处不处理
            None
        }

        _ => None,
    }
}

async fn get_plugins() -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    if let Err(e) = plugin_manager.ensure_installed_cache_initialized().await {
        return CliIpcResponse::err(e);
    }
    match plugin_manager.get_all().await {
        Ok(plugins) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_detail(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_installed_plugin_detail(plugin_id).await {
        Ok(detail) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(detail).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn delete_plugin(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.delete(plugin_id).await {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn import_plugin(kgpg_path: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::Path::new(kgpg_path);
    match plugin_manager.install_plugin_from_kgpg(path).await {
        Ok(plugin) => {
            CliIpcResponse::ok_with_data("imported", serde_json::json!({ "pluginId": plugin.id }))
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_vars(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.get_plugin_vars(plugin_id).await {
        Ok(Some(vars)) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(vars).unwrap_or_default())
        }
        Ok(None) => CliIpcResponse::ok_with_data("ok", serde_json::json!([])),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_sources() -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_plugin_sources() {
        Ok(sources) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(sources).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn validate_plugin_source(index_url: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.validate_store_source_index(index_url).await {
        Ok(result) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(result).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn add_plugin_source(id: Option<String>, name: String, index_url: String) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.add_plugin_source(id, name, index_url) {
        Ok(source) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(source).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn update_plugin_source(id: String, name: String, index_url: String) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.update_plugin_source(id, name, index_url) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn delete_plugin_source(id: String) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.delete_plugin_source(id) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_store_plugins(
    source_id: Option<&str>,
    force_refresh: bool,
    revalidate_if_stale_after_secs: Option<u64>,
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager
        .fetch_store_plugins(source_id, force_refresh, revalidate_if_stale_after_secs)
        .await
    {
        Ok(plugins) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_import_plugin(zip_path: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::PathBuf::from(zip_path);
    match plugin_manager.preview_import_from_kgpg(&path).await {
        Ok(plugin) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugin).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_store_install(source_id: &str, plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let cached_path = match plugin_manager
        .ensure_plugin_cached(source_id, plugin_id)
        .await
    {
        Ok(p) => p,
        Err(e) => return CliIpcResponse::err(e),
    };
    let plugin = match plugin_manager.preview_import_from_kgpg(&cached_path).await {
        Ok(p) => p,
        Err(e) => return CliIpcResponse::err(e),
    };
    CliIpcResponse::ok_with_data(
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
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager
        .fetch_remote_plugin_icon_v2(download_url, source_id, plugin_id)
        .await
    {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    match bytes {
        Some(b) => CliIpcResponse::ok_with_bytes("ok", "image/png", b),
        None => CliIpcResponse::ok("no icon"),
    }
}

async fn get_plugin_image_for_detail(
    plugin_id: &str,
    image_path: &str,
    source_id: Option<&str>,
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager
        .load_plugin_image_for_detail(plugin_id, image_path, source_id)
        .await
    {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    CliIpcResponse::ok_with_bytes("ok", "image/png", bytes)
}
