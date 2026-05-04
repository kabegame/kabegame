use crate::storage::{default_true, Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
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
    /// 外键指向 `image_metadata.id`；下载入口已将 raw metadata 预先归一化为该 id。
    #[serde(rename = "metadataId")]
    #[serde(default)]
    pub metadata_id: Option<i64>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    pub favorite: bool,
    /// 是否在隐藏画册（HIDDEN_ALBUM_ID）中。前端根据此值决定上下文菜单显示"隐藏"或"取消隐藏"。
    /// VD 据此给虚拟图片文件叠加 OS hidden 属性。衍生自统一 LEFT JOIN，不是 images 表列。
    #[serde(rename = "isHidden")]
    #[serde(default)]
    pub is_hidden: bool,
    /// 本地文件是否存在（用于前端标记缺失文件：仍展示条目，但提示用户源文件已丢失/移动）
    #[serde(default = "default_true")]
    pub local_exists: bool,
    #[serde(default)]
    pub hash: String,
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
    /// 图片磁盘大小（字节）；旧数据或无法获取时为 None。
    #[serde(default)]
    pub size: Option<u64>,
    /// 仅在画册路径 (`/gallery/album/<id>/...`) 下被填: 该图片在 album_images 表中的 `order` 列。
    /// 顺序壁纸轮播 (sequential mode) 用它定位 next 图片 (`bigger_order` 路径)。
    /// 非画册路径的查询里恒为 None。
    #[serde(rename = "albumOrder")]
    #[serde(default)]
    pub album_order: Option<i64>,
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

#[cfg(not(target_os = "android"))]
fn remove_thumbnail_file_if_needed(local_path: Option<&str>, thumbnail_path: Option<&str>) {
    let Some(thumb) = thumbnail_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    if let Some(local) = local_path.map(str::trim).filter(|p| !p.is_empty()) {
        if local == thumb {
            return;
        }
    }
    let _ = fs::remove_file(thumb);
}

#[cfg(target_os = "android")]
fn remove_thumbnail_file_if_needed(_local_path: Option<&str>, _thumbnail_path: Option<&str>) {}

// v4.0 删除说明：resolve_file_size_for_backfill（含 Android / 桌面两个 cfg 版本）
// 仅被 fill_missing_sizes 使用，随之一并删除。

fn normalize_media_type(media_type: Option<String>) -> Option<String> {
    crate::image_type::normalize_stored_media_type(media_type)
}

/// 从 DB `image_metadata.data` 文本列解析为 JSON；空串或无效则 `None`。
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

pub(crate) fn metadata_content_hash_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for &b in digest.as_slice() {
        s.push(char::from(HEX[(b >> 4) as usize]));
        s.push(char::from(HEX[(b & 0xf) as usize]));
    }
    s
}

/// 将 JSON 文本写入 `image_metadata`（按 content_hash 去重）并返回行 id。
pub(crate) fn insert_or_get_image_metadata_id(
    conn: &rusqlite::Connection,
    data_json: &str,
) -> Result<i64, String> {
    let hash = metadata_content_hash_hex(data_json.as_bytes());
    conn.execute(
        "INSERT OR IGNORE INTO image_metadata (data, content_hash) VALUES (?1, ?2)",
        params![data_json, hash],
    )
    .map_err(|e| format!("insert image_metadata: {}", e))?;
    conn.query_row(
        "SELECT id FROM image_metadata WHERE content_hash = ?1",
        params![hash],
        |r| r.get(0),
    )
    .map_err(|e| format!("select image_metadata id: {}", e))
}

// v4.0 删除说明：以下内容已随 perform_complex_migrations 的移除一并删除。
//   - PIXIV_METADATA_BODY_KEYS、trim_pixiv_metadata_body、
//     trim_pixiv_plugin_metadata_if_needed、migrate_pixiv_metadata_trim
// 这些函数用于一次性裁剪旧版 pixiv 图片的 metadata.body 字段，
// 仅针对早于 3.5.x 的历史数据库，v4.0 不再支持从那些版本直接升级。

pub(crate) fn row_optional_u64_ts(
    row: &rusqlite::Row,
    idx: usize,
) -> rusqlite::Result<Option<u64>> {
    let v: Option<i64> = row.get(idx)?;
    Ok(v.filter(|&t| t >= 0).map(|t| t as u64))
}

impl Storage {
    pub fn find_image_by_id(&self, image_id: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata_id,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at,
                 images.size
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
                        metadata_id: row.get::<_, Option<i64>>(7)?,
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        favorite: false,
                        is_hidden: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(13)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 14)?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                        album_order: None,
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
            let is_hidden = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![HIDDEN_ALBUM_ID, image_info.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            image_info.is_hidden = is_hidden;
        }

