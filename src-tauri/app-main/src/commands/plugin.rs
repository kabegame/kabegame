// 插件相关命令

use crate::daemon_client;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

#[tauri::command]
pub async fn get_plugins() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 前端手动刷新"已安装源"：触发后端重扫 plugins-directory 并重建缓存
#[tauri::command]
pub async fn refresh_installed_plugins_cache() -> Result<(), String> {
    // daemon 侧会在 get_plugins 时刷新 installed cache
    let _ = daemon_client::get_ipc_client()
        .plugin_get_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

/// 前端安装/更新后可调用：按 pluginId 局部刷新缓存
#[tauri::command]
pub fn refresh_installed_plugin_cache(
    plugin_id: String,
) -> Result<(), String> {
    // 兜底：触发一次 detail 加载，相当于"按 id 刷新缓存"
    tauri::async_runtime::block_on(async {
        let _ = daemon_client::get_ipc_client()
            .plugin_get_detail(plugin_id)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_build_mode() -> Result<String, String> {
    Ok(env!("KABEGAME_BUILD_MODE").to_string())
}

#[tauri::command]
pub async fn delete_plugin(plugin_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .plugin_delete(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_plugin_vars(plugin_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_vars(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_browser_plugins() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_browser_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_plugin_sources() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_plugin_sources()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn save_plugin_sources(sources: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .plugin_save_plugin_sources(sources)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_store_plugins(
    source_id: Option<String>,
    force_refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_store_plugins(source_id, force_refresh.unwrap_or(false))
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_plugin_detail(
    plugin_id: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_detail_for_ui(plugin_id, download_url, sha256, size_bytes)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn validate_plugin_source(index_url: String) -> Result<(), String> {
    let _ = daemon_client::get_ipc_client()
        .plugin_validate_source(index_url)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn preview_import_plugin(zip_path: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_preview_import(zip_path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn preview_store_install(
    download_url: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_preview_store_install(download_url, sha256, size_bytes)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn import_plugin_from_zip(zip_path: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_import(zip_path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
        .map(|plugin_id| serde_json::json!({ "pluginId": plugin_id }))
}

#[tauri::command]
pub async fn install_browser_plugin(plugin_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_install_browser_plugin(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_plugin_image(plugin_id: String, image_path: String) -> Result<Vec<u8>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_image_for_detail(plugin_id, image_path, None, None, None)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64 = v
        .get("base64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "Invalid response: missing base64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))
}

#[tauri::command]
pub async fn get_plugin_image_for_detail(
    plugin_id: String,
    image_path: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_image_for_detail(plugin_id, image_path, download_url, sha256, size_bytes)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64 = v
        .get("base64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "Invalid response: missing base64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))
}

#[tauri::command]
pub async fn get_plugin_icon(plugin_id: String) -> Result<Option<Vec<u8>>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_icon(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64_opt = v.get("base64").and_then(|x| x.as_str()).map(|s| s.to_string());
    let Some(b64) = b64_opt else { return Ok(None) };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    Ok(Some(bytes))
}

#[tauri::command]
pub async fn get_remote_plugin_icon(download_url: String) -> Result<Option<Vec<u8>>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_remote_icon_v2(download_url)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64_opt = v.get("base64").and_then(|x| x.as_str()).map(|s| s.to_string());
    let Some(b64) = b64_opt else { return Ok(None) };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    Ok(Some(bytes))
}
