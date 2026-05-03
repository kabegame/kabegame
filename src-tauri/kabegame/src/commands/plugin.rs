// 謠剃ｻｶ逶ｸ蜈ｳ蜻ｽ莉､

use kabegame_core::plugin::PluginManager;
use kabegame_core::storage::Storage;

#[tauri::command]
pub async fn get_plugins() -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    plugin_manager.ensure_installed_cache_initialized().await?;
    let plugins = plugin_manager.get_all()?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

/// 前端手动触发：重扫磁盘并返回最新插件列表
#[tauri::command]
pub async fn refresh_plugins() -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    plugin_manager.refresh_plugins().await?;
    let plugins = plugin_manager.get_all()?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn get_build_mode() -> Result<String, String> {
    let mode = if cfg!(feature = "web") {
        "web"
    } else if cfg!(feature = "android") {
        "android"
    } else if cfg!(feature = "standard") {
        "standard"
    } else if cfg!(feature = "light") {
        "light"
    } else {
        "unknown"
    };
    Ok(mode.to_string())
}

#[tauri::command]
pub async fn delete_plugin(plugin_id: String) -> Result<(), String> {
    PluginManager::global().delete(&plugin_id).await
}

#[tauri::command]
pub async fn install_from_store(
    source_id: String,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let plugin = PluginManager::global()
        .install_from_store(&source_id, &plugin_id)
        .await?;
    Ok(serde_json::to_value(plugin).map_err(|e| e.to_string())?)
}

/// 仅读取磁盘上的插件默认配置；不存在返回 `null`，解析失败返回 `Err`
#[tauri::command]
pub async fn get_plugin_default_config(
    plugin_id: String,
) -> Result<Option<serde_json::Value>, String> {
    PluginManager::global().read_plugin_default_config_file(&plugin_id)
}

/// 若默认配置文件不存在则生成并写入，否则读取已有内容
#[tauri::command]
pub async fn ensure_plugin_default_config(plugin_id: String) -> Result<serde_json::Value, String> {
    PluginManager::global()
        .ensure_plugin_default_config_loaded(&plugin_id)
        .await
}

#[tauri::command]
pub async fn save_plugin_default_config(
    plugin_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    PluginManager::global().save_plugin_default_config(&plugin_id, &config)
}

/// 按插件当前变量定义重新生成默认配置并覆盖写入
#[tauri::command]
pub async fn reset_plugin_default_config(plugin_id: String) -> Result<serde_json::Value, String> {
    PluginManager::global()
        .reset_plugin_default_config(&plugin_id)
        .await
}

#[tauri::command]
pub async fn get_plugin_sources() -> Result<serde_json::Value, String> {
    let sources = PluginManager::global().load_plugin_sources()?;
    Ok(serde_json::to_value(sources).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_data(plugin_id: String) -> Result<serde_json::Value, String> {
    Storage::global()
        .plugin_data()
        .get(&plugin_id)
        .map_err(|e| e.to_string())
        .map(|v| v.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub async fn add_plugin_source(
    id: Option<String>,
    name: String,
    index_url: String,
) -> Result<serde_json::Value, String> {
    let source = PluginManager::global().add_plugin_source(id, name, index_url)?;
    Ok(serde_json::to_value(source).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn update_plugin_source(
    id: String,
    name: String,
    index_url: String,
) -> Result<(), String> {
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
    revalidate_if_stale_after_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    let plugins = PluginManager::global()
        .fetch_store_plugins(
            source_id.as_deref(),
            force_refresh.unwrap_or(false),
            revalidate_if_stale_after_secs,
        )
        .await?;
    Ok(serde_json::to_value(plugins).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_plugin_detail(
    plugin_id: String,
    source_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let plugin = match source_id {
        Some(sid) => plugin_manager.load_remote_plugin(&sid, &plugin_id).await?,
        None => {
            plugin_manager
                .load_installed_plugin_detail(&plugin_id)
                .await?
        }
    };
    Ok(serde_json::to_value(plugin).map_err(|e| e.to_string())?)
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
    let plugin = PluginManager::global()
        .preview_import_from_kgpg(&path)
        .await?;
    Ok(serde_json::to_value(plugin).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn preview_store_install(
    source_id: String,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let plugin_manager = PluginManager::global();
    let cached_path = plugin_manager
        .ensure_plugin_cached(&source_id, &plugin_id)
        .await?;
    let plugin = plugin_manager
        .preview_import_from_kgpg(&cached_path)
        .await?;
    Ok(serde_json::json!({
        "tmpPath": cached_path.to_string_lossy().to_string(),
        "plugin": plugin,
    }))
}

#[tauri::command]
pub async fn import_plugin_from_zip(zip_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&zip_path);
    let plugin = PluginManager::global()
        .install_plugin_from_kgpg(path)
        .await?;
    Ok(serde_json::json!({ "pluginId": plugin.id }))
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
