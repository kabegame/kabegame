//! 画廊相关查询（用于虚拟磁盘的 Gallery Provider）

use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use std::fs;

use crate::storage::Storage;

/// 图片查询参数（用于 AllProvider 的动态查询）
///
/// 使用 decorator 模式，将 SQL 片段直接拼接在 SELECT 和 LIMIT 之间。
/// 完整 SQL 结构：
/// ```sql
/// SELECT ... FROM images {decorator} LIMIT ? OFFSET ?
/// ```
#[derive(Debug, Clone, Default)]
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
            decorator: "WHERE plugin_id = ? ORDER BY COALESCE(\"order\", crawled_at) ASC"
                .to_string(),
            params: vec![plugin_id],
        }
    }

    /// 按日期（年-月）过滤
    pub fn by_date(year_month: String) -> Self {
        Self {
            decorator:
                "WHERE strftime('%Y-%m', CASE WHEN crawled_at > 253402300799 THEN crawled_at/1000 ELSE crawled_at END, 'unixepoch') = ? ORDER BY COALESCE(\"order\", crawled_at) ASC"
                    .to_string(),
            params: vec![year_month],
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

    /// 全部图片（按时间排序）
    pub fn all_recent() -> Self {
        Self {
            decorator: "ORDER BY crawled_at ASC".to_string(),
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

/// 画廊图片条目（用于虚拟磁盘）
#[derive(Debug, Clone)]
pub struct GalleryImageFsEntry {
    pub file_name: String,
    pub image_id: String,
    pub resolved_path: String,
}

impl Storage {
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

    /// 获取符合条件的图片总数（用于 AllProvider）
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

    /// 获取符合条件的图片条目（分页，用于 AllProvider）
    pub fn get_images_fs_entries_by_query(
        &self,
        query: &ImageQuery,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<GalleryImageFsEntry>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = format!(
            "SELECT CAST(images.id AS TEXT), images.local_path, images.thumbnail_path
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
                Ok((id, local_path, thumb_path))
            })
            .map_err(|e| format!("Failed to query images: {}", e))?;

        let mut entries = Vec::new();
        for r in rows {
            let (id, local_path, thumb_path) =
                r.map_err(|e| format!("Failed to read row: {}", e))?;

            let resolved_path =
                if !local_path.trim().is_empty() && fs::metadata(&local_path).is_ok() {
                    Some(local_path.clone())
                } else if !thumb_path.trim().is_empty() && fs::metadata(&thumb_path).is_ok() {
                    Some(thumb_path.clone())
                } else {
                    None
                };

            let Some(resolved_path) = resolved_path else {
                continue;
            };

            let ext_source = if !local_path.trim().is_empty() {
                &local_path
            } else {
                &resolved_path
            };
            let ext = std::path::Path::new(ext_source)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");

            entries.push(GalleryImageFsEntry {
                file_name: format!("{}.{}", id, ext),
                image_id: id,
                resolved_path,
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
}
