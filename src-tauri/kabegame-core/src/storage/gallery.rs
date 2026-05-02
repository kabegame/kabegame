//! 画廊相关查询（用于虚拟磁盘的 Gallery Provider）

use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

use crate::storage::gallery_time::GalleryTimeFilterPayload;
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
        crate::providers::gallery_plugin_groups_at()
    }

    /// 画廊全局：按 `images.type` 统计图片与视频条数
    pub fn get_gallery_media_type_counts(&self) -> Result<GalleryMediaTypeCounts, String> {
        crate::providers::gallery_media_type_counts_at("/gallery")
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
        crate::providers::gallery_media_type_counts_at(&format!(
            "/gallery/album/{}",
            urlencoding::encode(id)
        ))
    }

    /// 获取所有日期分组（年-月）及其图片数量（由日粒度聚合派生，见 `gallery_time`）。
    pub fn get_gallery_date_groups(&self) -> Result<Vec<DateGroup>, String> {
        crate::providers::gallery_date_groups_at()
    }

    /// 画廊时间过滤：一次返回月（派生）+ 日（原始）
    pub fn get_gallery_time_filter_payload(&self) -> Result<GalleryTimeFilterPayload, String> {
        crate::providers::gallery_time_filter_payload_at()
    }

    /// 获取所有「自然日」分组及图片数量（用于画廊按日筛选）
    pub fn get_gallery_day_groups(&self) -> Result<Vec<DayGroup>, String> {
        crate::providers::gallery_day_groups_at()
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
