use crate::storage::{default_true, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    /// 图片源 URL，本地导入时可为空。
    pub url: Option<String>,
    pub local_path: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename = "surfRecordId")]
    #[serde(default)]
    pub surf_record_id: Option<String>,
    pub crawled_at: u64,
    /// 插件写入的任意 JSON（爬虫 `download_image` 的 `metadata`），用于 EJS 模板渲染详情。
    pub metadata: Option<Value>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    pub favorite: bool,
    /// 本地文件是否存在（用于前端标记缺失文件：仍展示条目，但提示用户源文件已丢失/移动）
    #[serde(default = "default_true")]
    pub local_exists: bool,
    #[serde(default)]
    pub hash: String,
    #[serde(rename = "mimeType")]
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(rename = "displayName")]
    #[serde(default)]
    pub display_name: String,
    #[serde(rename = "type")]
    #[serde(default)]
    pub media_type: Option<String>,
    /// 最后一次被设为壁纸的 Unix 时间戳（秒）；从未设为壁纸则为 None。
    #[serde(rename = "lastSetWallpaperAt")]
    #[serde(default)]
    pub last_set_wallpaper_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaginatedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

/// 解析图片宽高：桌面端用 image crate，Android content:// URI 由前端通过 img 元素获取。
/// Android content:// URI 直接返回 None，由前端异步加载并回写 DB。
fn resolve_image_dimensions(local_path: &str) -> Option<(u32, u32)> {
    #[cfg(target_os = "android")]
    {
        if local_path.starts_with("content://") {
            // Android content:// URI 由前端通过 img.naturalWidth/Height 获取，不在此解析
            return None;
        }
    }

    // 桌面端或 Android file:// 路径：使用 image crate
    match image::image_dimensions(local_path) {
        Ok((w, h)) => Some((w, h)),
        Err(e) => {
            eprintln!("Failed to get image dimensions from image crate: {}", e);
            None
        }
    }
}

fn normalize_media_type(media_type: Option<String>) -> Option<String> {
    match media_type.as_deref() {
        Some("video") => Some("video".to_string()),
        _ => Some("image".to_string()),
    }
}

/// 从 DB `images.metadata` 文本列解析为 JSON；空串或无效则 `None`。
pub(crate) fn parse_image_metadata_json(s: Option<String>) -> Option<Value> {
    s.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            serde_json::from_str(t).ok()
        }
    })
}

/// pixiv 插件：`metadata.body` 仅保留 `description.ejs` 所需字段（与 `crawl.rhai` 的 `pixiv_trim_illust_body` 白名单一致）。
const PIXIV_METADATA_BODY_KEYS: &[&str] = &[
    "illustId",
    "id",
    "title",
    "illustTitle",
    "description",
    "illustComment",
    "userId",
    "userName",
    "uploadDate",
    "createDate",
    "bookmarkCount",
    "likeCount",
    "viewCount",
    "tags",
];

