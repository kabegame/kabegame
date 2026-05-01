//! Provider 体系 (7c 起: 全 DSL)。
//!
//! - [`provider`] — pathql-rs 类型 reexport + 前端 wire format helper
//! - [`dsl_loader`] — include_dir 嵌入的 dsl/**/*.json5 全量加载
//! - [`init`] — provider_runtime() 单例
//! - [`query`] — Tauri/MCP IPC 边界 (execute_provider_query / typed)
//! - [`sql_executor`] — pathql_rs::SqlExecutor 的 rusqlite 实现 (注入 Storage db)

pub mod dsl_loader;
pub mod init;
pub mod provider;
pub mod query;
pub mod sql_executor;

#[cfg(feature = "virtual-driver")]
pub(crate) mod vd_ops;

// ── 公开 re-exports ──────────────────────────────────────────────────────────

pub use dsl_loader::is_provider_file_path;
pub use init::{provider_runtime, provider_template_context};
pub use pathql_rs::ProviderRuntime;
pub use query::{
    album_preview_at, count_at, decode_provider_path_segments, execute_provider_query,
    execute_provider_query_typed, gallery_date_groups_at, gallery_day_groups_at,
    gallery_media_type_counts_at, gallery_plugin_groups_at, gallery_time_filter_payload_at,
    gallery_total_count_at, image_metadata_at, images_at, organize_batch_at, parse_provider_path,
    provider_query_to_json, ProviderPathQuery, ProviderQueryTyped,
};

/// VD 专用：从 PluginManager 缓存读取插件显示名（用于「按任务」目录名展示）。
#[cfg(feature = "virtual-driver")]
#[allow(unused_variables)]
pub fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    let pid = plugin_id.trim();
    if pid.is_empty() {
        return None;
    }
    let pm = crate::plugin::PluginManager::global_opt()?;
    let name = pm.get_cached_plugin_display_name_sync(pid)?;
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

pub use crate::storage::gallery_time::{
    gallery_month_groups_from_days, GalleryTimeFilterPayload, GalleryTimeGroupIndex,
};
