//! 插件命令的共享实现层。
//!
//! `get_plugins` / `refresh_plugins` **不在**此处：桌面要整份列表、web 只要
//! `{id, version}` 索引，两者形状不同，各自在 `kabegame` crate 的调用方实现
//! （`commands::plugin` 与 `web::dispatch`）。本层只放两端一致的插件命令。

use crate::plugin::PluginManager;
use crate::storage::Storage;
use serde_json::{json, Value};

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
        .fetch_remote_plugin_icon_v3(&download_url, source_id.as_deref(), plugin_id.as_deref())
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
