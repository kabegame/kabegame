//! Provider 路径查询语法 — Tauri/MCP 边界使用。
//!
//! 6b 起：路径解析走 pathql-rs ProviderRuntime；图片获取直接调 Storage。

use serde_json::{json, Value};

use pathql_rs::ast::NumberOrTemplate;
use pathql_rs::compose::ProviderQuery;

use crate::gallery::GalleryBrowseEntry;
use crate::storage::Storage;

use super::init::provider_runtime;

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

/// 对 provider 路径逐段 percent-decode。
pub fn decode_provider_path_segments(raw: &str) -> String {
    let trimmed = raw.trim();
    let (body, suffix) = if let Some(stripped) = trimmed.strip_suffix("/*") {
        (stripped, "/*")
    } else if trimmed.ends_with('/') {
        (&trimmed[..trimmed.len() - 1], "/")
    } else {
        (trimmed, "")
    };

    let leading_slash = body.starts_with('/');
    let core = body.trim_start_matches('/');

    let decoded: Vec<String> = core
        .split('/')
        .map(|seg| {
            if seg.is_empty() {
                String::new()
            } else {
                urlencoding::decode(seg)
                    .map(|cow| cow.into_owned())
                    .unwrap_or_else(|_| seg.to_string())
            }
        })
        .collect();

    let mut out = String::new();
    if leading_slash {
        out.push('/');
    }
    out.push_str(&decoded.join("/"));
    out.push_str(suffix);
    out
}

fn split_last_segment(path: &str) -> (String, String) {
    let p = path.trim_start_matches('/').trim_end_matches('/');
    match p.rfind('/') {
        Some(idx) => (p[..idx].to_string(), p[idx + 1..].to_string()),
        None => (String::new(), p.to_string()),
    }
}

/// 解析 get_note 的 JSON 字符串到 (title, content)；非 JSON 时把它当 title=content。
fn parse_note(raw: Option<String>) -> Option<(String, String)> {
    let s = raw?;
    if let Ok(v) = serde_json::from_str::<Value>(&s) {
        if let (Some(t), Some(c)) = (
            v.get("title").and_then(|x| x.as_str()),
            v.get("content").and_then(|x| x.as_str()),
        ) {
            return Some((t.to_string(), c.to_string()));
        }
    }
    Some((s.clone(), s))
}

fn note_value(note: Option<(String, String)>) -> Option<Value> {
    note.map(|(title, content)| json!({ "title": title, "content": content }))
}

/// Typed 版本的 provider 查询结果。
#[derive(Debug)]
pub enum ProviderQueryTyped {
    Entry {
        name: String,
        meta: Option<Value>,
        note: Option<(String, String)>,
        total: Option<usize>,
    },
    Listing {
        entries: Vec<GalleryBrowseEntry>,
        total: Option<usize>,
        meta: Option<Value>,
        note: Option<(String, String)>,
    },
}

fn normalize_for_runtime(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{}", path)
    }
}

/// Typed 入口：解析路径并执行查询，返回未序列化的 typed 结果。
pub fn execute_provider_query_typed(raw_path: &str) -> Result<ProviderQueryTyped, String> {
    let (path, mode) = parse_provider_path(raw_path);
    let rt = provider_runtime();
    let rt_path = normalize_for_runtime(&path);

    match mode {
        ProviderPathQuery::Entry => {
            let (_, last) = split_last_segment(&path);
            if last.is_empty() {
                return Err(format!("路径不完整: {}", raw_path));
            }
            let node = rt
                .resolve(&rt_path)
                .map_err(|e| format!("解析路径失败: {}: {}", raw_path, e))?;
            let total = Storage::global().get_images_count_by_query(&node.composed).ok();
            let raw_note = rt
                .note(&rt_path)
                .map_err(|e| format!("note failed: {}", e))?;
            Ok(ProviderQueryTyped::Entry {
                name: last,
                meta: None,
                note: parse_note(raw_note),
                total,
            })
        }
        ProviderPathQuery::List | ProviderPathQuery::ListWithMeta => {
            let node = rt
                .resolve(&rt_path)
                .map_err(|e| format!("解析路径失败: {}: {}", raw_path, e))?;
            let children = rt
                .list(&rt_path)
                .map_err(|e| format!("list children failed: {}", e))?;

            let images = fetch_images_for(&node.composed)?;
            let entries = crate::gallery::browse_from_provider_jsonmeta(children, images)?;

            let total: Option<usize> =
                Storage::global().get_images_count_by_query(&node.composed).ok();

            let raw_note = rt
                .note(&rt_path)
                .map_err(|e| format!("note failed: {}", e))?;

            Ok(ProviderQueryTyped::Listing {
                entries,
                total,
                meta: None,
                note: parse_note(raw_note),
            })
        }
    }
}

/// 决定是否 fetch images：composed.limit 显式 > 0 → 取该页；
/// limit=0（gallery_route 默认）→ 不 fetch；
/// 无 limit → 默认最后一页 100 条。
fn fetch_images_for(
    composed: &ProviderQuery,
) -> Result<Vec<crate::storage::ImageInfo>, String> {
    if composed.from.is_none() {
        return Ok(Vec::new());
    }
    let lim_zero = matches!(composed.limit, Some(NumberOrTemplate::Number(n)) if n == 0.0);
    if lim_zero {
        return Ok(Vec::new());
    }
    if composed.limit.is_some() {
        return Storage::global().get_images_info_range_by_query(composed);
    }
    // 无 limit：默认最后一页 100 条
    let total = Storage::global().get_images_count_by_query(composed)?;
    if total == 0 {
        return Ok(Vec::new());
    }
    let page_size = 100usize;
    let last_offset = ((total + page_size - 1) / page_size - 1) * page_size;
    let mut q = composed.clone();
    q.offset_terms
        .push(NumberOrTemplate::Number(last_offset as f64));
    q.limit = Some(NumberOrTemplate::Number(page_size as f64));
    Storage::global().get_images_info_range_by_query(&q)
}

/// 把 typed 查询结果序列化为 Tauri / MCP / web 共用的 JSON envelope。
pub fn provider_query_to_json(t: &ProviderQueryTyped) -> Result<Value, String> {
    match t {
        ProviderQueryTyped::Entry {
            name,
            meta,
            note,
            total,
        } => Ok(json!({
            "name": name,
            "meta": meta,
            "note": note_value(note.clone()),
            "total": total,
        })),
        ProviderQueryTyped::Listing {
            entries,
            total,
            meta,
            note,
        } => {
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

pub fn execute_provider_query(raw_path: &str) -> Result<Value, String> {
    let typed = execute_provider_query_typed(raw_path)?;
    provider_query_to_json(&typed)
}
