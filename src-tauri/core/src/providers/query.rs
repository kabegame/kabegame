//! Provider 路径查询语法 — Tauri/MCP 边界使用。
//!
//! 语法:
//! - `<path>`       → 单个 entry：resolve path → meta + note + total（按该节点 composed query 的 COUNT）
//! - `<path>/`      → `list_dir()`（子 Child 不带 meta）+ `list_images()` + total
//! - `<path>/*`     → `list_dir_with_meta()`（子 Child 带批量 meta）+ `list_images()` + total
//!
//! Images 混合在 entries 数组里（Dir 在前，Image 在后）。
//!
//! `total` 字段语义（Entry 与 Listing 一致）：将该路径的 composed query（由
//! [`Provider::apply_query`](super::provider::Provider::apply_query) 沿链累积）
//! build 成 `SELECT COUNT(*)` 并执行，得到匹配当前过滤/搜索/JOIN/WHERE 的图片总数。
//! 前端在需要展示总数但不需要当前页 entries 时，应优先使用无尾缀语法
//! （例如 `all`、`search/display-name/<q>/all`），避免额外触发 `list_children` / `list_images`。

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

/// 对 provider 路径逐段 percent-decode：按 `/` 拆分，对每个非空段做 UTF-8 解码
/// （失败时保留原段），再用 `/` 重新拼接。保留前导/尾随 `/` 与结尾的 `/*` 语法。
///
/// 用于 tauri / web 边界统一解码前端用 `encodeURIComponent` 编码的动态段
/// （如搜索查询 `search/display-name/<q>/`、画册/任务 id 等），让所有 provider
/// 拿到的都是原始字符串，无需各自处理 URL 编码。
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
        /// 按该节点 composed query 计算出的匹配图片总数；COUNT 失败时为 `None`。
        total: Option<usize>,
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
            let total = Storage::global().get_images_count_by_query(&node.composed).ok();
            Ok(ProviderQueryTyped::Entry {
                name: last,
                meta: node.provider.get_meta(),
                note: node.provider.get_note(),
                total,
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
        ProviderQueryTyped::Entry { name, meta, note, total } => Ok(json!({
            "name": name,
            "meta": meta,
            "note": note_value(note.clone()),
            "total": total,
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
