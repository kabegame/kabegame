//! Provider 路径查询语法 — Tauri 边界使用。
//!
//! 7b S1e 起：所有"路径 → 图片/计数"查询走 pathql Runtime 的 path-only API
//! ([`images_at`] / [`count_at`])；core 不再持有 `ProviderQuery` /
//! `TemplateContext`。

use pathql_rs::ProviderRuntime;
use serde::Serialize;
use serde_json::Value;

use crate::storage::gallery::{DateGroup, DayGroup, GalleryMediaTypeCounts, PluginGroup};
use crate::storage::gallery_time::{gallery_month_groups_from_days, GalleryTimeFilterPayload};
use crate::storage::images::{parse_image_metadata_json, ImageMetadataFull};
use crate::storage::organize::OrganizeScanRow;
use crate::storage::tasks::TaskFailedImage;
use crate::storage::ImageInfo;

use super::init::provider_runtime;

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

/// 解析 get_note 的 JSON 字符串；非 JSON 时把它当 title=content。
fn parse_note(raw: Option<String>) -> Option<ProviderNote> {
    let s = raw?;
    if let Ok(v) = serde_json::from_str::<Value>(&s) {
        if let (Some(t), Some(c)) = (
            v.get("title").and_then(|x| x.as_str()),
            v.get("content").and_then(|x| x.as_str()),
        ) {
            return Some(ProviderNote {
                title: t.to_string(),
                content: c.to_string(),
            });
        }
    }
    Some(ProviderNote {
        title: s.clone(),
        content: s,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderEntry {
    pub name: String,
    pub meta: Option<Value>,
    pub note: Option<ProviderNote>,
    pub total: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderNote {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderListChild {
    pub name: String,
    pub meta: Option<Value>,
    pub total: Option<usize>,
}

fn normalize_for_runtime(path: &str) -> String {
    if path.contains("://") {
        return path.to_string();
    }
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        "images://".to_string()
    } else {
        format!("images://{}", trimmed)
    }
}

pub fn runtime_path(raw: &str) -> String {
    normalize_for_runtime(raw)
}

fn trim_provider_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.ends_with("://") {
        trimmed.to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

fn encode_provider_path_segment(s: &str) -> String {
    s.bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![b as char]
            }
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

fn child_runtime_path(base: &str, child_name: &str) -> String {
    if base.ends_with("://") {
        format!("{}{}", base, encode_provider_path_segment(child_name))
    } else {
        format!(
            "{}/{}",
            base.trim_end_matches('/'),
            encode_provider_path_segment(child_name)
        )
    }
}

fn query_entry_with_runtime(rt: &ProviderRuntime, raw_path: &str) -> Result<ProviderEntry, String> {
    let path = trim_provider_path(raw_path);
    let rt_path = normalize_for_runtime(&path);
    let (_, last) = split_last_segment(&path);
    if last.is_empty() {
        return Err(format!("路径不完整: {}", raw_path));
    }
    let total = rt.count(&rt_path).ok();
    let raw_note = rt
        .note(&rt_path)
        .map_err(|e| format!("note failed: {}", e))?;
    let meta = rt
        .meta(&rt_path)
        .map_err(|e| format!("meta failed: {}", e))?;
    Ok(ProviderEntry {
        name: last,
        meta,
        note: parse_note(raw_note),
        total,
    })
}

pub fn query_entry(raw_path: &str) -> Result<ProviderEntry, String> {
    query_entry_with_runtime(provider_runtime(), raw_path)
}

fn query_list_with_runtime(
    rt: &ProviderRuntime,
    raw_path: &str,
    with_count: bool,
) -> Result<Vec<ProviderListChild>, String> {
    let rt_path = normalize_for_runtime(&trim_provider_path(raw_path));
    let base = if rt_path.ends_with("://") {
        rt_path.clone()
    } else {
        rt_path.trim_end_matches('/').to_string()
    };
    let children = rt
        .list(&rt_path)
        .map_err(|e| format!("list children failed: {}", e))?;

    children
        .into_iter()
        .map(|child| {
            let total = if with_count {
                rt.count(&child_runtime_path(&base, &child.name)).ok()
            } else {
                None
            };
            Ok(ProviderListChild {
                name: child.name,
                meta: child.meta,
                total,
            })
        })
        .collect()
}

pub fn query_list(raw_path: &str, with_count: bool) -> Result<Vec<ProviderListChild>, String> {
    query_list_with_runtime(provider_runtime(), raw_path, with_count)
}

fn query_fetch_with_runtime(rt: &ProviderRuntime, raw_path: &str) -> Result<Vec<Value>, String> {
    let rt_path = normalize_for_runtime(&trim_provider_path(raw_path));
    rt.fetch(&rt_path).map_err(|e| e.to_string())
}

pub fn query_fetch(raw_path: &str) -> Result<Vec<Value>, String> {
    query_fetch_with_runtime(provider_runtime(), raw_path)
}

/// **Engine service**: 路径 → ImageInfo 列表。
/// 内部：`runtime.fetch(path)` → JSON 行 → 按列名映射到 ImageInfo (gallery_route alias 契约)。
/// 不带启发式分支；调用方负责传一个能限定范围的 path
/// (例如 `images://gallery/all/x100x/3`，避免在 `images://gallery/` 等根路径上调本函数)。
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

fn json_header_snapshot(
    row: &Value,
) -> Result<Option<std::collections::HashMap<String, String>>, String> {
    let Some(value) = row.get("header_snapshot") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                serde_json::from_str(trimmed)
                    .map(Some)
                    .map_err(|e| format!("invalid failed image header_snapshot: {}", e))
            }
        }
        other => serde_json::from_value(other.clone())
            .map(Some)
            .map_err(|e| format!("invalid failed image header_snapshot: {}", e)),
    }
}

fn json_row_to_task_failed_image(row: &Value) -> Result<TaskFailedImage, String> {
    Ok(TaskFailedImage {
        id: json_i64(row, "id").ok_or("failed image row missing `id`")?,
        task_id: json_string(row, "task_id").ok_or("failed image row missing `task_id`")?,
        plugin_id: json_string(row, "plugin_id").ok_or("failed image row missing `plugin_id`")?,
        url: json_string(row, "url").ok_or("failed image row missing `url`")?,
        order: json_i64(row, "order").unwrap_or_default(),
        created_at: json_i64(row, "created_at").unwrap_or_default(),
        last_error: json_string(row, "last_error"),
        last_attempted_at: json_i64(row, "last_attempted_at"),
        header_snapshot: json_header_snapshot(row)?,
        metadata_id: json_i64(row, "metadata_id"),
        display_name: json_string(row, "display_name"),
    })
}

/// `fail-images://...` → task failed image rows.
pub fn failed_images_at(path: &str) -> Result<Vec<TaskFailedImage>, String> {
    let rows = raw_rows_at(path)?;
    rows.iter().map(json_row_to_task_failed_image).collect()
}

/// `images://x{N}x/{page}` → organize scan rows.
pub fn organize_batch_at(page_size: usize, page: usize) -> Result<Vec<OrganizeScanRow>, String> {
    let page_size = page_size.max(1);
    let page = page.max(1);
    let rows = raw_rows_at(&format!("images://x{}x/{}", page_size, page))?;
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

/// `images://id_{id}/metadata` → metadata JSON from `image_metadata.data`.
pub fn image_metadata_at(image_id: &str) -> Result<Option<Value>, String> {
    let encoded = urlencoding::encode(image_id.trim());
    let rows = raw_rows_at(&format!("images://id_{}/metadata", encoded))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    Ok(parse_image_metadata_json(json_string(row, "metadata_json")))
}

/// `images://id_{id}/metadata_full` → full metadata row from `image_metadata`.
pub fn image_metadata_full_at(image_id: &str) -> Result<Option<ImageMetadataFull>, String> {
    let encoded = urlencoding::encode(image_id.trim());
    let rows = raw_rows_at(&format!("images://id_{}/metadata_full", encoded))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let Some(id) = json_i64(row, "id") else {
        return Ok(None);
    };
    let version = json_i64(row, "version").unwrap_or_default().max(0) as u32;
    Ok(Some(ImageMetadataFull {
        id,
        data: parse_image_metadata_json(json_string(row, "data")),
        version,
        plugin_id: json_string(row, "plugin_id").unwrap_or_default(),
        content_hash: json_string(row, "content_hash").unwrap_or_default(),
    }))
}

pub fn gallery_total_count_at() -> Result<usize, String> {
    count_at("images://gallery/all")
}

pub fn gallery_plugin_groups_at() -> Result<Vec<PluginGroup>, String> {
    let rt = provider_runtime();
    let children = rt
        .list("images://gallery/plugin")
        .map_err(|e| format!("list images://gallery/plugin failed: {}", e))?;
    children
        .into_iter()
        .map(|child| {
            let count = count_at(&format!(
                "images://gallery/plugin/{}",
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
        .list("images://gallery/date")
        .map_err(|e| format!("list images://gallery/date failed: {}", e))?
    {
        let Some(y) = year.name.strip_suffix('y') else {
            continue;
        };
        if y.len() != 4 || !y.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let year_path = format!("images://gallery/date/{}", year.name);
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
    let base = format!("images://gallery/album/{}", encoded);
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
        let child_path = format!("images://gallery/album/{}/order/x3x/1", child_encoded);
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

/// JSON 行 → ImageInfo (按 gallery_route fields 的 alias 契约读列)。
/// alias 名硬契约: id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
/// metadata_id, metadata_version, thumbnail_path, hash, is_favorite, is_hidden, width, height, display_name,
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
        surf_record_id: s("surf_record_id"),
        crawled_at: i("crawled_at")
            .filter(|&t| t >= 0)
            .map(|t| t as u64)
            .unwrap_or(0),
        metadata_id: i("metadata_id"),
        metadata_version: i("metadata_version")
            .filter(|&v| v >= 0)
            .map(|v| v as u32)
            .unwrap_or(0),
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use pathql_rs::provider::{ClosureExecutor, EngineError, SqlDialect};
    use pathql_rs::template::eval::TemplateValue;
    use pathql_rs::ProviderRuntime;
    use rusqlite::functions::FunctionFlags;
    use rusqlite::Connection;

    use super::{
        query_entry_with_runtime, query_fetch_with_runtime, query_list_with_runtime, runtime_path,
    };
    use crate::providers::dsl_loader::{register_embedded_dsl, validate_dsl};

    fn local_params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
        use rusqlite::types::Value;
        values
            .iter()
            .map(|v| match v {
                TemplateValue::Null => Value::Null,
                TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
                TemplateValue::Int(i) => Value::Integer(*i),
                TemplateValue::Real(r) => Value::Real(*r),
                TemplateValue::Text(s) => Value::Text(s.clone()),
                TemplateValue::Json(v) => Value::Text(v.to_string()),
            })
            .collect()
    }

    fn fixture_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        conn.create_scalar_function(
            "get_plugin",
            -1,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
            |ctx| -> rusqlite::Result<String> {
                let plugin_id: String = ctx.get(0)?;
                Ok(serde_json::json!({
                    "id": plugin_id,
                    "name": "Pixel Plugin",
                    "description": "fixture"
                })
                .to_string())
            },
        )
        .unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE images (
                id INTEGER PRIMARY KEY,
                url TEXT,
                local_path TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                task_id TEXT,
                surf_record_id TEXT,
                crawled_at INTEGER NOT NULL,
                metadata_id INTEGER,
                thumbnail_path TEXT NOT NULL DEFAULT '',
                hash TEXT NOT NULL DEFAULT '',
                type TEXT DEFAULT 'image',
                width INTEGER,
                height INTEGER,
                display_name TEXT NOT NULL DEFAULT '',
                last_set_wallpaper_at INTEGER,
                size INTEGER
            );
            CREATE TABLE album_images (
                album_id TEXT NOT NULL,
                image_id INTEGER NOT NULL,
                "order" INTEGER,
                PRIMARY KEY (album_id, image_id)
            );
            CREATE TABLE image_metadata (
                id INTEGER PRIMARY KEY,
                data TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                plugin_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE albums (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                parent_id TEXT
            );
            INSERT INTO albums VALUES
                ('album-a', 'Album A', 1, NULL),
                ('album-b', 'Album B', 2, NULL);
            "#,
        )
        .unwrap();
        for id in 1..=12 {
            conn.execute(
                "INSERT INTO images
                 (id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
                  metadata_id, thumbnail_path, hash, type, width, height, display_name, size)
                 VALUES (?1, ?2, ?3, 'pixiv', NULL, NULL, ?4, NULL, '', ?5, 'image/jpeg', 100, 100, ?6, 10)",
                (
                    id,
                    format!("https://example.test/{id}.jpg"),
                    format!("D:/fixture/{id}.jpg"),
                    id,
                    format!("hash-{id}"),
                    format!("image-{id}"),
                ),
            )
            .unwrap();
        }
        Arc::new(Mutex::new(conn))
    }

    fn make_executor(conn: Arc<Mutex<Connection>>) -> Arc<dyn pathql_rs::SqlExecutor> {
        Arc::new(ClosureExecutor::new(
            SqlDialect::Sqlite,
            move |sql: &str, params: &[TemplateValue]| {
                let conn = conn.lock().unwrap();
                let mut stmt = conn.prepare(sql).map_err(|e| {
                    EngineError::FactoryFailed("sqlite".into(), "prepare".into(), e.to_string())
                })?;
                let rusq_params = local_params_for(params);
                let col_names: Vec<String> = stmt
                    .column_names()
                    .into_iter()
                    .map(|s| s.to_string())
                    .collect();
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                        let mut obj = serde_json::Map::new();
                        for (i, name) in col_names.iter().enumerate() {
                            let value = match row.get_ref_unwrap(i) {
                                rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                                rusqlite::types::ValueRef::Integer(i) => serde_json::Value::from(i),
                                rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
                                rusqlite::types::ValueRef::Text(t) => serde_json::Value::String(
                                    String::from_utf8_lossy(t).into_owned(),
                                ),
                                rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                            };
                            obj.insert(name.clone(), value);
                        }
                        Ok(serde_json::Value::Object(obj))
                    })
                    .map_err(|e| {
                        EngineError::FactoryFailed("sqlite".into(), "query".into(), e.to_string())
                    })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                    EngineError::FactoryFailed("sqlite".into(), "collect".into(), e.to_string())
                })
            },
        ))
    }

    fn build_runtime() -> Arc<ProviderRuntime> {
        let globals = HashMap::from([
            (
                "favorite_album_id".to_string(),
                TemplateValue::Text(crate::storage::FAVORITE_ALBUM_ID.to_string()),
            ),
            (
                "hidden_album_id".to_string(),
                TemplateValue::Text(crate::storage::HIDDEN_ALBUM_ID.to_string()),
            ),
        ]);
        let runtime = ProviderRuntime::new(make_executor(fixture_db()), globals);
        register_embedded_dsl(&runtime);
        validate_dsl(&runtime);
        runtime
            .register_schema("images", "images", "kabegame", "images_root_provider")
            .unwrap();
        runtime
            .register_schema("albums", "albums", "kabegame", "albums_root_provider")
            .unwrap();
        runtime
    }

    #[test]
    fn runtime_path_promotes_schemeless_paths_to_images_schema() {
        assert_eq!(runtime_path(""), "images://");
        assert_eq!(runtime_path("/"), "images://");
        assert_eq!(runtime_path("gallery/all"), "images://gallery/all");
        assert_eq!(runtime_path("/gallery/all"), "images://gallery/all");
    }

    #[test]
    fn runtime_path_keeps_existing_scheme() {
        assert_eq!(runtime_path("images://x100x/1"), "images://x100x/1");
        assert_eq!(runtime_path("vd://locale"), "vd://locale");
        assert_eq!(runtime_path("albums://all"), "albums://all");
    }

    #[test]
    fn query_entry_returns_metadata_note_and_total() {
        let runtime = build_runtime();
        let entry = query_entry_with_runtime(&runtime, "images://gallery/all").unwrap();
        assert_eq!(entry.name, "all");
        assert_eq!(entry.total, Some(12));
        assert!(entry.note.is_some());
    }

    #[test]
    fn query_list_can_include_or_skip_child_totals() {
        let runtime = build_runtime();
        let with_count =
            query_list_with_runtime(&runtime, "images://gallery/plugin", true).unwrap();
        assert_eq!(with_count.len(), 1);
        assert_eq!(with_count[0].name, "pixiv");
        assert_eq!(with_count[0].total, Some(12));

        let without_count =
            query_list_with_runtime(&runtime, "images://gallery/plugin", false).unwrap();
        assert_eq!(without_count.len(), 1);
        assert_eq!(without_count[0].name, "pixiv");
        assert_eq!(without_count[0].total, None);
    }

    #[test]
    fn query_fetch_returns_schema_agnostic_rows() {
        let runtime = build_runtime();
        let rows = query_fetch_with_runtime(&runtime, "images://gallery/all/x10x/1").unwrap();
        assert_eq!(rows.len(), 10);
        assert!(rows.iter().all(|row| row.get("id").is_some()));

        let albums = query_fetch_with_runtime(&runtime, "albums://all").unwrap();
        assert_eq!(albums.len(), 2);
        assert!(albums.iter().all(|row| row.get("name").is_some()));
    }
}
