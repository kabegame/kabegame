//! Plugin 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::plugin::PluginManager;
use std::sync::Arc;
use base64::Engine;

/// 处理所有 Plugin 相关的 IPC 请求
pub async fn handle_plugin_request(
    req: &CliIpcRequest,
    plugin_manager: Arc<PluginManager>,
) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::PluginGetPlugins => Some(get_plugins(plugin_manager).await),
        
        CliIpcRequest::PluginGetDetail { plugin_id } => {
            Some(get_plugin_detail(plugin_manager, plugin_id).await)
        }
        
        CliIpcRequest::PluginDelete { plugin_id } => {
            Some(delete_plugin(plugin_manager, plugin_id).await)
        }
        
        CliIpcRequest::PluginImport { kgpg_path } => {
            Some(import_plugin(plugin_manager, kgpg_path).await)
        }
        
        CliIpcRequest::PluginGetVars { plugin_id } => {
            Some(get_plugin_vars(plugin_manager, plugin_id).await)
        }
        
        CliIpcRequest::PluginGetBrowserPlugins => {
            Some(get_browser_plugins(plugin_manager).await)
        }
        
        CliIpcRequest::PluginGetPluginSources => {
            Some(get_plugin_sources(plugin_manager).await)
        }

        CliIpcRequest::PluginValidateSource { index_url } => {
            Some(validate_plugin_source(plugin_manager, index_url).await)
        }

        CliIpcRequest::PluginSavePluginSources { sources } => {
            Some(save_plugin_sources(plugin_manager, sources).await)
        }

        CliIpcRequest::PluginInstallBrowserPlugin { plugin_id } => {
            Some(install_browser_plugin(plugin_manager, plugin_id).await)
        }

        CliIpcRequest::PluginGetStorePlugins { source_id, force_refresh } => {
            Some(get_store_plugins(plugin_manager, source_id.as_deref(), *force_refresh).await)
        }

        CliIpcRequest::PluginGetDetailForUi { plugin_id, download_url, sha256, size_bytes } => {
            Some(get_plugin_detail_for_ui(plugin_manager, plugin_id, download_url.as_deref(), sha256.as_deref(), *size_bytes).await)
        }

        CliIpcRequest::PluginPreviewImport { zip_path } => {
            Some(preview_import_plugin(plugin_manager, zip_path).await)
        }

        CliIpcRequest::PluginPreviewStoreInstall { download_url, sha256, size_bytes } => {
            Some(preview_store_install(plugin_manager, download_url, sha256.as_deref(), *size_bytes).await)
        }

        CliIpcRequest::PluginGetIcon { plugin_id } => {
            Some(get_plugin_icon(plugin_manager, plugin_id).await)
        }

        CliIpcRequest::PluginGetRemoteIconV2 { download_url } => {
            Some(get_remote_plugin_icon_v2(plugin_manager, download_url).await)
        }

        CliIpcRequest::PluginGetImageForDetail { plugin_id, image_path, download_url, sha256, size_bytes } => {
            Some(get_plugin_image_for_detail(plugin_manager, plugin_id, image_path, download_url.as_deref(), sha256.as_deref(), *size_bytes).await)
        }
        
        CliIpcRequest::PluginRun { .. } => {
            // 插件运行逻辑较复杂，单独处理
            None
        }
        
        _ => None,
    }
}