        Ok(result)
    }

    /// 读取 `image_metadata.data`。
    pub fn get_image_metadata(&self, image_id: &str) -> Result<Option<Value>, String> {
        crate::providers::image_metadata_at(image_id)
    }

    /// 按 `image_metadata.id` 直接取 JSON（前端按 metadataId 缓存时命中）。
    pub fn get_image_metadata_by_metadata_id(
        &self,
        metadata_id: i64,
    ) -> Result<Option<Value>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let meta: Option<String> = conn
            .query_row(
                "SELECT data FROM image_metadata WHERE id = ?1",
                params![metadata_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query image_metadata: {}", e))?;
        Ok(parse_image_metadata_json(meta))
    }

    /// Rhai `create_image_metadata`：将 JSON 写入 `image_metadata` 并返回 id。
    pub fn insert_or_get_image_metadata_row(&self, value: &Value) -> Result<i64, String> {
        let s = serde_json::to_string(value)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        insert_or_get_image_metadata_id(&conn, &s)
    }

    pub fn gc_image_metadata(&self, candidate_ids: &[i64]) -> Result<usize, String> {
        if candidate_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut deleted = 0usize;
        let mut seen = HashSet::new();
        for &id in candidate_ids {
            if !seen.insert(id) {
                continue;
            }
            let used: i64 = conn
                .query_row(
                    "SELECT
                        (SELECT COUNT(1) FROM images WHERE metadata_id = ?1)
                      + (SELECT COUNT(1) FROM task_failed_images WHERE metadata_id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("gc_image_metadata count: {}", e))?;
            if used == 0 {
                conn.execute("DELETE FROM image_metadata WHERE id = ?1", params![id])
                    .map_err(|e| format!("gc_image_metadata delete: {}", e))?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    pub fn find_image_by_path(&self, local_path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata_id,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at,
                 images.size
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
                        metadata_id: row.get::<_, Option<i64>>(7)?,
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        favorite: false,
                        is_hidden: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(13)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 14)?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                        album_order: None,
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
            let is_hidden = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![HIDDEN_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.is_hidden = is_hidden;
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
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata_id,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at,
                 images.size
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
                        metadata_id: row.get::<_, Option<i64>>(7)?,
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        favorite: false,
                        is_hidden: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(13)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 14)?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                        album_order: None,
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
            let is_hidden = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![HIDDEN_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.is_hidden = is_hidden;
        }

        Ok(result)
    }

    pub fn find_image_by_url(&self, url: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata_id,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at,
                 images.size
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
                        metadata_id: row.get::<_, Option<i64>>(7)?,
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        favorite: false,
                        is_hidden: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(13)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 14)?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                        album_order: None,
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
            let is_hidden = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![HIDDEN_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.is_hidden = is_hidden;
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
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.surf_record_id, images.crawled_at, images.metadata_id,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.width,
                 images.height,
                 images.display_name,
                 COALESCE(images.type, 'image') as media_type,
                 images.last_set_wallpaper_at,
                 images.size
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
                        metadata_id: row.get::<_, Option<i64>>(7)?,
                        thumbnail_path: row.get(8)?,
                        hash: row.get(9)?,
                        favorite: false,
                        is_hidden: false,
                        local_exists,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: normalize_media_type(row.get::<_, Option<String>>(13)?),
                        last_set_wallpaper_at: row_optional_u64_ts(row, 14)?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                        album_order: None,
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
            let is_hidden = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![HIDDEN_ALBUM_ID, image_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .unwrap_or(false);
            image_info.is_hidden = is_hidden;
        }

        Ok(result)
    }

    pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        image.media_type = crate::image_type::normalize_stored_media_type(image.media_type.take());

        let thumbnail_path = if image.thumbnail_path.trim().is_empty() {
            image.local_path.clone()
        } else {
            image.thumbnail_path.clone()
        };

        let crawled_at_i64 = image.crawled_at as i64;
        conn.execute(
            "INSERT INTO images (url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id, thumbnail_path, hash, type, width, height, display_name, size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                &image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.surf_record_id,
                crawled_at_i64,
                image.metadata_id,
                thumbnail_path,
                image.hash,
                image.media_type,
                image.width.map(|v| v as i64),
                image.height.map(|v| v as i64),
                image.display_name,
                image.size.map(|v| v as i64),
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

    // v4.0 删除说明：fill_missing_dimensions 和 fill_missing_sizes 均为启动时回填旧数据的
    // 一次性迁移逻辑（width/height/size 列早期为 NULL），v4.0 新库建表即含这些列，
    // 3.5.x 用户的存量数据已由之前版本补齐，不再需要启动时扫描回填。

    /// 删除前查询图片所属任务 id（用于事件广播）
    pub fn get_task_id_for_image(&self, image_id: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL",
            params![image_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query task IDs: {}", e))
    }

    /// 批量图片在删除前涉及的任务 id（去重）
    pub fn collect_task_ids_for_images(&self, image_ids: &[String]) -> Result<Vec<String>, String> {
        let mut set = HashSet::new();
        for id in image_ids {
            if let Some(tid) = self.get_task_id_for_image(id)? {
                set.insert(tid);
            }
        }
        Ok(set.into_iter().collect())
    }

    /// 批量图片涉及的插件 id（去重）。
    pub fn collect_plugin_ids_for_images(
        &self,
        image_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let mut set = HashSet::new();
        for id in image_ids {
            if let Some(image) = self.find_image_by_id(id)? {
                if !image.plugin_id.trim().is_empty() {
                    set.insert(image.plugin_id);
                }
            }
        }
        Ok(set.into_iter().collect())
    }

    /// 批量图片在删除前按畅游记录 id 统计张数（用于 `deleted_count` 与 `images-change`）。
    pub fn collect_surf_record_counts_for_images(
        &self,
        image_ids: &[String],
    ) -> Result<HashMap<String, usize>, String> {
        if image_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut map = HashMap::new();
        let mut stmt = conn
            .prepare(
                "SELECT surf_record_id FROM images WHERE id = ?1 \
                 AND surf_record_id IS NOT NULL AND surf_record_id != ''",
            )
            .map_err(|e| format!("Failed to prepare surf_record_ids query: {}", e))?;
        for id in image_ids {
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query surf record IDs: {}", e))?;
            for row in rows {
                if let Ok(srid) = row {
                    *map.entry(srid).or_insert(0) += 1;
                }
            }
        }
        Ok(map)
    }

    /// 批量图片在删除/移除前涉及的畅游记录 id（去重），用于 `images-change` 事件。
    pub fn collect_surf_record_ids_for_images(
        &self,
        image_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let m = self.collect_surf_record_counts_for_images(image_ids)?;
        Ok(m.into_keys().collect())
    }

    pub fn delete_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let image_paths: Option<(String, String, Option<i64>)> = conn
            .query_row(
                "SELECT local_path, thumbnail_path, metadata_id FROM images WHERE id = ?1",
                params![image_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("Failed to query image path: {}", e))?;
        let metadata_id = image_paths.as_ref().and_then(|(_, _, id)| *id);

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

        if let Some((local_path, thumbnail_path, _)) = image_paths {
            remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
            let _ = fs::remove_file(local_path);
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
        drop(conn);
        if let Some(metadata_id) = metadata_id {
            let _ = self.gc_image_metadata(&[metadata_id]);
        }

        Ok(())
    }

    pub fn remove_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let image_paths: Option<(String, String, Option<i64>)> = conn
            .query_row(
                "SELECT local_path, thumbnail_path, metadata_id FROM images WHERE id = ?1",
                params![image_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("Failed to query image path: {}", e))?;
        let metadata_id = image_paths.as_ref().and_then(|(_, _, id)| *id);

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

        if let Some((local_path, thumbnail_path, _)) = image_paths {
            remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
        }

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
        drop(conn);
        if let Some(metadata_id) = metadata_id {
            let _ = self.gc_image_metadata(&[metadata_id]);
        }

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
        let mut metadata_ids = Vec::new();

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
            let image_paths: Option<(String, String, Option<i64>)> = tx
                .query_row(
                    "SELECT local_path, thumbnail_path, metadata_id FROM images WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to query image path: {}", e))?;

            if let Some((local_path, thumbnail_path, metadata_id)) = image_paths {
                if let Some(metadata_id) = metadata_id {
                    metadata_ids.push(metadata_id);
                }
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
                let _ = fs::remove_file(local_path);
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
        drop(conn);
        let _ = self.gc_image_metadata(&metadata_ids);

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
        let mut metadata_ids = Vec::new();

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
            let image_paths: Option<(String, String, Option<i64>)> = tx
                .query_row(
                    "SELECT local_path, thumbnail_path, metadata_id FROM images WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to query image path: {}", e))?;

            if let Some((local_path, thumbnail_path, metadata_id)) = image_paths {
                if let Some(metadata_id) = metadata_id {
                    metadata_ids.push(metadata_id);
                }
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
            }

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
        drop(conn);
        let _ = self.gc_image_metadata(&metadata_ids);

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

    pub fn update_image_last_set_wallpaper_at(
        &self,
        image_id: &str,
        ts: u64,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET last_set_wallpaper_at = ?1 WHERE id = ?2",
            params![ts as i64, image_id],
        )
        .map_err(|e| format!("Failed to update last_set_wallpaper_at: {}", e))?;
        Ok(())
    }

    pub fn update_image_display_name(
        &self,
        image_id: &str,
        display_name: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET display_name = ?1 WHERE id = ?2",
            params![display_name, image_id],
        )
        .map_err(|e| format!("Failed to update display_name: {}", e))?;
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

    /// Returns the set of paths (from the input slice) that are still referenced
    /// by at least one row in the images table.
    pub fn paths_still_referenced(&self, paths: &[&str]) -> Result<HashSet<String>, String> {
        if paths.is_empty() {
            return Ok(HashSet::new());
        }
        const CHUNK: usize = 500;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut out = HashSet::new();
        for chunk in paths.chunks(CHUNK) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT local_path FROM images WHERE local_path IN ({placeholders})");
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("Failed to prepare paths_still_referenced: {}", e))?;
            let mut rows = stmt
                .query(params_from_iter(chunk.iter().copied()))
                .map_err(|e| format!("Failed to query paths_still_referenced: {}", e))?;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("Failed to read paths_still_referenced row: {}", e))?
            {
                let p: String = row
                    .get(0)
                    .map_err(|e| format!("Failed to get local_path: {}", e))?;
                out.insert(p);
            }
        }
        Ok(out)
    }
}
