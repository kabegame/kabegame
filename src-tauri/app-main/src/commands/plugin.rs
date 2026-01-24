// 謠剃ｻｶ逶ｸ蜈ｳ蜻ｽ莉､

use kabegame_core::plugin::{PluginManager, PluginSource};

#[tauri::command]
pub async fn get_plugins() -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let _ = plugin_manager.refresh_installed_plugins_cache();
    let plugins = plugin_manager.get_all()?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn refresh_installed_plugins_cache() -> Result<(), String> {
    let plugin_manager = PluginManager::global();
    let _ = plugin_manager.refresh_installed_plugins_cache();
    let _ = plugin_manager.get_all()?;
    Ok(())
}

#[tauri::command]
pub async fn refresh_installed_plugin_cache(plugin_id: String) -> Result<(), String> {
    let plugin_manager = PluginManager::global();
    let _ = plugin_manager.load_installed_plugin_detail(&plugin_id)?;
    Ok(())
}

#[tauri::command]
pub fn get_build_mode() -> Result<String, String> {
    Ok(env!("KABEGAME_BUILD_MODE").to_string())
}

#[tauri::command]
pub async fn delete_plugin(plugin_id: String) -> Result<(), String> {
    PluginManager::global().delete(&plugin_id)
}

#[tauri::command]
pub async fn get_plugin_vars(plugin_id: String) -> Result<serde_json::Value, String> {
    let vars = PluginManager::global().get_plugin_vars(&plugin_id)?;
    Ok(serde_json::to_value(vars).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_browser_plugins() -> Result<serde_json::Value, String> {
    let plugins = PluginManager::global().load_browser_plugins()?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_sources() -> Result<serde_json::Value, String> {
    let sources = PluginManager::global().load_plugin_sources()?;
    Ok(serde_json::to_value(sources).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn save_plugin_sources(sources: serde_json::Value) -> Result<(), String> {
    let parsed: Vec<PluginSource> =
        serde_json::from_value(sources).map_err(|e| format!("Invalid sources data: {}", e))?;
    PluginManager::global().save_plugin_sources(&parsed)
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
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let res = match download_url {
        Some(url) => {
            plugin_manager
                .load_remote_plugin_detail(&plugin_id, &url, sha256.as_deref(), size_bytes)
                .await
        }
        None => plugin_manager.load_installed_plugin_detail(&plugin_id),
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
pub async fn preview_import_plugin(zip_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::PathBuf::from(&zip_path);
    let preview = PluginManager::global().preview_import_from_zip(&path)?;
    Ok(serde_json::to_value(preview).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn preview_store_install(
    download_url: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let tmp = plugin_manager
        .download_plugin_to_temp(&download_url, sha256.as_deref(), size_bytes)
        .await?;
    let preview = plugin_manager.preview_import_from_zip(&tmp)?;
    Ok(serde_json::json!({
        "tmpPath": tmp.to_string_lossy().to_string(),
        "preview": preview,
    }))
}

#[tauri::command]
pub async fn import_plugin_from_zip(zip_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&zip_path);
    let plugin = PluginManager::global().install_plugin_from_zip(path)?;
    Ok(serde_json::json!({ "pluginId": plugin.id }))
}

#[tauri::command]
pub async fn install_browser_plugin(plugin_id: String) -> Result<serde_json::Value, String> {
    let plugin = PluginManager::global().install_browser_plugin(plugin_id)?;
    Ok(serde_json::to_value(plugin).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_image(plugin_id: String, image_path: String) -> Result<Vec<u8>, String> {
    PluginManager::global()
        .load_plugin_image_for_detail(&plugin_id, None, None, None, &image_path)
        .await
}

#[tauri::command]
pub async fn get_plugin_image_for_detail(
    plugin_id: String,
    image_path: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    PluginManager::global()
        .load_plugin_image_for_detail(
            &plugin_id,
            download_url.as_deref(),
            sha256.as_deref(),
            size_bytes,
            &image_path,
        )
        .await
}

#[tauri::command]
pub async fn get_plugin_icon(plugin_id: String) -> Result<Option<Vec<u8>>, String> {
    PluginManager::global().get_plugin_icon_by_id(&plugin_id)
}

#[tauri::command]
pub async fn get_remote_plugin_icon(download_url: String) -> Result<Option<Vec<u8>>, String> {
    PluginManager::global()
        .fetch_remote_plugin_icon_v2(&download_url)
        .await
}
