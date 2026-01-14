//! 画廊相关查询（用于虚拟磁盘的 Gallery Provider）

use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

use crate::storage::Storage;

/// 图片查询参数（用于 AllProvider 的动态查询）
///
/// 使用 decorator 模式，将 SQL 片段直接拼接在 SELECT 和 LIMIT 之间。
/// 完整 SQL 结构：
/// ```sql
/// SELECT ... FROM images {decorator} LIMIT ? OFFSET ?
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageQuery {
    /// SQL 片段，拼接在 "SELECT ... FROM images" 和 "LIMIT ? OFFSET ?" 之间
    /// 可以包含 JOIN、WHERE、ORDER BY 等任意组合
    pub decorator: String,
    /// 查询参数（按 decorator 中 ? 占位符的顺序）
    pub params: Vec<String>,
}

impl ImageQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// 按插件 ID 过滤
    pub fn by_plugin(plugin_id: String) -> Self {
        Self {
            // 注意：gallery 查询会额外 LEFT JOIN 收藏表（album_images），该表也有 "order" 列；
            // 这里必须显式加表前缀避免歧义。
            decorator:
                "WHERE images.plugin_id = ? ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC"
                .to_string(),
            params: vec![plugin_id],
        }
    }

    /// 按日期（年-月）过滤
    pub fn by_date(year_month: String) -> Self {
        Self {
            decorator:
                "WHERE strftime('%Y-%m', CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') = ? ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC"
                    .to_string(),
            params: vec![year_month],
        }
    }

    /// 按日期范围过滤（闭区间，日粒度）
    ///
    /// - start_ymd / end_ymd 格式：`YYYY-MM-DD`
    /// - 使用 SQLite `date(..., 'unixepoch')` 做比较，兼容 ms/秒时间戳
    pub fn by_date_range(start_ymd: String, end_ymd: String) -> Self {
        // 注意：images.crawled_at 为空的行自动被过滤（date(NULL, ...) 为 NULL，与比较结果为 NULL/false）
        Self {
            decorator:
                "WHERE date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') >= date(?) AND date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') <= date(?) ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC"
                    .to_string(),
            params: vec![start_ymd, end_ymd],
        }
    }

    /// 按画册过滤（使用 JOIN 获取正确排序）
    pub fn by_album(album_id: String) -> Self {
        Self {
            decorator:
                "INNER JOIN album_images ai ON images.id = ai.image_id WHERE ai.album_id = ? ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC"
                    .to_string(),
            params: vec![album_id],
        }
    }

    /// 按任务过滤（使用 JOIN 获取正确排序）
    pub fn by_task(task_id: String) -> Self {
        Self {
            decorator:
                "INNER JOIN task_images ti ON images.id = ti.image_id WHERE ti.task_id = ? ORDER BY COALESCE(ti.\"order\", ti.rowid) ASC"
                    .to_string(),
            params: vec![task_id],
        }
    }

    /// 全部图片（按时间排序，用于 CommonProvider）
    pub fn all_recent() -> Self {
        Self {
            // 与前端画廊 `get_images_range` 对齐：优先按 order，其次 crawled_at
            // 注意：外层会 LEFT JOIN 收藏表，避免 "order" 歧义必须加 images 前缀
            decorator: "ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC".to_string(),
            params: vec![],
        }
    }
}

/// 从 decorator 中提取 COUNT 查询需要的部分（JOIN 和 WHERE，去掉 ORDER BY）
fn extract_count_decorator(decorator: &str) -> String {
    // 简单实现：找到 ORDER BY 并截断
    if let Some(pos) = decorator.to_uppercase().find("ORDER BY") {
        decorator[..pos].trim().to_string()
    } else {
        decorator.to_string()
    }
}

/// 插件分组信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginGroup {
    pub plugin_id: String,
    pub count: usize,
}

/// 日期分组信息（年-月）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateGroup {
    pub year_month: String, // 格式: "2024-01"
    pub count: usize,
}

/// 画廊图片条目
#[derive(Debug, Clone)]
pub struct GalleryImageFsEntry {
    pub file_name: String,
    pub image_id: String,
    pub resolved_path: String,
    /// 画廊排序时间戳：`COALESCE(images."order", images.crawled_at)`
    pub gallery_ts: u64,
}

