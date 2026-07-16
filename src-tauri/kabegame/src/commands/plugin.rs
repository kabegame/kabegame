//! Plugin 相关命令。Tauri 薄包装：实现在 `commands_core::plugin`，与 Web 模式 RPC 共享。
//!
//! 命令保持 `async fn`（Tauri 只把 async 命令派到工作线程，同步命令跑在主线程），
//! 即使被调的 core 实现是同步的。

use serde_json::Value;

use crate::commands_core;

/// 桌面要整份列表（web 只要 `{id, version}` 索引），故走 `_full` 变体。
#[tauri::command]
pub async fn get_plugins() -> Result<Value, String> {
    commands_core::plugin::get_plugins_full().await
}

/// 前端手动触发：重扫磁盘并返回最新插件列表
#[tauri::command]
pub async fn refresh_plugins() -> Result<Value, String> {
    commands_core::plugin::refresh_plugins_full().await
}

#[tauri::command]
pub fn get_build_mode() -> Result<Value, String> {
    commands_core::misc::get_build_mode()
}

#[tauri::command]
pub async fn delete_plugin(plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::delete_plugin(plugin_id).await
}

#[tauri::command]
pub async fn install_from_store(source_id: String, plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::install_from_store(source_id, plugin_id).await
}

/// 仅读取磁盘上的插件默认配置；不存在返回 `null`，解析失败返回 `Err`
#[tauri::command]
pub async fn get_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::get_plugin_default_config(plugin_id)
}

/// 若默认配置文件不存在则生成并写入，否则读取已有内容
#[tauri::command]
pub async fn ensure_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::ensure_plugin_default_config(plugin_id).await
}

#[tauri::command]
pub async fn save_plugin_default_config(plugin_id: String, config: Value) -> Result<Value, String> {
    commands_core::plugin::save_plugin_default_config(plugin_id, config)
}

/// 按插件当前变量定义重新生成默认配置并覆盖写入
#[tauri::command]
pub async fn reset_plugin_default_config(plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::reset_plugin_default_config(plugin_id).await
}

#[tauri::command]
pub async fn get_plugin_sources() -> Result<Value, String> {
    commands_core::plugin::get_plugin_sources()
}

#[tauri::command]
pub async fn get_plugin_data(plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::get_plugin_data(plugin_id)
}

#[tauri::command]
pub async fn add_plugin_source(
    id: Option<String>,
    name: String,
    index_url: String,
) -> Result<Value, String> {
    commands_core::plugin::add_plugin_source(id, name, index_url)
}

#[tauri::command]
pub async fn update_plugin_source(
    id: String,
    name: String,
    index_url: String,
) -> Result<Value, String> {
    commands_core::plugin::update_plugin_source(id, name, index_url)
}

#[tauri::command]
pub async fn delete_plugin_source(id: String) -> Result<Value, String> {
    commands_core::plugin::delete_plugin_source(id)
}

#[tauri::command]
pub async fn get_store_plugins(
    source_id: Option<String>,
    force_refresh: Option<bool>,
    revalidate_if_stale_after_secs: Option<u64>,
) -> Result<Value, String> {
    commands_core::plugin::get_store_plugins(
        source_id,
        force_refresh.unwrap_or(false),
        revalidate_if_stale_after_secs,
    )
    .await
}

#[tauri::command]
pub async fn get_plugin_detail(
    plugin_id: String,
    source_id: Option<String>,
) -> Result<Value, String> {
    commands_core::plugin::get_plugin_detail(plugin_id, source_id).await
}

#[tauri::command]
pub async fn validate_plugin_source(index_url: String) -> Result<Value, String> {
    commands_core::plugin::validate_plugin_source(index_url).await
}

#[tauri::command]
pub async fn preview_import_plugin(zip_path: String) -> Result<Value, String> {
    commands_core::plugin::preview_import_plugin(zip_path).await
}

#[tauri::command]
pub async fn preview_store_install(source_id: String, plugin_id: String) -> Result<Value, String> {
    commands_core::plugin::preview_store_install(source_id, plugin_id).await
}

#[tauri::command]
pub async fn import_plugin_from_zip(zip_path: String) -> Result<Value, String> {
    commands_core::plugin::import_plugin_from_zip(zip_path).await
}

#[tauri::command]
pub async fn get_remote_plugin_icon(
    download_url: String,
    source_id: Option<String>,
    plugin_id: Option<String>,
) -> Result<Value, String> {
    commands_core::plugin::get_remote_plugin_icon(download_url, source_id, plugin_id).await
}
