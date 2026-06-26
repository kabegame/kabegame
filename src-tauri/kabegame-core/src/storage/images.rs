use crate::storage::{default_true, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
// `fs` 仅用于桌面/iOS 的缩略图删除（remove_thumbnail_file_if_needed）；Android 无此用法。
#[cfg(not(target_os = "android"))]
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ImageInfo {
    #[serde(deserialize_with = "deserialize_stringish")]
    pub id: String,
    /// 图片源 URL，本地导入时可为空。
    pub url: Option<String>,
    pub local_path: String,
    #[serde(rename(serialize = "pluginId"), alias = "pluginId")]
    pub plugin_id: String,
    #[serde(rename(serialize = "taskId"), alias = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename(serialize = "surfRecordId"), alias = "surfRecordId")]
    #[serde(default)]
    pub surf_record_id: Option<String>,
    pub crawled_at: u64,
    /// 外键指向 `image_metadata.id`；下载入口已将 raw metadata 预先归一化为该 id。
    #[serde(rename(serialize = "metadataId"), alias = "metadataId")]
    #[serde(default)]
    pub metadata_id: Option<i64>,
    /// `image_metadata.version`；用于前端 metadata 缓存失效。
    #[serde(rename(serialize = "metadataVersion"), alias = "metadataVersion")]
    #[serde(default)]
    pub metadata_version: u32,
    #[serde(rename(serialize = "thumbnailPath"), alias = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    #[serde(
        default,
        alias = "is_favorite",
        deserialize_with = "deserialize_boolish"
    )]
    pub favorite: bool,
    /// 是否在隐藏画册（HIDDEN_ALBUM_ID）中。前端根据此值决定上下文菜单显示"隐藏"或"取消隐藏"。
    /// VD 据此给虚拟图片文件叠加 OS hidden 属性。衍生自统一 LEFT JOIN，不是 images 表列。
    #[serde(
        rename(serialize = "isHidden"),
        alias = "isHidden",
        default,
        deserialize_with = "deserialize_boolish"
    )]
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
    #[serde(rename(serialize = "displayName"), alias = "displayName")]
    #[serde(default)]
    pub display_name: String,
    #[serde(rename = "type", alias = "media_type")]
    #[serde(default)]
    pub media_type: Option<String>,
    /// 最后一次被设为壁纸的 Unix 时间戳（秒）；从未设为壁纸则为 None。
    #[serde(rename(serialize = "lastSetWallpaperAt"), alias = "lastSetWallpaperAt")]
    #[serde(default)]
    pub last_set_wallpaper_at: Option<u64>,
    /// 图片磁盘大小（字节）；旧数据或无法获取时为 None。
    #[serde(default)]
    pub size: Option<u64>,
    /// 仅在画册路径 (`/gallery/album/<id>/...`) 下被填: 该图片在 album_images 表中的 `order` 列。
    /// 顺序壁纸轮播 (sequential mode) 用它定位 next 图片 (`bigger_order` 路径)。
    /// 非画册路径的查询里恒为 None。
    #[serde(rename(serialize = "albumOrder"), alias = "albumOrder")]
    #[serde(default)]
    pub album_order: Option<i64>,
    /// 浏览器兼容副本路径（可空）。原始媒体为浏览器不可播放的格式时由下载/导入/Organize 生成。
    /// 图片转 PNG（含超大图下采样）；视频转 H.264 mp4（含 AAC 音频）。
    #[serde(
        rename(serialize = "compatiblePath"),
        alias = "compatiblePath",
        default
    )]
    pub compatible_path: Option<String>,
}

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Bool(v) => Ok(v),
        serde_json::Value::Number(n) => Ok(n.as_i64().unwrap_or(0) != 0),
        serde_json::Value::String(s) => Ok(matches!(s.as_str(), "1" | "true" | "TRUE" | "True")),
        serde_json::Value::Null => Ok(false),
        other => Err(serde::de::Error::custom(format!(
            "cannot deserialize bool from {other}"
        ))),
    }
}