async fn get_plugins(plugin_manager: Arc<PluginManager>) -> CliIpcResponse {
    // 确保缓存已初始化/刷新一次（失败不致命，后续 get_all 仍会触发初始化）
    let _ = plugin_manager.refresh_installed_plugins_cache();
    match plugin_manager.get_all() {
        Ok(plugins) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(plugins).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_detail(
    plugin_manager: Arc<PluginManager>,
    plugin_id: &str,
) -> CliIpcResponse {
    match plugin_manager.load_installed_plugin_detail(plugin_id) {
        Ok(detail) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(detail).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn delete_plugin(plugin_manager: Arc<PluginManager>, plugin_id: &str) -> CliIpcResponse {
    match plugin_manager.delete(plugin_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn import_plugin(plugin_manager: Arc<PluginManager>, kgpg_path: &str) -> CliIpcResponse {
    let path = std::path::Path::new(kgpg_path);
    match plugin_manager.install_plugin_from_zip(path) {
        Ok(plugin) => CliIpcResponse::ok_with_data(
            "imported",
            serde_json::json!({ "pluginId": plugin.id }),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_vars(plugin_manager: Arc<PluginManager>, plugin_id: &str) -> CliIpcResponse {
    match plugin_manager.get_plugin_vars(plugin_id) {
        Ok(Some(vars)) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(vars).unwrap_or_default(),
        ),
        Ok(None) => CliIpcResponse::ok_with_data("ok", serde_json::json!([])),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_browser_plugins(plugin_manager: Arc<PluginManager>) -> CliIpcResponse {
    match plugin_manager.load_browser_plugins() {
        Ok(plugins) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(plugins).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_sources(plugin_manager: Arc<PluginManager>) -> CliIpcResponse {
    match plugin_manager.load_plugin_sources() {
        Ok(sources) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(sources).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn validate_plugin_source(plugin_manager: Arc<PluginManager>, index_url: &str) -> CliIpcResponse {
    match plugin_manager.validate_store_source_index(index_url).await {
        Ok(result) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(result).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn save_plugin_sources(plugin_manager: Arc<PluginManager>, sources: &serde_json::Value) -> CliIpcResponse {
    let parsed: Vec<kabegame_core::plugin::PluginSource> = match serde_json::from_value(sources.clone()) {
        Ok(v) => v,
        Err(e) => return CliIpcResponse::err(format!("Invalid sources data: {e}")),
    };
    match plugin_manager.save_plugin_sources(&parsed) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn install_browser_plugin(plugin_manager: Arc<PluginManager>, plugin_id: &str) -> CliIpcResponse {
    match plugin_manager.install_browser_plugin(plugin_id.to_string()) {
        Ok(plugin) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(plugin).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_store_plugins(
    plugin_manager: Arc<PluginManager>,
    source_id: Option<&str>,
    force_refresh: bool,
) -> CliIpcResponse {
    match plugin_manager.fetch_store_plugins(source_id, force_refresh).await {
        Ok(plugins) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(plugins).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_detail_for_ui(
    plugin_manager: Arc<PluginManager>,
    plugin_id: &str,
    download_url: Option<&str>,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let res = match download_url {
        Some(url) => plugin_manager
            .load_remote_plugin_detail(plugin_id, url, sha256, size_bytes)
            .await,
        None => plugin_manager.load_installed_plugin_detail(plugin_id),
    };
    match res {
        Ok(detail) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(detail).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_import_plugin(plugin_manager: Arc<PluginManager>, zip_path: &str) -> CliIpcResponse {
    let path = std::path::PathBuf::from(zip_path);
    match plugin_manager.preview_import_from_zip(&path) {
        Ok(preview) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(preview).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_store_install(
    plugin_manager: Arc<PluginManager>,
    download_url: &str,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let tmp = match plugin_manager
        .download_plugin_to_temp(download_url, sha256, size_bytes)
        .await
    {
        Ok(t) => t,
        Err(e) => return CliIpcResponse::err(e),
    };
    let preview = match plugin_manager.preview_import_from_zip(&tmp) {
        Ok(p) => p,
        Err(e) => return CliIpcResponse::err(e),
    };
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::json!({
            "tmpPath": tmp.to_string_lossy().to_string(),
            "preview": preview,
        }),
    )
}

async fn get_plugin_icon(plugin_manager: Arc<PluginManager>, plugin_id: &str) -> CliIpcResponse {
    let bytes = match plugin_manager.get_plugin_icon_by_id(plugin_id) {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    let b64 = bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
    CliIpcResponse::ok_with_data("ok", serde_json::json!({ "base64": b64 }))
}

async fn get_remote_plugin_icon_v2(plugin_manager: Arc<PluginManager>, download_url: &str) -> CliIpcResponse {
    let bytes = match plugin_manager.fetch_remote_plugin_icon_v2(download_url).await {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    let b64 = bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
    CliIpcResponse::ok_with_data("ok", serde_json::json!({ "base64": b64 }))
}

async fn get_plugin_image_for_detail(
    plugin_manager: Arc<PluginManager>,
    plugin_id: &str,
    image_path: &str,
    download_url: Option<&str>,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let bytes = match plugin_manager
        .load_plugin_image_for_detail(plugin_id, download_url, sha256, size_bytes, image_path)
        .await
    {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    CliIpcResponse::ok_with_data("ok", serde_json::json!({ "base64": b64 }))
}
