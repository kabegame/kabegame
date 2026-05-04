//! Provider 路径查询语法 — Tauri/MCP 边界使用。
//!
//! 7b S1e 起：所有"路径 → 图片/计数"查询走 pathql Runtime 的 path-only API
//! ([`images_at`] / [`count_at`])；core 不再持有 `ProviderQuery` /
//! `TemplateContext`。

use serde_json::{json, Value};

use crate::gallery::GalleryBrowseEntry;
use crate::storage::gallery::{DateGroup, DayGroup, GalleryMediaTypeCounts, PluginGroup};
use crate::storage::gallery_time::{gallery_month_groups_from_days, GalleryTimeFilterPayload};
use crate::storage::images::parse_image_metadata_json;
use crate::storage::organize::OrganizeScanRow;
use crate::storage::ImageInfo;

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
            let total = count_at(&rt_path).ok();
            let raw_note = rt
                .note(&rt_path)
                .map_err(|e| format!("note failed: {}", e))?;
            let meta = rt
                .meta(&rt_path)
                .map_err(|e| format!("meta failed: {}", e))?;
            Ok(ProviderQueryTyped::Entry {
                name: last,
                meta,
                note: parse_note(raw_note),
                total,
            })
        }
        ProviderPathQuery::List | ProviderPathQuery::ListWithMeta => {
            let children = rt
                .list(&rt_path)
                .map_err(|e| format!("list children failed: {}", e))?;

            let images = images_for_listing(&rt_path)?;
            let entries = crate::gallery::browse_from_provider_jsonmeta(children, images)?;

            let total = count_at(&rt_path).ok();

            let raw_note = rt
                .note(&rt_path)
                .map_err(|e| format!("note failed: {}", e))?;
            let meta = rt
                .meta(&rt_path)
                .map_err(|e| format!("meta failed: {}", e))?;

            Ok(ProviderQueryTyped::Listing {
                entries,
                total,
                meta,
                note: parse_note(raw_note),
            })
        }
    }
}

/// **Engine service**: 路径 → ImageInfo 列表。
/// 内部：`runtime.fetch(path)` → JSON 行 → 按列名映射到 ImageInfo (gallery_route alias 契约)。
/// 不带启发式分支；调用方负责传一个能限定范围的 path
/// (例如 `/gallery/all/x100x/3`，避免在 `/gallery/` 等根路径上调本函数)。
pub fn images_at(path: &str) -> Result<Vec<ImageInfo>, String> {
    let rt = provider_runtime();
    let rows = rt.fetch(path).map_err(|e| e.to_string())?;
    rows.iter().map(json_row_to_image_info).collect()
}

/// **Engine service**: 路径 → 行数 (`SELECT COUNT(*)` wrapper)。
pub fn count_at(path: &str) -> Result<usize, String> {
    provider_runtime().count(path).map_err(|e| e.to_string())
}

fn raw_rows_at(path: &str) -> Result<Vec<Value>, String> {
    provider_runtime().fetch(path).map_err(|e| e.to_string())
}

fn json_string(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|i| i.to_string()))
            .or_else(|| v.as_u64().map(|i| i.to_string()))
    })
}

fn json_i64(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
            .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    })
}

/// `/images/x{N}x/{page}` → organize scan rows.
pub fn organize_batch_at(page_size: usize, page: usize) -> Result<Vec<OrganizeScanRow>, String> {
    let page_size = page_size.max(1);
    let page = page.max(1);
    let rows = raw_rows_at(&format!("/images/x{}x/{}", page_size, page))?;
    rows.iter()
        .map(|row| {
            Ok(OrganizeScanRow {
                id: json_i64(row, "id").ok_or("organize row missing `id`")?,
                hash: json_string(row, "hash").unwrap_or_default(),
                local_path: json_string(row, "local_path")
                    .ok_or("organize row missing `local_path`")?,
                thumbnail_path: json_string(row, "thumbnail_path").unwrap_or_default(),
            })
        })
        .collect()
}

/// `/images/id_{id}/metadata` → metadata JSON from `image_metadata.data`.
pub fn image_metadata_at(image_id: &str) -> Result<Option<Value>, String> {
    let encoded = urlencoding::encode(image_id.trim());
    let rows = raw_rows_at(&format!("/images/id_{}/metadata", encoded))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    Ok(parse_image_metadata_json(json_string(row, "metadata_json")))
}

pub fn gallery_total_count_at() -> Result<usize, String> {
    count_at("/gallery/all")
}

pub fn gallery_plugin_groups_at() -> Result<Vec<PluginGroup>, String> {
    let rt = provider_runtime();
    let children = rt
        .list("/gallery/plugin")
        .map_err(|e| format!("list /gallery/plugin failed: {}", e))?;
    children
        .into_iter()
        .map(|child| {
            let count = count_at(&format!(
                "/gallery/plugin/{}",
                urlencoding::encode(&child.name)
            ))?;
            Ok(PluginGroup {
                plugin_id: child.name,
                count,
            })
        })
        .collect()
}

pub fn gallery_media_type_counts_at(base_path: &str) -> Result<GalleryMediaTypeCounts, String> {
    let base = normalize_for_runtime(base_path)
        .trim_end_matches('/')
        .to_string();
    Ok(GalleryMediaTypeCounts {
        image_count: count_at(&format!("{}/media-type/image", base))?,
        video_count: count_at(&format!("{}/media-type/video", base))?,
    })
}

