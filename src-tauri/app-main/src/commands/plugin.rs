// 謠剃ｻｶ逶ｸ蜈ｳ蜻ｽ莉､

use kabegame_core::plugin::{
    extract_kgpg_filename_from_url, var_definition_to_frontend_value, PluginManager,
    StorePluginDownloadProgressContext, StorePluginDownloadProgressEvent,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn get_plugins() -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    plugin_manager.refresh_installed_plugins_cache().await?;
    let plugins = plugin_manager.get_all().await?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn refresh_installed_plugins_cache() -> Result<(), String> {
    let plugin_manager = PluginManager::global();
    plugin_manager.refresh_installed_plugins_cache().await?;
    plugin_manager.get_all().await?;
    Ok(())
}

#[tauri::command]
pub async fn refresh_installed_plugin_cache(plugin_id: String) -> Result<(), String> {
    let plugin_manager = PluginManager::global();
    plugin_manager
        .load_installed_plugin_detail(&plugin_id)
        .await?;
    Ok(())
}

#[tauri::command]
pub fn get_build_mode() -> Result<String, String> {
    Ok(env!("KABEGAME_BUILD_MODE").to_string())
}

#[tauri::command]
pub async fn delete_plugin(plugin_id: String) -> Result<(), String> {
    PluginManager::global().delete(&plugin_id).await
}

#[tauri::command]
pub async fn get_plugin_vars(plugin_id: String) -> Result<serde_json::Value, String> {
    let vars = PluginManager::global().get_plugin_vars(&plugin_id).await?;
    let frontend: Vec<serde_json::Value> = vars
        .map(|v| v.iter().map(var_definition_to_frontend_value).collect())
        .unwrap_or_default();
    Ok(serde_json::to_value(frontend).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_browser_plugins() -> Result<serde_json::Value, String> {
    let plugins = PluginManager::global().load_browser_plugins().await?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_sources() -> Result<serde_json::Value, String> {
    let sources = PluginManager::global().load_plugin_sources()?;
    Ok(serde_json::to_value(sources).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn add_plugin_source(id: Option<String>, name: String, index_url: String) -> Result<serde_json::Value, String> {
    let source = PluginManager::global().add_plugin_source(id, name, index_url)?;
    Ok(serde_json::to_value(source).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn update_plugin_source(id: String, name: String, index_url: String) -> Result<(), String> {
    PluginManager::global().update_plugin_source(id, name, index_url)
}

#[tauri::command]
pub async fn delete_plugin_source(id: String) -> Result<(), String> {
    PluginManager::global().delete_plugin_source(id)
}

#[tauri::command]
pub async fn get_store_plugins(
    source_id: Option<String>,
    force_refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    let plugins = PluginManager::global()
        .fetch_store_plugins(source_id.as_deref(), force_refresh.unwrap_or(false))
        .await?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_detail(
    plugin_id: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    source_id: Option<String>,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let res = match download_url {
        Some(url) => {
            plugin_manager
                .load_remote_plugin_detail(
                    &plugin_id,
                    &url,
                    sha256.as_deref(),
                    size_bytes,
                    source_id.as_deref(),
                    version.as_deref(),
                )
                .await
        }
        None => {
            plugin_manager
                .load_installed_plugin_detail(&plugin_id)
                .await
        }
    };
    let detail = res?;
    Ok(serde_json::to_value(detail).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn validate_plugin_source(index_url: String) -> Result<(), String> {
    PluginManager::global()
        .validate_store_source_index(&index_url)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn preview_import_plugin_with_icon(
    zip_path: String,
) -> Result<serde_json::Value, String> {
    let path = std::path::PathBuf::from(&zip_path);
    let pm = PluginManager::global();
    let preview = pm.preview_import_from_zip(&path).await?;
    let manifest = pm.read_plugin_manifest(&path).await?;

    // Icon
    let icon_base64 = match pm.read_plugin_icon(&path).await {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            Some(STANDARD.encode(bytes))
        }
        _ => None,
    };

    let config = pm.read_plugin_config_public(&path).ok().flatten();
    let plugins_dir = pm.get_plugins_directory();

    Ok(serde_json::json!({
        "preview": preview,
        "manifest": manifest,
        "iconBase64": icon_base64,
        "baseUrl": config.and_then(|c| c.base_url),
        "pluginsDir": plugins_dir.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub async fn preview_import_plugin(zip_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::PathBuf::from(&zip_path);
    let preview = PluginManager::global()
        .preview_import_from_zip(&path)
        .await?;
    Ok(serde_json::to_value(preview).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn preview_store_install(
    app: AppHandle,
    download_url: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    source_id: Option<String>,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let plugin_id = extract_kgpg_filename_from_url(&download_url)
        .unwrap_or_else(|| "unknown".to_string());
    let source_for_key = source_id.clone().unwrap_or_else(|| "_".to_string());
    let app_emit = app.clone();
    let cb = Arc::new(move |ev: StorePluginDownloadProgressEvent| {
        let _ = app_emit.emit("plugin-store-download-progress", &ev);
    });
    let progress = Some(StorePluginDownloadProgressContext {
        source_id: source_for_key,
        plugin_id: plugin_id.clone(),
        on_emit: Some(cb),
    });
    let cached_path = if let (Some(source_id), Some(expected_version)) = (source_id, version) {
        // 使用缓存：确保插件已缓存且版本匹配
        plugin_manager
            .ensure_plugin_cached(
                &source_id,
                &plugin_id,
                &download_url,
                sha256.as_deref(),
                size_bytes,
                &expected_version,
                progress,
            )
            .await?
    } else {
        // 兼容模式：下载到临时文件（用于非商店场景）
        plugin_manager
            .download_plugin_to_temp(&download_url, sha256.as_deref(), size_bytes, progress)
            .await?
    };
    let preview = plugin_manager.preview_import_from_zip(&cached_path).await?;
    Ok(serde_json::json!({
        "tmpPath": cached_path.to_string_lossy().to_string(),
        "preview": preview,
    }))
}

#[tauri::command]
pub async fn import_plugin_from_zip(zip_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&zip_path);
    let plugin = PluginManager::global()
        .install_plugin_from_zip(path)
        .await?;
    Ok(serde_json::json!({ "pluginId": plugin.id }))
}

#[tauri::command]
pub async fn install_browser_plugin(plugin_id: String) -> Result<serde_json::Value, String> {
    let plugin = PluginManager::global()
        .install_browser_plugin(plugin_id)
        .await?;
    Ok(serde_json::to_value(plugin).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_image(plugin_id: String, image_path: String) -> Result<Vec<u8>, String> {
    PluginManager::global()
        .load_plugin_image_for_detail(&plugin_id, None, None, None, &image_path, None, None)
        .await
}

#[tauri::command]
pub async fn get_plugin_image_for_detail(
    plugin_id: String,
    image_path: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    source_id: Option<String>,
    version: Option<String>,
) -> Result<Vec<u8>, String> {
    PluginManager::global()
        .load_plugin_image_for_detail(
            &plugin_id,
            download_url.as_deref(),
            sha256.as_deref(),
            size_bytes,
            &image_path,
            source_id.as_deref(),
            version.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn get_plugin_icon(plugin_id: String) -> Result<Option<Vec<u8>>, String> {
    PluginManager::global()
        .get_plugin_icon_by_id(&plugin_id)
        .await
}

#[tauri::command]
pub async fn get_remote_plugin_icon(
    download_url: String,
    source_id: Option<String>,
    plugin_id: Option<String>,
) -> Result<Option<Vec<u8>>, String> {
    PluginManager::global()
        .fetch_remote_plugin_icon_v2(&download_url, source_id.as_deref(), plugin_id.as_deref())
        .await
}

#[tauri::command]
pub async fn get_plugin_doc_from_zip(
    zip_path: String,
) -> Result<Option<kabegame_core::plugin::PluginDoc>, String> {
    let path = std::path::PathBuf::from(&zip_path);
    PluginManager::global().read_plugin_doc_public(&path)
}

#[tauri::command]
pub async fn get_plugin_image_from_zip(
    zip_path: String,
    image_path: String,
) -> Result<Vec<u8>, String> {
    let path = std::path::PathBuf::from(&zip_path);
    PluginManager::global().read_plugin_image(&path, &image_path)
}