impl Storage {
    /// 批量获取图片的“画廊排序时间戳”（用于虚拟盘/画廊一致的时间显示）。
    ///
    /// 返回 map：`image_id -> ts`，其中 `ts = COALESCE(images."order", images.crawled_at)`。
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
            "SELECT CAST(images.id AS TEXT) as id, COALESCE(images.\"order\", images.crawled_at) as ts
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

    /// 获取所有日期分组（年-月）及其图片数量
    pub fn get_gallery_date_groups(&self) -> Result<Vec<DateGroup>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m', CASE WHEN crawled_at > 253402300799 THEN crawled_at/1000 ELSE crawled_at END, 'unixepoch') as ym, COUNT(*) as cnt
                 FROM images
                 WHERE crawled_at IS NOT NULL
                 GROUP BY ym
                 HAVING ym IS NOT NULL
                 ORDER BY ym DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let ym: Option<String> = row.get(0)?;
                let Some(year_month) = ym else {
                    // 理论上已被 HAVING 过滤，这里保险起见再跳过
                    return Ok(None);
                };
                let cnt: i64 = row.get(1)?;
                Ok(Some(DateGroup {
                    year_month,
                    count: cnt as usize,
                }))
            })
            .map_err(|e| format!("Failed to query date groups: {}", e))?;

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

    /// 获取符合条件的图片总数（用于 CommonProvider）
    pub fn get_images_count_by_query(&self, query: &ImageQuery) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 从 decorator 中提取 COUNT 需要的部分（JOIN 和 WHERE，去掉 ORDER BY）
        let count_decorator = extract_count_decorator(&query.decorator);
        let sql = format!("SELECT COUNT(*) FROM images {}", count_decorator);

        let params: Vec<&dyn ToSql> = query.params.iter().map(|p| p as &dyn ToSql).collect();

        let count: i64 = conn
            .query_row(&sql, params_from_iter(params.iter().copied()), |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to count images: {} (SQL: {})", e, sql))?;
        Ok(count as usize)
    }

    /// 获取符合条件的图片条目（分页，用于 CommonProvider）
    pub fn get_images_fs_entries_by_query(
        &self,
        query: &ImageQuery,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<GalleryImageFsEntry>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = format!(
            "SELECT
                CAST(images.id AS TEXT),
                images.local_path,
                images.thumbnail_path,
                COALESCE(images.\"order\", images.crawled_at) as gallery_ts
             FROM images {} LIMIT ? OFFSET ?",
            query.decorator
        );

        // 参数顺序：decorator params -> limit -> offset
        let mut params: Vec<Box<dyn ToSql>> = query
            .params
            .iter()
            .map(|p| Box::new(p.clone()) as Box<dyn ToSql>)
            .collect();
        params.push(Box::new(limit as i64));
        params.push(Box::new(offset as i64));

        let params_ref: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(params_from_iter(params_ref.iter().copied()), |row| {
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

    /// 获取符合条件的图片信息（分页，给 app-main 画廊 Provider 浏览复用）
    ///
    /// 注意：这里不做本地文件 exists 检查（性能考虑），`local_exists` 统一置为 true。
    pub fn get_images_info_range_by_query(
        &self,
        query: &ImageQuery,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<crate::storage::ImageInfo>, String> {
        use crate::storage::FAVORITE_ALBUM_ID;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // 参数顺序：decorator params -> limit -> offset
        let mut params: Vec<Box<dyn ToSql>> = query
            .params
            .iter()
            .map(|p| Box::new(p.clone()) as Box<dyn ToSql>)
            .collect();
        params.push(Box::new(limit as i64));
        params.push(Box::new(offset as i64));
        let params_ref: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();

        // 为避免与 query.decorator 里的 album_images/ai 冲突，这里 favorites join 使用独立 alias：fav_ai
        let sql = format!(
            "SELECT
                CAST(images.id AS TEXT) as id,
                images.url,
                images.local_path,
                images.plugin_id,
                images.task_id,
                images.crawled_at,
                images.metadata,
                COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                images.hash,
                CASE WHEN fav_ai.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                images.\"order\"
             FROM images
             LEFT JOIN album_images fav_ai
               ON images.id = fav_ai.image_id AND fav_ai.album_id = '{}'
             {} LIMIT ? OFFSET ?",
            FAVORITE_ALBUM_ID, query.decorator
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(params_from_iter(params_ref.iter().copied()), |row| {
                Ok(crate::storage::ImageInfo {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get::<_, i64>(5)? as u64,
                    metadata: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists: true,
                    order: row.get::<_, Option<i64>>(10)?,
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
