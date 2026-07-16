use kabegame_core::plugin::{Plugin, PluginManager};
use kabegame_core::storage::Storage;
use serde_json::{json, Value};
use std::sync::Arc;

async fn all_plugins() -> Result<Vec<Arc<Plugin>>, String> {
    let pm = PluginManager::global();
    pm.ensure_installed_cache_initialized().await?;
    pm.get_all()
}

/// Web 模式：只回 `{id, version}` 索引，详情由 `get_plugin_detail` 按需单取
/// （详情体积大，web 客户端不需要整份列表）。桌面走 [`get_plugins_full`]。
pub async fn get_plugins() -> Result<Value, String> {
    let plugins = all_plugins().await?;
    let index: Vec<Value> = plugins
        .iter()
        .map(|p| json!({ "id": p.id, "version": p.version }))
        .collect();
    Ok(Value::Array(index))
}

/// 桌面模式：一次返回完整插件列表。
#[cfg(not(feature = "web"))]
pub async fn get_plugins_full() -> Result<Value, String> {
    let plugins = all_plugins().await?;
    serde_json::to_value(plugins).map_err(|e| e.to_string())
}

pub async fn get_plugin_detail(
    plugin_id: String,
    source_id: Option<String>,
) -> Result<Value, String> {
    let pm = PluginManager::global();
    let plugin = match source_id {
        Some(sid) => pm.load_remote_plugin(&sid, &plugin_id).await?,
        None => pm.load_installed_plugin_detail(&plugin_id).await?,
    };
    serde_json::to_value(plugin).map_err(|e| e.to_string())
}

/// 前端手动触发：重扫磁盘后返回最新索引（web）。桌面走 [`refresh_plugins_full`]。
pub async fn refresh_plugins() -> Result<Value, String> {
    PluginManager::global().refresh_plugins().await?;
    get_plugins().await
}

/// 前端手动触发：重扫磁盘后返回完整插件列表（桌面）。
#[cfg(not(feature = "web"))]
pub async fn refresh_plugins_full() -> Result<Value, String> {
    PluginManager::global().refresh_plugins().await?;
    get_plugins_full().await
}

pub fn get_plugin_sources() -> Result<Value, String> {
    let sources = PluginManager::global().load_plugin_sources()?;
    serde_json::to_value(sources).map_err(|e| e.to_string())
}

pub fn get_plugin_data(plugin_id: String) -> Result<Value, String> {
    Storage::global()
        .plugin_data()
        .get(&plugin_id)
        .map_err(|e| e.to_string())
        .map(|v| v.unwrap_or_else(|| json!({})))
}

pub async fn get_store_plugins(
    source_id: Option<String>,
    force_refresh: bool,
    revalidate_if_stale_after_secs: Option<u64>,
) -> Result<Value, String> {
    let plugins = PluginManager::global()
        .fetch_store_plugins(
            source_id.as_deref(),
            force_refresh,
            revalidate_if_stale_after_secs,
        )
        .await?;
    serde_json::to_value(plugins).map_err(|e| e.to_string())
}

pub async fn get_remote_plugin_icon(
    download_url: String,
    source_id: Option<String>,
    plugin_id: Option<String>,
) -> Result<Value, String> {
    let bytes = PluginManager::global()
        .fetch_remote_plugin_icon_v2(&download_url, source_id.as_deref(), plugin_id.as_deref())
        .await?;
    serde_json::to_value(bytes).map_err(|e| e.to_string())
}

pub fn get_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    let v = PluginManager::global().read_plugin_default_config_file(&plugin_id)?;
    serde_json::to_value(v).map_err(|e| e.to_string())
}

pub async fn ensure_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    PluginManager::global()
        .ensure_plugin_default_config_loaded(&plugin_id)
        .await
}

pub fn save_plugin_default_config(plugin_id: String, config: Value) -> Result<Value, String> {
    PluginManager::global().save_plugin_default_config(&plugin_id, &config)?;
    Ok(Value::Null)
}

pub async fn reset_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    PluginManager::global()
        .reset_plugin_default_config(&plugin_id)
        .await
}

pub async fn delete_plugin(plugin_id: String) -> Result<Value, String> {
    PluginManager::global().delete(&plugin_id).await?;
    Ok(Value::Null)
}

pub async fn install_from_store(source_id: String, plugin_id: String) -> Result<Value, String> {
    let plugin = PluginManager::global()
        .install_from_store(&source_id, &plugin_id)
        .await?;
    serde_json::to_value(plugin).map_err(|e| e.to_string())
}

pub async fn import_plugin_from_zip(zip_path: String) -> Result<Value, String> {
    let path = std::path::Path::new(&zip_path);
    let plugin = PluginManager::global()
        .install_plugin_from_kgpg(path)
        .await?;
    Ok(json!({ "pluginId": plugin.id }))
}

pub async fn validate_plugin_source(index_url: String) -> Result<Value, String> {
    PluginManager::global()
        .validate_store_source_index(&index_url)
        .await?;
    Ok(Value::Null)
}

pub fn update_plugin_source(id: String, name: String, index_url: String) -> Result<Value, String> {
    PluginManager::global().update_plugin_source(id, name, index_url)?;
    Ok(Value::Null)
}

pub fn delete_plugin_source(id: String) -> Result<Value, String> {
    PluginManager::global().delete_plugin_source(id)?;
    Ok(Value::Null)
}

pub fn add_plugin_source(
    id: Option<String>,
    name: String,
    index_url: String,
) -> Result<Value, String> {
    let source = PluginManager::global().add_plugin_source(id, name, index_url)?;
    serde_json::to_value(source).map_err(|e| e.to_string())
}

pub async fn preview_import_plugin(zip_path: String) -> Result<Value, String> {
    let path = std::path::PathBuf::from(&zip_path);
    let plugin = PluginManager::global()
        .preview_import_from_kgpg(&path)
        .await?;
    serde_json::to_value(plugin).map_err(|e| e.to_string())
}

pub async fn preview_store_install(source_id: String, plugin_id: String) -> Result<Value, String> {
    let pm = PluginManager::global();
    let cached_path = pm.ensure_plugin_cached(&source_id, &plugin_id).await?;
    let plugin = pm.preview_import_from_kgpg(&cached_path).await?;
    let plugin_value = serde_json::to_value(plugin).map_err(|e| e.to_string())?;
    Ok(json!({
        "tmpPath": cached_path.to_string_lossy().to_string(),
        "plugin": plugin_value,
    }))
}