pub fn gallery_day_groups_at() -> Result<Vec<DayGroup>, String> {
    let rt = provider_runtime();
    let mut days = Vec::new();
    for year in rt
        .list("/gallery/date")
        .map_err(|e| format!("list /gallery/date failed: {}", e))?
    {
        let Some(y) = year.name.strip_suffix('y') else {
            continue;
        };
        if y.len() != 4 || !y.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let year_path = format!("/gallery/date/{}", year.name);
        for month in rt
            .list(&year_path)
            .map_err(|e| format!("list {} failed: {}", year_path, e))?
        {
            let Some(m) = month.name.strip_suffix('m') else {
                continue;
            };
            if m.len() != 2 || !m.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let month_path = format!("{}/{}", year_path, month.name);
            for day in rt
                .list(&month_path)
                .map_err(|e| format!("list {} failed: {}", month_path, e))?
            {
                let Some(d) = day.name.strip_suffix('d') else {
                    continue;
                };
                if d.len() != 2 || !d.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let day_path = format!("{}/{}", month_path, day.name);
                days.push(DayGroup {
                    ymd: format!("{y}-{m}-{d}"),
                    count: count_at(&day_path)?,
                });
            }
        }
    }
    Ok(days)
}

pub fn gallery_date_groups_at() -> Result<Vec<DateGroup>, String> {
    Ok(gallery_month_groups_from_days(&gallery_day_groups_at()?))
}

pub fn gallery_time_filter_payload_at() -> Result<GalleryTimeFilterPayload, String> {
    Ok(GalleryTimeFilterPayload::from_storage_days(
        gallery_day_groups_at()?,
    ))
}

pub fn album_preview_at(album_id: &str, limit: usize) -> Result<Vec<ImageInfo>, String> {
    let limit = limit.max(1);
    let encoded = urlencoding::encode(album_id.trim());
    let base = format!("/gallery/album/{}", encoded);
    let mut out = images_at(&format!("{}/order/x{}x/1", base, limit))?;
    if out.len() >= limit {
        out.truncate(limit);
        return Ok(out);
    }

    let rt = provider_runtime();
    let children = rt
        .list(&base)
        .map_err(|e| format!("list {} failed: {}", base, e))?;
    for child in children {
        let is_album = child
            .meta
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|v| v.as_str())
            == Some("album");
        if !is_album {
            continue;
        }
        let child_id = child
            .meta
            .as_ref()
            .and_then(|m| m.get("data"))
            .and_then(|d| d.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or(&child.name);
        let child_encoded = urlencoding::encode(child_id);
        let child_path = format!("/gallery/album/{}/order/x3x/1", child_encoded);
        for image in images_at(&child_path)? {
            out.push(image);
            if out.len() >= limit {
                out.truncate(limit);
                return Ok(out);
            }
        }
    }
    Ok(out)
}

/// IPC business 包装: 在 listing 模式下挑一组合理的图片显示。
/// `/gallery/` 等根路径不带 limit, 直接 fetch 会拉百万级行 — 此处用 count + last-page-100
/// 启发式选最后一页, 与前端默认行为对齐。
fn images_for_listing(rt_path: &str) -> Result<Vec<ImageInfo>, String> {
    let rt = provider_runtime();
    let node = rt
        .resolve(rt_path)
        .map_err(|e| format!("resolve failed: {}", e))?;
    if node.composed.from.is_none() {
        return Ok(Vec::new());
    }
    if node.composed.limit.is_some() {
        return images_at(rt_path);
    }
    // 无 limit: 取最后一页 100 (前端 root 路径默认期望)
    let total = count_at(rt_path)?;
    if total == 0 {
        return Ok(Vec::new());
    }
    let page_size = 100usize;
    let last_offset = ((total + page_size - 1) / page_size - 1) * page_size;
    let last_page = last_offset / page_size + 1;
    let last_page_path = format!(
        "{}/x{}x/{}",
        rt_path.trim_end_matches('/'),
        page_size,
        last_page
    );
    images_at(&last_page_path)
}

/// JSON 行 → ImageInfo (按 gallery_route 17 fields 的 alias 契约读列)。
/// alias 名硬契约: id, url, local_path, plugin_id, task_id, crawled_at, metadata_id,
/// thumbnail_path, hash, is_favorite, is_hidden, width, height, display_name,
/// media_type, last_set_wallpaper_at, size。
fn json_row_to_image_info(row: &Value) -> Result<ImageInfo, String> {
    let obj = row.as_object().ok_or("executor row not a JSON object")?;
    let s = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(String::from);
    let i = |k: &str| obj.get(k).and_then(|v| v.as_i64());
    let b = |k: &str| match obj.get(k) {
        Some(Value::Bool(v)) => *v,
        Some(v) => v.as_i64().unwrap_or(0) != 0,
        None => false,
    };
    Ok(ImageInfo {
        id: s("id").ok_or("row missing `id`")?,
        url: s("url"),
        local_path: s("local_path").ok_or("row missing `local_path`")?,
        plugin_id: s("plugin_id").ok_or("row missing `plugin_id`")?,
        task_id: s("task_id"),
        surf_record_id: None,
        crawled_at: i("crawled_at")
            .filter(|&t| t >= 0)
            .map(|t| t as u64)
            .unwrap_or(0),
        metadata_id: i("metadata_id"),
        thumbnail_path: s("thumbnail_path").unwrap_or_default(),
        hash: s("hash").unwrap_or_default(),
        favorite: b("is_favorite"),
        is_hidden: b("is_hidden"),
        local_exists: true,
        width: i("width").map(|v| v as u32),
        height: i("height").map(|v| v as u32),
        display_name: s("display_name").unwrap_or_default(),
        media_type: crate::image_type::normalize_stored_media_type(s("media_type")),
        last_set_wallpaper_at: i("last_set_wallpaper_at")
            .filter(|&t| t >= 0)
            .map(|t| t as u64),
        size: i("size").map(|v| v as u64),
        album_order: i("album_order"),
    })
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
