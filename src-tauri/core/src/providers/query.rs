//! Provider 路径查询语法 — Tauri/MCP 边界使用。
//!
//! 语法:
//! - `<path>`       → 单个 entry：resolve path → meta + note
//! - `<path>/`      → `list_dir()`（子 Child 不带 meta）+ `list_images()`
//! - `<path>/*`     → `list_dir_with_meta()`（子 Child 带批量 meta）+ `list_images()`
//!
//! Images 混合在 entries 数组里（Dir 在前，Image 在后）。

use serde_json::{json, Value};

use crate::gallery::GalleryBrowseEntry;
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

/// Typed 版本的 provider 查询结果，`execute_provider_query` 的内部表示。
/// 暴露给 web 边界层以便对 `Listing::entries` 里的 `ImageInfo` 做类型化改写
/// （CDN URL 重写等），改写后再用 [`provider_query_to_json`] 序列化为和旧路径
/// 字节级一致的 JSON envelope。
#[derive(Debug)]
pub enum ProviderQueryTyped {
    Entry {
        name: String,
        meta: Option<ProviderMeta>,
        note: Option<(String, String)>,
    },
    Listing {
        entries: Vec<GalleryBrowseEntry>,
        total: Option<usize>,
        meta: Option<ProviderMeta>,
        note: Option<(String, String)>,
    },
}

/// Typed 入口：解析路径并执行查询，返回未序列化的 typed 结果。
pub fn execute_provider_query_typed(raw_path: &str) -> Result<ProviderQueryTyped, String> {
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
            Ok(ProviderQueryTyped::Entry {
                name: last,
                meta: node.provider.get_meta(),
                note: node.provider.get_note(),
            })
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

            let entries = crate::gallery::browse_from_provider(children, images)?;

            let total: Option<usize> =
                Storage::global().get_images_count_by_query(&node.composed).ok();

            Ok(ProviderQueryTyped::Listing {
                entries,
                total,
                meta: node.provider.get_meta(),
                note: node.provider.get_note(),
            })
        }
    }
}

/// 把 typed 查询结果序列化为 Tauri / MCP / web 共用的 JSON envelope 形状。
/// 保持与旧 `execute_provider_query` 字节级一致（字段顺序、null 位置）。
pub fn provider_query_to_json(t: &ProviderQueryTyped) -> Result<Value, String> {
    match t {
        ProviderQueryTyped::Entry { name, meta, note } => Ok(json!({
            "name": name,
            "meta": meta,
            "note": note_value(note.clone()),
        })),
        ProviderQueryTyped::Listing { entries, total, meta, note } => {
            let entries_json = serde_json::to_value(entries).map_err(|e| e.to_string())?;
            Ok(json!({
                "entries": entries_json,
                "total": total,
                "meta": meta,
                "note": note_value(note.clone()),
            }))
        }
    }
}

/// 统一入口：解析路径并执行查询。返回 JSON 值供 Tauri / MCP 直接使用。
///
/// 实现：内部走 [`execute_provider_query_typed`] + [`provider_query_to_json`]。
/// web 边界若需类型化改写请直接调 typed 版本，避免往 Value 上塞 JSON 遍历代码。
pub fn execute_provider_query(raw_path: &str) -> Result<Value, String> {
    let typed = execute_provider_query_typed(raw_path)?;
    provider_query_to_json(&typed)
}
