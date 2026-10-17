use kabegame_core::storage::{RangedSurfRecords, SurfRecord};
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfSessionStatus {
    pub active: bool,
    /// 当前畅游站点 host（对外索引键，与路由 `/surf/:host/images` 一致）
    pub surf_host: Option<String>,
}

pub(crate) fn parse_external_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("无效 URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持 http 或 https URL".to_string());
    }
    Ok(parsed)
}

/// 新建畅游记录时写入的「根 URL」：与用户输入一致（保留 path、query），仅去掉 fragment。
pub(crate) fn resolve_root_url(parsed: &url::Url) -> String {
    let mut root = parsed.clone();
    root.set_fragment(None);
    root.to_string()
}

pub(crate) fn surf_label(host: &str) -> String {
    // Tauri window labels only allow [a-zA-Z0-9-/:_]; replace '.' with '_'
    format!("surf-{}", host.trim().to_lowercase().replace('.', "_"))
}

pub(crate) fn surf_navbar_label(host: &str) -> String {
    format!("{}-navbar", surf_label(host))
}

pub(crate) fn encode_query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(crate) fn normalize_surf_host(host: &str) -> String {
    host.trim().to_lowercase()
}

#[tauri::command]
pub async fn surf_open_in_browser<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let parsed = parse_external_url(url.trim())?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("打开浏览器失败: {e}"))
}

#[tauri::command]
pub async fn surf_list_records(offset: usize, limit: usize) -> Result<RangedSurfRecords, String> {
    kabegame_core::commands::surf::surf_list_records(offset, limit)
}

#[tauri::command]
pub async fn surf_get_all_records() -> Result<Vec<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_all_records()
}

#[tauri::command]
pub async fn surf_get_records_by_ids(ids: Vec<String>) -> Result<Vec<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_records_by_ids(ids)
}

#[tauri::command]
pub async fn surf_get_record(host: String) -> Result<Option<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_record(host)
}

#[tauri::command]
pub async fn surf_get_record_images(
    host: String,
    offset: usize,
    limit: usize,
) -> Result<serde_json::Value, String> {
    kabegame_core::commands::surf::surf_get_record_images(host, offset, limit)
}

#[tauri::command]
pub async fn surf_update_root_url(
    host: String,
    root_url: String,
) -> Result<serde_json::Value, String> {
    kabegame_core::commands::surf::surf_update_root_url(host, root_url)
}

#[tauri::command]
pub async fn surf_update_name(host: String, name: String) -> Result<serde_json::Value, String> {
    kabegame_core::commands::surf::surf_update_name(host, name)
}

#[tauri::command]
pub async fn surf_delete_record(host: String) -> Result<serde_json::Value, String> {
    kabegame_core::commands::surf::surf_delete_record(host)
}
