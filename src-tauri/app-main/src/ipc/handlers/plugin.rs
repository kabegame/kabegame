//! Plugin 相关请求

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::plugin::PluginManager;

pub async fn handle_plugin_request(req: &CliIpcRequest) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::PluginGetPlugins => Some(get_plugins().await),

        CliIpcRequest::PluginGetDetail { plugin_id } => Some(get_plugin_detail(plugin_id).await),

        CliIpcRequest::PluginDelete { plugin_id } => Some(delete_plugin(plugin_id).await),

        CliIpcRequest::PluginImport { kgpg_path } => Some(import_plugin(kgpg_path).await),

        CliIpcRequest::PluginGetVars { plugin_id } => Some(get_plugin_vars(plugin_id).await),

        CliIpcRequest::PluginGetBrowserPlugins => Some(get_browser_plugins().await),

        CliIpcRequest::PluginGetPluginSources => Some(get_plugin_sources().await),

        CliIpcRequest::PluginValidateSource { index_url } => {
            Some(validate_plugin_source(index_url).await)
        }

        CliIpcRequest::PluginSavePluginSources { sources } => {
            Some(save_plugin_sources(sources).await)
        }

        CliIpcRequest::PluginInstallBrowserPlugin { plugin_id } => {
            Some(install_browser_plugin(plugin_id).await)
        }

        CliIpcRequest::PluginGetStorePlugins {
            source_id,
            force_refresh,
        } => Some(get_store_plugins(source_id.as_deref(), *force_refresh).await),

        CliIpcRequest::PluginGetDetailForUi {
            plugin_id,
            download_url,
            sha256,
            size_bytes,
        } => Some(
            get_plugin_detail_for_ui(
                plugin_id,
                download_url.as_deref(),
                sha256.as_deref(),
                *size_bytes,
            )
            .await,
        ),

        CliIpcRequest::PluginPreviewImport { zip_path } => {
            Some(preview_import_plugin(zip_path).await)
        }

        CliIpcRequest::PluginPreviewStoreInstall {
            download_url,
            sha256,
            size_bytes,
        } => Some(preview_store_install(download_url, sha256.as_deref(), *size_bytes).await),

        CliIpcRequest::PluginGetIcon { plugin_id } => Some(get_plugin_icon(plugin_id).await),

        CliIpcRequest::PluginGetRemoteIconV2 { download_url } => {
            Some(get_remote_plugin_icon_v2(download_url).await)
        }

        CliIpcRequest::PluginGetImageForDetail {
            plugin_id,
            image_path,
            download_url,
            sha256,
            size_bytes,
        } => Some(
            get_plugin_image_for_detail(
                plugin_id,
                image_path,
                download_url.as_deref(),
                sha256.as_deref(),
                *size_bytes,
            )
            .await,
        ),

        CliIpcRequest::PluginRun { .. } => {
            // 謠剃ｻｶ霑占｡碁ｻ霎題ｾ・､肴揩・悟黒迢ｬ螟・炊
            None
        }

        _ => None,
    }
}

async fn get_plugins() -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    // 遑ｮ菫晉ｼ灘ｭ伜ｷｲ蛻晏ｧ句喧/蛻ｷ譁ｰ荳谺｡・亥､ｱ雍･荳崎・蜻ｽ・悟錘扈ｭ get_all 莉堺ｼ夊ｧｦ蜿大・蟋句喧・・    let _ = plugin_manager.refresh_installed_plugins_cache();
    match plugin_manager.get_all() {
        Ok(plugins) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_detail(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_installed_plugin_detail(plugin_id) {
        Ok(detail) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(detail).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn delete_plugin(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.delete(plugin_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn import_plugin(kgpg_path: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::Path::new(kgpg_path);
    match plugin_manager.install_plugin_from_zip(path) {
        Ok(plugin) => {
            CliIpcResponse::ok_with_data("imported", serde_json::json!({ "pluginId": plugin.id }))
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_vars(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.get_plugin_vars(plugin_id) {
        Ok(Some(vars)) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(vars).unwrap_or_default())
        }
        Ok(None) => CliIpcResponse::ok_with_data("ok", serde_json::json!([])),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_browser_plugins() -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.load_browser_plugins() {
        Ok(plugins) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
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

async fn save_plugin_sources(sources: &serde_json::Value) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let parsed: Vec<kabegame_core::plugin::PluginSource> =
        match serde_json::from_value(sources.clone()) {
            Ok(v) => v,
            Err(e) => return CliIpcResponse::err(format!("Invalid sources data: {e}")),
        };
    match plugin_manager.save_plugin_sources(&parsed) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn install_browser_plugin(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager.install_browser_plugin(plugin_id.to_string()) {
        Ok(plugin) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugin).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_store_plugins(source_id: Option<&str>, force_refresh: bool) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    match plugin_manager
        .fetch_store_plugins(source_id, force_refresh)
        .await
    {
        Ok(plugins) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(plugins).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn get_plugin_detail_for_ui(
    plugin_id: &str,
    download_url: Option<&str>,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let res = match download_url {
        Some(url) => {
            plugin_manager
                .load_remote_plugin_detail(plugin_id, url, sha256, size_bytes)
                .await
        }
        None => plugin_manager.load_installed_plugin_detail(plugin_id),
    };
    match res {
        Ok(detail) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(detail).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_import_plugin(zip_path: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let path = std::path::PathBuf::from(zip_path);
    match plugin_manager.preview_import_from_zip(&path) {
        Ok(preview) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(preview).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn preview_store_install(
    download_url: &str,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
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

async fn get_plugin_icon(plugin_id: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager.get_plugin_icon_by_id(plugin_id) {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    match bytes {
        Some(b) => CliIpcResponse::ok_with_bytes("ok", "image/png", b),
        None => CliIpcResponse::ok("no icon"),
    }
}

async fn get_remote_plugin_icon_v2(download_url: &str) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager
        .fetch_remote_plugin_icon_v2(download_url)
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
    download_url: Option<&str>,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
) -> CliIpcResponse {
    let plugin_manager = PluginManager::global();
    let bytes = match plugin_manager
        .load_plugin_image_for_detail(plugin_id, download_url, sha256, size_bytes, image_path)
        .await
    {
        Ok(b) => b,
        Err(e) => return CliIpcResponse::err(e),
    };
    CliIpcResponse::ok_with_bytes("ok", "image/png", bytes)
}