fn deserialize_stringish<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "cannot deserialize string from {other}"
        ))),
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadataFull {
    pub id: i64,
    pub data: Option<Value>,
    pub version: u32,
    pub plugin_id: String,
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

/// 将 JSON 文本写入 `image_metadata` 并返回新插入的行 id。
pub(crate) fn insert_image_metadata_id(
    conn: &rusqlite::Connection,
    data_json: &str,
    plugin_id: &str,
    version: u32,
) -> Result<i64, String> {
    let version_i64 = i64::from(version);

    conn.execute(
        "INSERT INTO image_metadata (data, plugin_id, version)
         VALUES (?1, ?2, ?3)",
        params![data_json, plugin_id, version_i64],
    )
    .map_err(|e| format!("insert image_metadata: {}", e))?;

    Ok(conn.last_insert_rowid())
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

fn first_gallery_image_at(path: &str) -> Result<Option<ImageInfo>, String> {
    let mut image = crate::providers::images_at(path)?.into_iter().next();
    if let Some(ref mut image) = image {
        image.local_exists = PathBuf::from(&image.local_path).exists();
    }
    Ok(image)
}

fn encode_provider_segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

impl Storage {
    pub fn find_image_by_id(image_id: &str) -> Result<Option<ImageInfo>, String> {
        if image_id.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_id/{}",
            encode_provider_segment(image_id)
        ))
    }

    /// 读取 `image_metadata.data`。
    pub fn get_image_metadata(&self, image_id: &str) -> Result<Option<Value>, String> {
        crate::providers::image_metadata_at(image_id)
    }

    /// 读取 metadata 的完整行信息（含 version/plugin_id）。
    pub fn get_image_metadata_full(
        &self,
        image_id: &str,
    ) -> Result<Option<ImageMetadataFull>, String> {
        crate::providers::image_metadata_full_at(image_id)
    }

    /// Rhai `create_image_metadata`：将 JSON 写入 `image_metadata` 并返回 id。
    pub fn insert_image_metadata_row(
        &self,
        value: &Value,
        plugin_id: &str,
        version: u32,
    ) -> Result<i64, String> {
        let s = serde_json::to_string(value)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        insert_image_metadata_id(&conn, &s, plugin_id, version)
    }

    /// 读取某 metadata 行的原始 `data` 文本（用于文件夹同步重导入前「保存」内容）。
    pub fn read_image_metadata_text(&self, metadata_id: i64) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT data FROM image_metadata WHERE id = ?1",
            params![metadata_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("read_image_metadata_text: {}", e))
    }

    /// 按原始 JSON 文本写入 metadata 行并返回 id。
    /// 文件夹同步重导入用：删旧行后重写——若内容仍在则拿回原 id，若已被 GC 则得新 id。
    pub fn insert_image_metadata_text(&self, data_json: &str) -> Result<i64, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        insert_image_metadata_id(&conn, data_json, "", 0)
    }

    /// 扫描某插件低于目标版本的 metadata 行，供迁移运行器逐行升级。
    pub fn metadata_rows_below_version(
        &self,
        plugin_id: &str,
        max_version: u32,
    ) -> Result<Vec<(i64, String, u32)>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, data, version
                 FROM image_metadata
                 WHERE plugin_id = ?1 AND version < ?2
                 ORDER BY id",
            )
            .map_err(|e| format!("prepare metadata_rows_below_version: {e}"))?;
        let rows = stmt
            .query_map(params![plugin_id, i64::from(max_version)], |row| {
                let version: i64 = row.get(2)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    version.max(0) as u32,
                ))
            })
            .map_err(|e| format!("query metadata_rows_below_version: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect metadata_rows_below_version: {e}"))
    }

    /// 写回迁移后的 metadata 行；如命中已有复合键，则重定向引用并删除当前行。
    pub fn writeback_migrated_metadata_row(
        &self,
        row_id: i64,
        plugin_id: &str,
        new_version: u32,
        new_data: &str,
    ) -> Result<bool, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin writeback_migrated_metadata_row: {e}"))?;

        let current: Option<(String, i64)> = tx
            .query_row(
                "SELECT data, version
                 FROM image_metadata
                 WHERE id = ?1 AND plugin_id = ?2",
                params![row_id, plugin_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| format!("select metadata row for writeback: {e}"))?;
        let Some((current_data, current_version)) = current else {
            tx.commit()
                .map_err(|e| format!("commit metadata writeback no-op: {e}"))?;
            return Ok(false);
        };

        let new_version_i64 = i64::from(new_version);
        if current_data == new_data && current_version == new_version_i64 {
            tx.commit()
                .map_err(|e| format!("commit metadata writeback unchanged: {e}"))?;
            return Ok(false);
        }

        let target_id: Option<i64> = tx
            .query_row(
                "SELECT id
                 FROM image_metadata
                 WHERE plugin_id = ?1 AND version = ?2 AND data = ?3 AND id <> ?4
                 LIMIT 1",
                params![plugin_id, new_version_i64, new_data, row_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("select metadata merge target: {e}"))?;

        if let Some(target_id) = target_id {
            tx.execute(
                "UPDATE images SET metadata_id = ?1 WHERE metadata_id = ?2",
                params![target_id, row_id],
            )
            .map_err(|e| format!("repoint images.metadata_id: {e}"))?;
            tx.execute(
                "UPDATE task_failed_images SET metadata_id = ?1 WHERE metadata_id = ?2",
                params![target_id, row_id],
            )
            .map_err(|e| format!("repoint task_failed_images.metadata_id: {e}"))?;
            tx.execute("DELETE FROM image_metadata WHERE id = ?1", params![row_id])
                .map_err(|e| format!("delete merged image_metadata row: {e}"))?;
        } else {
            tx.execute(
                "UPDATE image_metadata
                 SET data = ?1, version = ?2
                 WHERE id = ?3",
                params![new_data, new_version_i64, row_id],
            )
            .map_err(|e| format!("update migrated image_metadata row: {e}"))?;
        }

        tx.commit()
            .map_err(|e| format!("commit metadata writeback: {e}"))?;
        Ok(true)
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

    pub fn find_image_by_path(local_path: &str) -> Result<Option<ImageInfo>, String> {
        if local_path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_path/{}",
            encode_provider_segment(local_path)
        ))
    }

    pub fn find_image_by_compatible_path(path: &str) -> Result<Option<ImageInfo>, String> {
        if path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_compatible_path/{}",
            encode_provider_segment(path)
        ))
    }

    /// 按缩略图路径查找：path 可为 thumbnail_path 或（当 thumbnail_path 为空时）local_path。
    /// 查询时规范化路径（统一斜杠），与写入时 canonicalize 后的形式兼容。
    pub fn find_image_by_thumbnail_path(path: &str) -> Result<Option<ImageInfo>, String> {
        let path = path.trim();
        if path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_thumbnail_path/{}",
            encode_provider_segment(path)
        ))
    }

    pub fn find_image_by_url(url: &str) -> Result<Option<ImageInfo>, String> {
        if url.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_url/{}",
            encode_provider_segment(url)
        ))
    }

    pub fn find_image_by_hash(hash: &str) -> Result<Option<ImageInfo>, String> {
        if hash.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_hash/{}",
            encode_provider_segment(hash)
        ))
    }

    /// 为本地文件夹同步查询某 album 当前的图片 id 快照（作为「待删除候选」基线）。
    pub fn list_album_image_ids_for_sync(&self, album_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT i.id
                 FROM images i
                 INNER JOIN album_images ai ON ai.image_id = i.id
                 WHERE ai.album_id = ?1",
            )
            .map_err(|e| format!("prepare list_album_image_ids_for_sync: {e}"))?;
        let rows = stmt
            .query_map(params![album_id], |row| {
                Ok(row.get::<_, i64>(0)?.to_string())
            })
            .map_err(|e| format!("query list_album_image_ids_for_sync: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_album_image_ids_for_sync: {e}"))
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
            "INSERT INTO images (url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id, thumbnail_path, hash, type, width, height, display_name, size, compatible_path)
             VALUES (?1, ?2, ?3, (SELECT id FROM tasks WHERE id = ?4), ?5, ?6, (SELECT id FROM image_metadata WHERE id = ?7), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                image.compatible_path,
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
            if let Some(image) = Self::find_image_by_id(id)? {
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
            // 原始文件移入系统回收站（桌面，带护栏，绝不永久删除）；失败/不安全则保留磁盘文件。
            // Android 的 content:// 删除走内容提供方，这里不处理。
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                crate::storage::safe_delete::trash_source_file(std::path::Path::new(&local_path));
            }
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

        // 收集所有需要删除的原始文件路径，事后批量扔回收站。
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let mut local_paths_to_trash: Vec<String> = Vec::new();

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
                // Android 的 content:// 删除走内容提供方，这里不处理。
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                local_paths_to_trash.push(local_path);
            }

            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete image: {}", e))?;

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
        }

        // 原始文件一次性批量移入系统回收站（带软链接/异构盘护栏，绝不永久删除）；
        // 失败或路径不安全时保留磁盘文件，数据库记录已删除。
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let paths: Vec<std::path::PathBuf> = local_paths_to_trash
                .iter()
                .map(|s| std::path::PathBuf::from(s))
                .collect();
            let path_refs: Vec<&std::path::Path> = paths.iter().map(|p| p.as_path()).collect();
            crate::storage::safe_delete::trash_source_files_batch(&path_refs);
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

    pub fn replace_image_thumbnail_path(
        &self,
        image_id: &str,
        thumbnail_path: &str,
    ) -> Result<(), String> {
        let old_paths = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let old_paths = conn
                .query_row(
                    "SELECT local_path, thumbnail_path FROM images WHERE id = ?1",
                    params![image_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to query existing thumbnail path: {}", e))?;
            conn.execute(
                "UPDATE images SET thumbnail_path = ?1 WHERE id = ?2",
                params![thumbnail_path, image_id],
            )
            .map_err(|e| format!("Failed to update thumbnail path: {}", e))?;
            old_paths
        };

        if let Some((local_path, old_thumbnail_path)) = old_paths {
            if old_thumbnail_path.trim() != thumbnail_path.trim() {
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&old_thumbnail_path));
            }
        }

        Ok(())
    }

    /// 将图片的 `compatible_path` 更新为新路径（不删除旧文件，由调用方负责）。
    pub fn replace_image_compatible_path(
        &self,
        image_id: &str,
        compatible_path: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET compatible_path = ?1 WHERE id = ?2",
            params![compatible_path, image_id],
        )
        .map_err(|e| format!("Failed to update compatible_path: {}", e))?;
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
}
