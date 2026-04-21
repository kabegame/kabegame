//! Provider 路径查询语法 — Tauri/MCP 边界使用。
//!
//! 语法:
//! - `<path>`       → 单个 entry：resolve path → meta + note
//! - `<path>/`      → `list_dir()`（子 Child 不带 meta）+ `list_images()`
//! - `<path>/*`     → `list_dir_with_meta()`（子 Child 带批量 meta）+ `list_images()`
//!
//! Images 混合在 entries 数组里（Dir 在前，Image 在后）。

use serde_json::{json, Value};

use crate::providers::provider::ProviderMeta;
use crate::providers::runtime::ProviderRuntime;
use crate::storage::Storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderPathQuery {
    Entry,
    List,
    ListWithMeta,
}

/// 解析路径语法：返回 (规范化 path, query 模式)。
pub fn parse_provider_path(raw: &str) -> (String, ProviderPathQuery) {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_suffix("/*") {
        return (
            stripped.trim_end_matches('/').to_string(),
            ProviderPathQuery::ListWithMeta,
        );
    }
    if trimmed.ends_with('/') {
        return (
            trimmed.trim_end_matches('/').to_string(),
            ProviderPathQuery::List,
        );
    }
    (trimmed.to_string(), ProviderPathQuery::Entry)
}

fn split_last_segment(path: &str) -> (String, String) {
    let p = path.trim_start_matches('/').trim_end_matches('/');
    match p.rfind('/') {
        Some(idx) => (p[..idx].to_string(), p[idx + 1..].to_string()),
        None => (String::new(), p.to_string()),
    }
}

fn note_value(note: Option<(String, String)>) -> Option<Value> {
    note.map(|(title, content)| json!({ "title": title, "content": content }))
}

/// 统一入口：解析路径并执行查询。返回 JSON 值供 Tauri / MCP 直接使用。
pub fn execute_provider_query(raw_path: &str) -> Result<Value, String> {
    let (path, mode) = parse_provider_path(raw_path);
    let rt = ProviderRuntime::global();

    match mode {
        ProviderPathQuery::Entry => {
            let (_, last) = split_last_segment(&path);
            if last.is_empty() {
                return Err(format!("路径不完整: {}", raw_path));
            }
            let node = rt
                .resolve(&path)?
                .ok_or_else(|| format!("条目不存在: {}", raw_path))?;
            let meta: Option<ProviderMeta> = node.provider.get_meta();
            let note = note_value(node.provider.get_note());
            Ok(json!({
                "name": last,
                "meta": meta,
                "note": note,
            }))
        }
        ProviderPathQuery::List | ProviderPathQuery::ListWithMeta => {
            let node = rt
                .resolve(&path)?
                .ok_or_else(|| format!("路径不存在: {}", path))?;

            let children = if mode == ProviderPathQuery::ListWithMeta {
                node.provider.list_children_with_meta(&node.composed)?
            } else {
                node.provider.list_children(&node.composed)?
            };

            let composed_images = if node.composed.order_bys.is_empty() {
                node.composed.clone().with_order("images.id ASC")
            } else {
                node.composed.clone()
            };
            let images = node.provider.list_images(&composed_images)?;

            let entries_json = {
                let converted =
                    crate::gallery::browse_from_provider(children, images)?;
                serde_json::to_value(&converted).map_err(|e| e.to_string())?
            };

            let meta = node.provider.get_meta();
            let note = note_value(node.provider.get_note());
            let total: Option<usize> =
                Storage::global().get_images_count_by_query(&node.composed).ok();

            Ok(json!({
                "entries": entries_json,
                "total": total,
                "meta": meta,
                "note": note,
            }))
        }
    }
}