fn trim_pixiv_metadata_body(body: &Value) -> Value {
    let Some(obj) = body.as_object() else {
        return body.clone();
    };
    let mut out = serde_json::Map::new();
    for k in PIXIV_METADATA_BODY_KEYS {
        if let Some(v) = obj.get(*k) {
            out.insert((*k).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

/// 若 `metadata` 含可裁剪的 `body`，返回裁剪后的 JSON；否则 `None`。
pub(crate) fn trim_pixiv_plugin_metadata_if_needed(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let body = obj.get("body")?;
    if !body.is_object() {
        return None;
    }
    let trimmed = trim_pixiv_metadata_body(body);
    if trimmed == *body {
        return None;
    }
    let mut root = value.clone();
    let obj = root.as_object_mut()?;
    obj.insert("body".to_string(), trimmed);
    Some(root)
}

/// 一次性迁移：裁剪已有 pixiv 图片的 `metadata.body`，减轻列表查询读库/IPC 体积。
pub(crate) fn migrate_pixiv_metadata_trim(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, metadata FROM images WHERE plugin_id = 'pixiv' AND metadata IS NOT NULL AND TRIM(metadata) != ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut update_stmt = conn
        .prepare("UPDATE images SET metadata = ?1 WHERE id = ?2")
        .map_err(|e| e.to_string())?;

    for r in rows {
        let (id, meta_str) = r.map_err(|e| e.to_string())?;
        let Ok(v) = serde_json::from_str::<Value>(&meta_str) else {
            continue;
        };
        let Some(trimmed) = trim_pixiv_plugin_metadata_if_needed(&v) else {
            continue;
        };
        let new_str = serde_json::to_string(&trimmed).map_err(|e| e.to_string())?;
        update_stmt
            .execute(params![new_str, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn row_optional_u64_ts(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<Option<u64>> {
    let v: Option<i64> = row.get(idx)?;
    Ok(v.filter(|&t| t >= 0).map(|t| t as u64))
}

impl Storage {
    pub fn get_images_range(&self, offset: usize, limit: usize) -> Result<RangedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total = self.get_images_total_cached(&conn)?;

        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             images.mime_type,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.width,
             images.height,
             images.display_name,
             COALESCE(images.type, 'image') as media_type,
             images.last_set_wallpaper_at
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             ORDER BY images.crawled_at ASC
             LIMIT ? OFFSET ?",
            FAVORITE_ALBUM_ID
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![limit as i64, offset as i64], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get::<_, Option<String>>(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    surf_record_id: row.get(5)?,
                    crawled_at: row.get(6)?,
                    metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                    thumbnail_path: row.get(8)?,
                    hash: row.get(9)?,
                    mime_type: row.get::<_, Option<String>>(10)?,
                    favorite: row.get::<_, i64>(11)? != 0,
                    local_exists: true,
                    width: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                    height: row.get::<_, Option<i64>>(13)?.map(|v| v as u32),
                    display_name: row.get(14)?,
                    media_type: normalize_media_type(row.get::<_, Option<String>>(15)?),
                    last_set_wallpaper_at: row_optional_u64_ts(row, 16)?,
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(RangedImages {
            images,
            total,
            offset,
            limit,
        })
    }

    pub fn get_images_paginated(
        &self,
        page: usize,
        page_size: usize,
    ) -> Result<PaginatedImages, String> {
        let offset = page.saturating_mul(page_size);
        let res = self.get_images_range(offset, page_size)?;
        Ok(PaginatedImages {
            images: res.images,
            total: res.total,
            page,
            page_size,
        })
    }

    pub fn get_all_images(&self) -> Result<Vec<ImageInfo>, String> {
        let result = self.get_images_paginated(0, 10000)?;
        Ok(result.images)
    }

    pub fn find_image_by_id(&self, image_id: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.mime_type,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at
                 FROM images
                 WHERE images.id = ?1",
                params![image_id],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        display_name: row.get(13)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(14)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 15)?,
                    })
                },
            )
            .ok();

        if let Some(ref mut image_info) = result {
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_info.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    /// 仅读取 `images.metadata` 列（详情区懒加载；列表分页不拉全量 JSON）。
    pub fn get_image_metadata(&self, image_id: &str) -> Result<Option<Value>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let meta: Option<String> = conn
            .query_row(
                "SELECT metadata FROM images WHERE id = ?1",
                params![image_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query metadata: {}", e))?;
        Ok(parse_image_metadata_json(meta))
    }

    pub fn find_image_by_path(&self, local_path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.mime_type,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at
                 FROM images
                 WHERE images.local_path = ?1",
                params![local_path],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        display_name: row.get(13)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(14)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 15)?,
                    })
                },
            )
            .ok();

        if let Some(ref mut image_info) = result {
            let image_id = image_info.id.clone();
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    /// 按缩略图路径查找：path 可为 thumbnail_path 或（当 thumbnail_path 为空时）local_path。
    /// 查询时规范化路径（统一斜杠），与写入时 canonicalize 后的形式兼容。
    pub fn find_image_by_thumbnail_path(&self, path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let path_norm = path.trim().replace('/', std::path::MAIN_SEPARATOR_STR);

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.mime_type,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at
                 FROM images
                 WHERE REPLACE(TRIM(COALESCE(images.thumbnail_path, '')), '/', ?2) = ?1
                    OR (TRIM(COALESCE(images.thumbnail_path, '')) = '' AND REPLACE(TRIM(images.local_path), '/', ?2) = ?1)",
                params![path_norm, std::path::MAIN_SEPARATOR_STR],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        display_name: row.get(13)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(14)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 15)?,
                    })
                },
            )
            .ok();

        if let Some(ref mut image_info) = result {
            let image_id = image_info.id.clone();
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    pub fn find_image_by_url(&self, url: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.mime_type,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at
                 FROM images
                 WHERE images.url = ?1",
                params![url],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        display_name: row.get(13)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(14)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 15)?,
                    })
                },
            )
            .ok();

        if let Some(ref mut image_info) = result {
            let image_id = image_info.id.clone();
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    pub fn find_image_by_hash(&self, hash: &str) -> Result<Option<ImageInfo>, String> {
        if hash.is_empty() {
            return Ok(None);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.mime_type,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at
                 FROM images
                 WHERE images.hash = ?1",
                params![hash],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        display_name: row.get(13)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(14)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 15)?,
                    })
                },
            )
            .ok();

        if let Some(ref mut image_info) = result {
            let image_id = image_info.id.clone();
            let is_favorite = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![FAVORITE_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.favorite = is_favorite;
        }

        Ok(result)
    }

    pub fn find_images_by_surf_record(
        &self,
        surf_record_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<RangedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE surf_record_id = ?1",
                params![surf_record_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query surf record image total: {}", e))?;

        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             images.mime_type,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.width,
             images.height,
             images.display_name,
             COALESCE(images.type, 'image') as media_type,
             images.last_set_wallpaper_at
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             WHERE images.surf_record_id = ?1
             ORDER BY images.crawled_at DESC
             LIMIT ?2 OFFSET ?3",
            FAVORITE_ALBUM_ID
        );
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let image_rows = stmt
            .query_map(
                params![surf_record_id, limit as i64, offset as i64],
                |row| {
                    let local_path: String = row.get(2)?;
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path: local_path.clone(),
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: row.get(5)?,
                        crawled_at: row.get(6)?,
                        metadata: parse_image_metadata_json(row.get::<_, Option<String>>(7)?),
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        mime_type: row.get::<_, Option<String>>(10)?,
                        favorite: row.get::<_, i64>(11)? != 0,
                        local_exists: PathBuf::from(&local_path).exists(),
                        width: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(13)?.map(|v| v as u32),
                        display_name: row.get(14)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(15)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 16)?,
                    })
                },
            )
            .map_err(|e| format!("Failed to query surf record images: {}", e))?;
        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(RangedImages {
            images,
            total,
            offset,
            limit,
        })
    }

    pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let metadata_json: Option<String> = match &image.metadata {
            None => None,
            Some(v) => Some(
                serde_json::to_string(v).map_err(|e| format!("Failed to serialize metadata: {}", e))?,
            ),
        };

        let thumbnail_path = if image.thumbnail_path.trim().is_empty() {
            image.local_path.clone()
        } else {
            image.thumbnail_path.clone()
        };

        // 如果 width/height 为空，尝试解析
        if image.width.is_none() || image.height.is_none() {
            if let Some((w, h)) = resolve_image_dimensions(&image.local_path) {
                image.width = Some(w);
                image.height = Some(h);
            }
        }

        let crawled_at_i64 = image.crawled_at as i64;
        conn.execute(
            "INSERT INTO images (url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata, thumbnail_path, hash, mime_type, type, width, height, display_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                &image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.surf_record_id,
                crawled_at_i64,
                metadata_json,
                thumbnail_path,
                image.hash,
                image.mime_type,
                image.media_type,
                image.width.map(|v| v as i64),
                image.height.map(|v| v as i64),
                image.display_name,
            ],
        )
        .map_err(|e| format!("Failed to add image: {}", e))?;

        let id = conn.last_insert_rowid();
        image.id = id.to_string();
        image.thumbnail_path = thumbnail_path;

        if let Some(ref tid) = image.task_id {
            if !tid.trim().is_empty() {
                let _ = conn.execute(
                    "UPDATE tasks SET success_count = success_count + 1 WHERE id = ?1",
                    params![tid],
                );
            }
        }

        self.invalidate_images_total_cache();

        Ok(image)
    }

    /// 批量补齐缺失的图片宽高数据（启动时调用）。
    /// 先收集 (id, path) 后释放锁，再在无锁状态下解析尺寸并逐条更新，避免 resolve_image_dimensions 内 panic 毒化 db 锁。
    pub fn fill_missing_dimensions(&self) -> Result<(), String> {
        let to_fill: Vec<(i64, String)> = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let mut stmt = conn
                .prepare("SELECT id, local_path FROM images WHERE width IS NULL OR height IS NULL")
                .map_err(|e| format!("Failed to prepare query: {}", e))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query images: {}", e))?;
            rows.filter_map(Result::ok).collect()
        };

        let mut updated_count = 0;
        let mut failed_count = 0;

        for (id, local_path) in to_fill {
            if let Some((w, h)) = resolve_image_dimensions(&local_path) {
                let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
                match conn.execute(
                    "UPDATE images SET width = ?1, height = ?2 WHERE id = ?3",
                    params![w as i64, h as i64, id],
                ) {
                    Ok(_) => updated_count += 1,
                    Err(e) => {
                        eprintln!("Failed to update dimensions for image {}: {}", id, e);
                        failed_count += 1;
                    }
                }
            } else {
                eprintln!(
                    "Failed to resolve dimensions for image {}: {}",
                    id, local_path
                );
                failed_count += 1;
            }
        }

        if updated_count > 0 {
            println!(
                "Filled dimensions for {} images ({} failed)",
                updated_count, failed_count
            );
        }

        Ok(())
    }

    /// 批量回填缺失的 MIME 类型（启动时调用）。
    /// 仅针对本地文件路径；content:// 等非文件路径跳过。
    pub fn backfill_missing_mime_types(&self) -> Result<(), String> {
        let to_fill: Vec<(i64, String)> = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, local_path FROM images
                     WHERE mime_type IS NULL
                       AND local_path IS NOT NULL
                       AND TRIM(local_path) != ''",
                )
                .map_err(|e| format!("Failed to prepare query: {}", e))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query images: {}", e))?;
            rows.filter_map(Result::ok).collect()
        };

        let mut updated_count = 0usize;
        for (id, local_path) in to_fill {
            if local_path.starts_with("content://") {
                continue;
            }
            let Some(mime) = crate::image_type::mime_type_from_path(Path::new(&local_path)) else {
                continue;
            };
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            conn.execute(
                "UPDATE images SET mime_type = ?1 WHERE id = ?2",
                params![mime, id],
            )
            .map_err(|e| format!("Failed to update mime_type: {}", e))?;
            updated_count += 1;
        }

        if updated_count > 0 {
            println!("Backfilled mime_type for {} images", updated_count);
        }
        Ok(())
    }

    /// 删除前查询图片所属任务 id（用于事件广播）
    pub fn get_task_ids_for_image(&self, image_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn
            .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
            .and_then(|mut stmt| {
                stmt.query_map(params![image_id], |row| row.get::<_, String>(0))
                    .and_then(|rows| {
                        let mut ids = Vec::new();
                        for row_result in rows {
                            if let Ok(id) = row_result {
                                ids.push(id);
                            }
                        }
                        Ok(ids)
                    })
            })
            .map_err(|e| format!("Failed to query task IDs: {}", e))
    }

    /// 批量图片在删除前涉及的任务 id（去重）
    pub fn collect_task_ids_for_images(&self, image_ids: &[String]) -> Result<Vec<String>, String> {
        let mut set = HashSet::new();
        for id in image_ids {
            for tid in self.get_task_ids_for_image(id)? {
                set.insert(tid);
            }
        }
        Ok(set.into_iter().collect())
    }

    /// 批量图片在删除/移除前涉及的畅游记录 id（去重），用于 `images-change` 事件。
    pub fn collect_surf_record_ids_for_images(
        &self,
        image_ids: &[String],
    ) -> Result<Vec<String>, String> {
        if image_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut set = HashSet::new();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT surf_record_id FROM images WHERE id = ?1 \
                 AND surf_record_id IS NOT NULL AND surf_record_id != ''",
            )
            .map_err(|e| format!("Failed to prepare surf_record_ids query: {}", e))?;
        for id in image_ids {
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query surf record IDs: {}", e))?;
            for row in rows {
                if let Ok(srid) = row {
                    set.insert(srid);
                }
            }
        }
        Ok(set.into_iter().collect())
    }

    pub fn delete_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let local_path: Option<String> = conn
            .query_row(
                "SELECT local_path FROM images WHERE id = ?1",
                params![image_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query image path: {}", e))?;

        // 在删除前，查询该图片所属的所有任务，并更新任务的 deleted_count
        let task_ids: Vec<String> = conn
            .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
            .and_then(|mut stmt| {
                stmt.query_map(params![image_id], |row| row.get::<_, String>(0))
                    .and_then(|rows| {
                        let mut ids = Vec::new();
                        for row_result in rows {
                            if let Ok(id) = row_result {
                                ids.push(id);
                            }
                        }
                        Ok(ids)
                    })
            })
            .map_err(|e| format!("Failed to query task IDs: {}", e))?;

        if let Some(path) = local_path {
            let _ = fs::remove_file(path);
        }

        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to delete image from DB: {}", e))?;

        let _ = conn.execute(
            "DELETE FROM album_images WHERE image_id = ?1",
            params![image_id],
        );

        // 更新所有相关任务的 deleted_count 与 success_count（当前存活图片数）
        for task_id in task_ids {
            let _ = conn.execute(
                "UPDATE tasks SET deleted_count = deleted_count + 1, success_count = MAX(0, success_count - 1) WHERE id = ?1",
                params![task_id],
            );
        }

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn remove_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 在删除前，查询该图片所属的所有任务，并更新任务的 deleted_count
        let task_ids: Vec<String> = conn
            .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
            .and_then(|mut stmt| {
                stmt.query_map(params![image_id], |row| row.get::<_, String>(0))
                    .and_then(|rows| {
                        let mut ids = Vec::new();
                        for row_result in rows {
                            if let Ok(id) = row_result {
                                ids.push(id);
                            }
                        }
                        Ok(ids)
                    })
            })
            .map_err(|e| format!("Failed to query task IDs: {}", e))?;

        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to remove image from DB: {}", e))?;

        let _ = conn.execute(
            "DELETE FROM album_images WHERE image_id = ?1",
            params![image_id],
        );

        // 更新所有相关任务的 deleted_count 与 success_count
        for task_id in task_ids {
            let _ = conn.execute(
                "UPDATE tasks SET deleted_count = deleted_count + 1, success_count = MAX(0, success_count - 1) WHERE id = ?1",
                params![task_id],
            );
        }

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn batch_delete_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 在删除前，查询所有图片所属的任务，并统计每个任务需要增加的 deleted_count
        let mut task_deleted_counts: HashMap<String, i64> = HashMap::new();
        for id in image_ids {
            let task_ids: Vec<String> = tx
                .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
                .and_then(|mut stmt| {
                    stmt.query_map(params![id], |row| row.get::<_, String>(0))
                        .and_then(|rows| {
                            let mut ids = Vec::new();
                            for row_result in rows {
                                if let Ok(task_id) = row_result {
                                    ids.push(task_id);
                                }
                            }
                            Ok(ids)
                        })
                })
                .unwrap_or_default();

            for task_id in task_ids {
                *task_deleted_counts.entry(task_id).or_insert(0) += 1;
            }
        }

        for id in image_ids {
            let local_path: Option<String> = tx
                .query_row(
                    "SELECT local_path FROM images WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query image path: {}", e))?;

            if let Some(path) = local_path {
                let _ = fs::remove_file(path);
            }

            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete image: {}", e))?;

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
        }

        // 更新所有相关任务的 deleted_count 与 success_count
        for (task_id, count) in task_deleted_counts {
            let _ = tx.execute(
                "UPDATE tasks SET deleted_count = deleted_count + ?1, success_count = MAX(0, success_count - ?2) WHERE id = ?3",
                params![count, count, task_id],
            );
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn batch_remove_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 在删除前，查询所有图片所属的任务，并统计每个任务需要增加的 deleted_count
        let mut task_deleted_counts: HashMap<String, i64> = HashMap::new();
        for id in image_ids {
            let task_ids: Vec<String> = tx
                .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
                .and_then(|mut stmt| {
                    stmt.query_map(params![id], |row| row.get::<_, String>(0))
                        .and_then(|rows| {
                            let mut ids = Vec::new();
                            for row_result in rows {
                                if let Ok(task_id) = row_result {
                                    ids.push(task_id);
                                }
                            }
                            Ok(ids)
                        })
                })
                .unwrap_or_default();

            for task_id in task_ids {
                *task_deleted_counts.entry(task_id).or_insert(0) += 1;
            }
        }

        for id in image_ids {
            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to remove image: {}", e))?;

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
        }

        // 更新所有相关任务的 deleted_count 与 success_count
        for (task_id, count) in task_deleted_counts {
            let _ = tx.execute(
                "UPDATE tasks SET deleted_count = deleted_count + ?1, success_count = MAX(0, success_count - ?2) WHERE id = ?3",
                params![count, count, task_id],
            );
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn get_total_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        self.get_images_total_cached(&conn)
    }

    pub fn toggle_image_favorite(&self, image_id: &str, favorite: bool) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        if favorite {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, image_id, SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64],
            );
        } else {
            let _ = conn.execute(
                "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                params![FAVORITE_ALBUM_ID, image_id],
            );
        }

        Ok(())
    }

    pub fn update_image_dimensions(
        &self,
        image_id: &str,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET width = ?1, height = ?2 WHERE id = ?3",
            params![width as i64, height as i64, image_id],
        )
        .map_err(|e| format!("Failed to update dimensions: {}", e))?;
        Ok(())
    }

    pub fn update_image_thumbnail_path(
        &self,
        image_id: &str,
        thumbnail_path: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET thumbnail_path = ?1 WHERE id = ?2",
            params![thumbnail_path, image_id],
        )
        .map_err(|e| format!("Failed to update thumbnail path: {}", e))?;
        Ok(())
    }

    pub fn update_image_last_set_wallpaper_at(&self, image_id: &str, ts: u64) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET last_set_wallpaper_at = ?1 WHERE id = ?2",
            params![ts as i64, image_id],
        )
        .map_err(|e| format!("Failed to update last_set_wallpaper_at: {}", e))?;
        Ok(())
    }

    pub fn pick_existing_gallery_image_id(&self, mode: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = match mode {
            "random" => "SELECT CAST(id AS TEXT) FROM images ORDER BY RANDOM() LIMIT 1",
            _ => "SELECT CAST(id AS TEXT) FROM images ORDER BY crawled_at ASC LIMIT 1",
        };

        let id: Option<String> = conn
            .query_row(sql, [], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Failed to pick image: {}", e))?;

        Ok(id)
    }
}
