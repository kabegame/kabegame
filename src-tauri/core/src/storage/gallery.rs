//! 画廊相关查询（用于虚拟磁盘的 Gallery Provider）

use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

use crate::storage::gallery_time::{gallery_month_groups_from_days, GalleryTimeFilterPayload};
use crate::storage::Storage;


/// 插件分组信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginGroup {
    pub plugin_id: String,
    pub count: usize,
}

/// 按媒体类型（图片 / 视频）的数量（`video` 或 `video/*` 计入视频，其余含空值计入图片）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryMediaTypeCounts {
    pub image_count: usize,
    pub video_count: usize,
}

/// 日期分组信息（年-月）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateGroup {
    pub year_month: String, // 格式: "2024-01"
    pub count: usize,
}

/// 日期分组信息（年-月-日）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayGroup {
    pub ymd: String, // 格式: "2024-01-15"
    pub count: usize,
}

/// 画廊图片条目
#[derive(Debug, Clone)]
pub struct GalleryImageFsEntry {
    pub file_name: String,
    pub image_id: String,
    pub resolved_path: String,
    /// 画廊排序时间戳：`images.crawled_at`
    pub gallery_ts: u64,
}

impl Storage {
    /// 批量获取图片的“画廊排序时间戳”（用于虚拟盘/画廊一致的时间显示）。
    ///
    /// 返回 map：`image_id -> ts`，其中 `ts = images.crawled_at`。
    pub fn get_images_gallery_ts_by_ids(
        &self,
        image_ids: &[String],
    ) -> Result<HashMap<String, u64>, String> {
        let mut out: HashMap<String, u64> = HashMap::new();
        if image_ids.is_empty() {
            return Ok(out);
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // IN (?, ?, ...) 动态占位符
        let placeholders = std::iter::repeat("?")
            .take(image_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.crawled_at as ts
             FROM images
             WHERE images.id IN ({})",
            placeholders
        );

        let params: Vec<&dyn ToSql> = image_ids.iter().map(|s| s as &dyn ToSql).collect();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(params_from_iter(params.iter().copied()), |row| {
                let id: String = row.get(0)?;
                let ts: i64 = row.get(1)?;
                Ok((id, ts))
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        for r in rows {
            let (id, ts) = r.map_err(|e| format!("Failed to read row: {}", e))?;
            if ts >= 0 {
                out.insert(id, ts as u64);
            }
        }

        Ok(out)
    }

    /// 获取所有插件分组及其图片数量
    pub fn get_gallery_plugin_groups(&self) -> Result<Vec<PluginGroup>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT plugin_id, COUNT(*) as cnt
                 FROM images
                 WHERE plugin_id IS NOT NULL AND plugin_id != ''
                 GROUP BY plugin_id
                 ORDER BY plugin_id ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(PluginGroup {
                    plugin_id: row.get(0)?,
                    count: row.get::<_, i64>(1)? as usize,
                })
            })
            .map_err(|e| format!("Failed to query plugin groups: {}", e))?;

        let mut groups = Vec::new();
        for r in rows {
            groups.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(groups)
    }

    /// 画廊全局：按 `images.type` 统计图片与视频条数
    pub fn get_gallery_media_type_counts(&self) -> Result<GalleryMediaTypeCounts, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let (video_count, image_count): (i64, i64) = conn
            .query_row(
                "SELECT
                    SUM(CASE WHEN LOWER(COALESCE(type, '')) = 'video'
                              OR LOWER(COALESCE(type, '')) LIKE 'video/%' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN NOT (LOWER(COALESCE(type, '')) = 'video'
                              OR LOWER(COALESCE(type, '')) LIKE 'video/%') THEN 1 ELSE 0 END)
                 FROM images",
                [],
                |row| Ok((row.get::<_, Option<i64>>(0)?.unwrap_or(0), row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
            )
            .map_err(|e| format!("Failed to query media type counts: {}", e))?;
        Ok(GalleryMediaTypeCounts {
            image_count: image_count as usize,
            video_count: video_count as usize,
        })
    }

    /// 指定画册内：按媒体类型统计条数
    pub fn get_album_media_type_counts(
        &self,
        album_id: &str,
    ) -> Result<GalleryMediaTypeCounts, String> {
        let id = album_id.trim();
        if id.is_empty() {
            return Ok(GalleryMediaTypeCounts {
                image_count: 0,
                video_count: 0,
            });
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let (video_count, image_count): (i64, i64) = conn
            .query_row(
                "SELECT
                    SUM(CASE WHEN LOWER(COALESCE(images.type, '')) = 'video'
                              OR LOWER(COALESCE(images.type, '')) LIKE 'video/%' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN NOT (LOWER(COALESCE(images.type, '')) = 'video'
                              OR LOWER(COALESCE(images.type, '')) LIKE 'video/%') THEN 1 ELSE 0 END)
                 FROM images
                 INNER JOIN album_images ai ON images.id = ai.image_id
                 WHERE ai.album_id = ?",
                [id],
                |row| Ok((row.get::<_, Option<i64>>(0)?.unwrap_or(0), row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
            )
            .map_err(|e| format!("Failed to query album media type counts: {}", e))?;
        Ok(GalleryMediaTypeCounts {
            image_count: image_count as usize,
            video_count: video_count as usize,
        })
    }

    /// 获取所有日期分组（年-月）及其图片数量（由日粒度聚合派生，见 `gallery_time`）。
    pub fn get_gallery_date_groups(&self) -> Result<Vec<DateGroup>, String> {
        let days = self.get_gallery_day_groups()?;
        Ok(gallery_month_groups_from_days(&days))
    }

    /// 画廊时间过滤：一次返回月（派生）+ 日（原始）
    pub fn get_gallery_time_filter_payload(&self) -> Result<GalleryTimeFilterPayload, String> {
        let days = self.get_gallery_day_groups()?;
        Ok(GalleryTimeFilterPayload::from_storage_days(days))
    }

    /// 获取所有「自然日」分组及图片数量（用于画廊按日筛选）
    pub fn get_gallery_day_groups(&self) -> Result<Vec<DayGroup>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%d', CASE WHEN crawled_at > 253402300799 THEN crawled_at/1000 ELSE crawled_at END, 'unixepoch') as d, COUNT(*) as cnt
                 FROM images
                 WHERE crawled_at IS NOT NULL
                 GROUP BY 1
                 HAVING d IS NOT NULL
                 ORDER BY 1 DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let d: Option<String> = row.get(0)?;
                let Some(ymd) = d else {
                    return Ok(None);
                };
                let cnt: i64 = row.get(1)?;
                Ok(Some(DayGroup {
                    ymd,
                    count: cnt as usize,
                }))
            })
            .map_err(|e| format!("Failed to query day groups: {}", e))?;

        let mut groups = Vec::new();
        for r in rows {
            match r {
                Ok(Some(g)) => groups.push(g),
                Ok(None) => {}
                Err(e) => return Err(format!("Failed to read row: {}", e)),
            }
        }
        Ok(groups)
    }

    /// 获取符合条件的图片总数（用于 CommonProvider）。
    ///
    /// 6b 起：query 是 pathql-rs 的 `ProviderQuery`，由 `build_sql` 产 SQL；
    /// 用 `SELECT COUNT(*) FROM (<inner>) AS sub` wrapper 数行。
    pub fn get_images_count_by_query(
        &self,
        query: &pathql_rs::compose::ProviderQuery,
        ctx: &pathql_rs::template::eval::TemplateContext,
    ) -> Result<usize, String> {
        use crate::storage::template_bridge::template_params_for as params_for;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let (inner_sql, inner_values) = query
            .build_sql(ctx, pathql_rs::SqlDialect::Sqlite)
            .map_err(|e| format!("build_sql: {}", e))?;

        let sql = format!("SELECT COUNT(*) FROM ({}) AS sub", inner_sql);
        let params = params_for(&inner_values);

        let count: i64 = conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(params.iter()),
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count images: {} (SQL: {})", e, sql))?;
        Ok(count as usize)
    }

    /// 获取符合条件的图片条目（分页，用于 CommonProvider）。
    ///
    /// 6b 起：query 是 `ProviderQuery`；offset/limit 由调用方在 query 上设置。
    /// 内层 SQL 用 `images.*` 投影避免 JOIN 列冲突。
    pub fn get_images_fs_entries_by_query(
        &self,
        query: &pathql_rs::compose::ProviderQuery,
    ) -> Result<Vec<GalleryImageFsEntry>, String> {
        use pathql_rs::ast::JoinKind;
        use crate::storage::template_bridge::template_params_for as params_for;
        use pathql_rs::template::eval::TemplateContext;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 强制 SELECT images.* (避免 SELECT * 在 JOIN 后列名歧义)
        let mut q = query.clone();
        if q.fields.is_empty() {
            q = q.with_field_raw("images.*", None, &[]);
        }
        let _ = JoinKind::Inner; // imports keep tidy

        let ctx = TemplateContext::default();
        let (inner_sql, inner_values) = q
            .build_sql(&ctx, pathql_rs::SqlDialect::Sqlite)
            .map_err(|e| format!("build_sql: {}", e))?;

        let sql = format!(
            "SELECT
                CAST(sub.id AS TEXT),
                sub.local_path,
                sub.thumbnail_path,
                sub.crawled_at as gallery_ts
             FROM ({}) sub",
            inner_sql
        );

        let params = params_for(&inner_values);

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let id: String = row.get(0)?;
                let local_path: String = row.get(1)?;
                let thumb_path: String = row.get(2)?;
                let gallery_ts: i64 = row.get(3)?;
                Ok((id, local_path, thumb_path, gallery_ts))
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut entries = Vec::new();
        for r in rows {
            let (id, local_path, thumb_path, gallery_ts) =
                r.map_err(|e| format!("Failed to read row: {}", e))?;
            // 文件存在
            let resolved_path = if fs::metadata(&local_path).is_ok() {
                Some(local_path.clone())
            } else if fs::metadata(&thumb_path).is_ok() {
                Some(thumb_path.clone())
            } else {
                None
            };

            let Some(resolved_path) = resolved_path else {
                continue;
            };

            let ext = std::path::Path::new(&resolved_path)
                .extension()
                .and_then(|e| e.to_str())
                // 未知后缀名，不应该跑这个分支
                .unwrap_or("");

            let file_name = format!("{}.{}", id, ext);
            // eprintln!("[VD-FS-ENTRIES] 生成文件条目: image_id={}, file_name={}, resolved_path={:?}, ext={}",
            //     id, file_name, resolved_path, ext);

            entries.push(GalleryImageFsEntry {
                file_name,
                image_id: id,
                resolved_path,
                gallery_ts: if gallery_ts >= 0 {
                    gallery_ts as u64
                } else {
                    0
                },
            });
        }
        Ok(entries)
    }

    /// 解析画廊图片的本地路径（用于虚拟磁盘读取文件）
    pub fn resolve_gallery_image_path(&self, image_id: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT local_path, thumbnail_path FROM images WHERE id = ?1",
                params![image_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        let Some((local_path, thumb_path)) = row else {
            return Ok(None);
        };

        let local_exists = !local_path.trim().is_empty() && fs::metadata(&local_path).is_ok();
        if local_exists {
            return Ok(Some(local_path));
        }

        let thumb_exists = !thumb_path.trim().is_empty() && fs::metadata(&thumb_path).is_ok();
        if thumb_exists {
            return Ok(Some(thumb_path));
        }

        Ok(None)
    }

    /// 获取符合条件的图片信息（分页，给 app-main 画廊 Provider 浏览复用）。
    ///
    /// 6b 起：query 是 `ProviderQuery`；offset/limit 由调用方在 query 上设置。
    /// 内层 SQL 用 `images.*` 投影避免 JOIN 列冲突；外层 wrapper 加 fav_ai / ai_hid 投影 is_favorite / is_hidden。
    ///
    /// 注意：这里不做本地文件 exists 检查（性能考虑），`local_exists` 统一置为 true。
    /// 为减少翻页数据量，**不**查询 `images.metadata` 列；详情区通过 `get_image_metadata` 按需加载。
    pub fn get_images_info_range_by_query(
        &self,
        query: &pathql_rs::compose::ProviderQuery,
        ctx: &pathql_rs::template::eval::TemplateContext,
    ) -> Result<Vec<crate::storage::ImageInfo>, String> {
        use crate::storage::{FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
        use crate::storage::template_bridge::template_params_for as params_for;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 强制 SELECT images.* 在 inner query (避免 JOIN 后列名歧义)
        let mut q = query.clone();
        if q.fields.is_empty() {
            q = q.with_field_raw("images.*", None, &[]);
        }

        let (inner_sql, inner_values) = q
            .build_sql(ctx, pathql_rs::SqlDialect::Sqlite)
            .map_err(|e| format!("build_sql: {}", e))?;

        // outer wrapper: 把 inner 当 sub-query, 再 LEFT JOIN fav_ai / ai_hid 投影 is_favorite / is_hidden
        let sql = format!(
            "SELECT
                CAST(sub.id AS TEXT) as id,
                sub.url,
                sub.local_path,
                sub.plugin_id,
                sub.task_id,
                sub.crawled_at,
                sub.metadata_id,
                COALESCE(NULLIF(sub.thumbnail_path, ''), sub.local_path) as thumbnail_path,
                sub.hash,
                CASE WHEN fav_ai.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                CASE WHEN ai_hid.image_id IS NOT NULL THEN 1 ELSE 0 END as is_hidden,
                sub.width,
                sub.height,
                sub.display_name,
                COALESCE(sub.type, 'image') as media_type,
                sub.last_set_wallpaper_at,
                sub.size
             FROM ({}) sub
             LEFT JOIN album_images fav_ai
               ON sub.id = fav_ai.image_id AND fav_ai.album_id = '{}'
             LEFT JOIN album_images ai_hid
               ON sub.id = ai_hid.image_id AND ai_hid.album_id = '{}'",
            inner_sql, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID
        );

        let params = params_for(&inner_values);

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let last_ts: Option<i64> = row.get(15)?;
                let last_set_wallpaper_at = last_ts.filter(|&t| t >= 0).map(|t| t as u64);
                Ok(crate::storage::ImageInfo {
                    id: row.get(0)?,
                    url: row.get::<_, Option<String>>(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    surf_record_id: None,
                    crawled_at: row.get::<_, i64>(5)? as u64,
                    metadata: None,
                    metadata_id: row.get::<_, Option<i64>>(6)?,
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    is_hidden: row.get::<_, i64>(10)? != 0,
                    local_exists: true,
                    width: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                    height: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
                    display_name: row.get(13)?,
                    media_type: crate::image_type::normalize_stored_media_type(
                        row.get::<_, Option<String>>(14)?,
                    ),
                    last_set_wallpaper_at,
                    size: row.get::<_, Option<i64>>(16)?.map(|v| v as u64),
                })
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            images.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }
}
