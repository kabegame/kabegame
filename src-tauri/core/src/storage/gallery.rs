//! 画廊相关查询（用于虚拟磁盘的 Gallery Provider）

use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

use crate::storage::gallery_time::{gallery_month_groups_from_days, GalleryTimeFilterPayload};
use crate::storage::Storage;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SqlFragment {
    pub sql: String,
    pub params: Vec<String>,
}

/// 图片查询参数（用于 CommonProvider 的动态查询）
///
/// 结构化拆分为 join / where / order 三部分，避免字符串拼接导致的不可组合问题。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageQuery {
    pub joins: Vec<SqlFragment>,
    pub wheres: Vec<SqlFragment>,
    pub order_bys: Vec<String>,
}

impl ImageQuery {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_join(mut self, sql: &str, params: Vec<String>) -> Self {
        let trimmed = sql.trim();
        if !trimmed.is_empty() {
            self.joins.push(SqlFragment {
                sql: trimmed.to_string(),
                params,
            });
        }
        self
    }

    pub fn with_where(mut self, sql: &str, params: Vec<String>) -> Self {
        let trimmed = sql.trim();
        if !trimmed.is_empty() {
            self.wheres.push(SqlFragment {
                sql: trimmed.to_string(),
                params,
            });
        }
        self
    }

    pub fn with_order(mut self, expr: &str) -> Self {
        let trimmed = expr.trim();
        if !trimmed.is_empty() {
            self.order_bys.push(trimmed.to_string());
        }
        self
    }

    /// 在 order_bys **头部**前插一个排序表达式（时间 provider 用，保证时间序优先于 id 序）。
    pub fn prepend_order_by(mut self, expr: &str) -> Self {
        let trimmed = expr.trim();
        if !trimmed.is_empty() {
            self.order_bys.insert(0, trimmed.to_string());
        }
        self
    }

    pub fn merge(mut self, other: &ImageQuery) -> Self {
        self.joins.extend(other.joins.clone());
        self.wheres.extend(other.wheres.clone());
        self.order_bys.extend(other.order_bys.clone());
        self
    }

    /// 拼出完整 decorator + 参数列表（供 list 查询复用）
    pub fn build_sql(&self) -> (String, Vec<String>) {
        let mut parts: Vec<String> = Vec::new();
        let mut params: Vec<String> = Vec::new();

        if !self.joins.is_empty() {
            for join in &self.joins {
                parts.push(join.sql.clone());
                params.extend(join.params.clone());
            }
        }

        if !self.wheres.is_empty() {
            let where_sql = self
                .wheres
                .iter()
                .map(|w| format!("({})", w.sql))
                .collect::<Vec<_>>()
                .join(" AND ");
            parts.push(format!("WHERE {}", where_sql));
            for w in &self.wheres {
                params.extend(w.params.clone());
            }
        }

        if !self.order_bys.is_empty() {
            parts.push(format!("ORDER BY {}", self.order_bys.join(", ")));
        }

        let decorator = if parts.is_empty() {
            String::new()
        } else {
            format!(" {}", parts.join(" "))
        };
        (decorator, params)
    }

    /// 只拼 JOIN + WHERE，用于 count 查询
    pub fn build_count_sql(&self) -> (String, Vec<String>) {
        let mut parts: Vec<String> = Vec::new();
        let mut params: Vec<String> = Vec::new();

        if !self.joins.is_empty() {
            for join in &self.joins {
                parts.push(join.sql.clone());
                params.extend(join.params.clone());
            }
        }

        if !self.wheres.is_empty() {
            let where_sql = self
                .wheres
                .iter()
                .map(|w| format!("({})", w.sql))
                .collect::<Vec<_>>()
                .join(" AND ");
            parts.push(format!("WHERE {}", where_sql));
            for w in &self.wheres {
                params.extend(w.params.clone());
            }
        }

        let decorator = if parts.is_empty() {
            String::new()
        } else {
            format!(" {}", parts.join(" "))
        };
        (decorator, params)
    }

    fn flipped_order_expr(expr: &str) -> String {
        let trimmed = expr.trim();
        let upper = trimmed.to_ascii_uppercase();
        if upper.ends_with(" DESC") {
            let idx = trimmed.len() - "DESC".len();
            return format!("{} ASC", trimmed[..idx].trim_end());
        }
        if upper.ends_with(" ASC") {
            let idx = trimmed.len() - "ASC".len();
            return format!("{} DESC", trimmed[..idx].trim_end());
        }
        format!("{} DESC", trimmed)
    }

    pub fn is_unfiltered(&self) -> bool {
        self.joins.is_empty() && self.wheres.is_empty()
    }

    pub fn is_ascending(&self) -> bool {
        !self.order_bys.is_empty()
            && self
                .order_bys
                .iter()
                .all(|o| o.trim().to_ascii_uppercase().ends_with(" ASC"))
    }

    pub fn to_desc(&self) -> Self {
        let mut out = self.clone();
        out.order_bys = out
            .order_bys
            .iter()
            .map(|o| Self::flipped_order_expr(o))
            .collect();
        out
    }

    pub fn album_id(&self) -> Option<&str> {
        let has_album_join = self.joins.iter().any(|j| j.sql.contains("album_images ai"));
        if !has_album_join {
            return None;
        }
        self.wheres
            .iter()
            .find(|w| w.sql.contains("ai.album_id = ?"))
            .and_then(|w| w.params.first().map(String::as_str))
    }

    /// 查询组件：过滤“设为壁纸过”
    pub fn wallpaper_set_filter() -> Self {
        Self::new().with_where("images.last_set_wallpaper_at IS NOT NULL", vec![])
    }

    /// 查询组件：按插件过滤
    pub fn plugin_filter(plugin_id: String) -> Self {
        Self::new().with_where("images.plugin_id = ?", vec![plugin_id])
    }

    /// 查询组件：按年月过滤
    pub fn date_filter(year_month: String) -> Self {
        Self::new().with_where(
            "strftime('%Y-%m', CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') = ?",
            vec![year_month],
        )
    }

    /// 查询组件：按公历年过滤（`year` 为四位数字字符串，如 `"2024"`）
    pub fn year_filter(year: String) -> Self {
        Self::new().with_where(
            "strftime('%Y', CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') = ?",
            vec![year],
        )
    }

    /// 查询组件：按自然日过滤（`ymd` 为 `YYYY-MM-DD`）
    pub fn day_filter(ymd: String) -> Self {
        Self::new().with_where(
            "strftime('%Y-%m-%d', CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') = ?",
            vec![ymd],
        )
    }

    /// 查询组件：按日期范围过滤（闭区间）
    pub fn date_range_filter(start_ymd: String, end_ymd: String) -> Self {
        Self::new().with_where(
            "date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') >= date(?)",
            vec![start_ymd],
        )
        .with_where(
            "date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') <= date(?)",
            vec![end_ymd],
        )
    }

    /// 查询组件：按畅游记录过滤
    pub fn surf_record_filter(surf_record_id: String) -> Self {
        Self::new().with_where("images.surf_record_id = ?", vec![surf_record_id])
    }

    /// 查询组件：按媒体大类过滤（`media_type` 为 `image` 或 `video`，与 `images.type` 的 MIME 前缀一致）
    pub fn media_type_filter(media_type: &str) -> Self {
        if media_type == "video" {
            Self::new().with_where(
                "(LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%')",
                vec![],
            )
        } else {
            Self::new().with_where(
                "NOT (LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%')",
                vec![],
            )
        }
    }

    /// 查询组件：以画册关联表作为数据源
    pub fn album_source(album_id: String) -> Self {
        Self::new()
            .with_join(
                "INNER JOIN album_images ai ON images.id = ai.image_id",
                vec![],
            )
            .with_where("ai.album_id = ?", vec![album_id])
    }

    /// 查询组件：按任务过滤（单图单任务）
    pub fn task_source(task_id: String) -> Self {
        Self::new().with_where("images.task_id = ?", vec![task_id])
    }

    /// 查询组件：按抓取时间排序
    pub fn sort_by_crawled_at(asc: bool) -> Self {
        Self::new().with_order(if asc {
            "images.crawled_at ASC"
        } else {
            "images.crawled_at DESC"
        })
    }

    /// 查询组件：按 images.id 排序（用于 VD 分页稳定性：页数越小 id 越小）
    pub fn sort_by_id(asc: bool) -> Self {
        Self::new().with_order(if asc {
            "images.id ASC"
        } else {
            "images.id DESC"
        })
    }

    /// 返回替换排序为 id ASC 的副本（用于 VD：跨所有查询使用统一的、稳定的排序）
    pub fn with_id_order(&self, asc: bool) -> Self {
        let mut out = self.clone();
        out.order_bys.clear();
        out.order_bys.push(if asc {
            "images.id ASC".to_string()
        } else {
            "images.id DESC".to_string()
        });
        out
    }

    /// 查询组件：按最后设壁纸时间排序
    pub fn sort_by_wallpaper_set_at(asc: bool) -> Self {
        Self::new().with_order(if asc {
            "images.last_set_wallpaper_at ASC"
        } else {
            "images.last_set_wallpaper_at DESC"
        })
    }

    /// 查询组件：按画册内 `album_images.order`（加入顺序）排序
    pub fn sort_by_album_order(asc: bool) -> Self {
        Self::new().with_order(if asc {
            "COALESCE(ai.\"order\", ai.rowid) ASC"
        } else {
            "COALESCE(ai.\"order\", ai.rowid) DESC"
        })
    }

    /// 查询组件：按任务内顺序排序（与抓取时间一致）
    pub fn sort_by_task_order() -> Self {
        Self::new().with_order("images.crawled_at ASC")
    }

    /// 按插件 ID 过滤
    pub fn by_plugin(plugin_id: String) -> Self {
        Self::plugin_filter(plugin_id).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按日期（年-月）过滤
    pub fn by_date(year_month: String) -> Self {
        Self::date_filter(year_month).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按公历年过滤
    pub fn by_year(year: String) -> Self {
        Self::year_filter(year).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按自然日（YYYY-MM-DD）过滤
    pub fn by_date_day(ymd: String) -> Self {
        Self::day_filter(ymd).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按日期范围过滤（闭区间，日粒度）
    ///
    /// - start_ymd / end_ymd 格式：`YYYY-MM-DD`
    /// - 使用 SQLite `date(..., 'unixepoch')` 做比较，兼容 ms/秒时间戳
    pub fn by_date_range(start_ymd: String, end_ymd: String) -> Self {
        Self::date_range_filter(start_ymd, end_ymd).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按画册过滤（使用 JOIN 获取正确排序）
    pub fn by_album(album_id: String) -> Self {
        Self::album_source(album_id).merge(&Self::sort_by_album_order(true))
    }

    /// 按任务过滤（直接使用 images.task_id）
    pub fn by_task(task_id: String) -> Self {
        Self::task_source(task_id).merge(&Self::sort_by_task_order())
    }

    /// 按畅游记录过滤（默认升序，和其它 provider 一致）
    pub fn by_surf_record(surf_record_id: String) -> Self {
        Self::surf_record_filter(surf_record_id).merge(&Self::sort_by_crawled_at(true))
    }

    /// 按畅游记录过滤（倒序）
    pub fn by_surf_record_desc(surf_record_id: String) -> Self {
        Self::surf_record_filter(surf_record_id).merge(&Self::sort_by_crawled_at(false))
    }

    /// 按媒体类型过滤（`image` / `video`），按抓取时间正序
    pub fn by_media_type(media_type: &str) -> Self {
        Self::media_type_filter(media_type).merge(&Self::sort_by_crawled_at(true))
    }

    /// 全部图片（按时间正序，用于 CommonProvider「全部」）
    pub fn all_recent() -> Self {
        Self::sort_by_crawled_at(true)
    }

    /// 全部图片（按时间倒序，用于 CommonProvider「全部/倒序」）
    pub fn all_recent_desc() -> Self {
        Self::sort_by_crawled_at(false)
    }

    /// 是否为「全部、按时间正序」查询（用于仅在正序「全部」下展示「倒序」子目录）
    pub fn is_all_recent_asc(&self) -> bool {
        self.is_unfiltered() && self.order_bys == Self::all_recent().order_bys
    }

    /// 曾被设为壁纸的图片，按「最后一次设为壁纸」时间正序（最早在前）
    pub fn all_by_wallpaper_set() -> Self {
        Self::wallpaper_set_filter().merge(&Self::sort_by_wallpaper_set_at(true))
    }

    /// 曾被设为壁纸的图片，按「最后一次设为壁纸」时间倒序（最近在前）
    pub fn all_by_wallpaper_set_desc() -> Self {
        Self::wallpaper_set_filter().merge(&Self::sort_by_wallpaper_set_at(false))
    }

    /// 是否为「按壁纸设置顺序、正序」查询（用于展示 desc 子目录）
    pub fn is_all_by_wallpaper_set_asc(&self) -> bool {
        self.joins.is_empty()
            && self.wheres == Self::wallpaper_set_filter().wheres
            && self.order_bys == Self::all_by_wallpaper_set().order_bys
    }
}

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

    /// 获取符合条件的图片总数（用于 CommonProvider）
    pub fn get_images_count_by_query(&self, query: &ImageQuery) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let (decorator, built_params) = query.build_count_sql();
        let sql = format!("SELECT COUNT(*) FROM images{}", decorator);

        let params: Vec<&dyn ToSql> = built_params.iter().map(|p| p as &dyn ToSql).collect();

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

        let (decorator, built_params) = query.build_sql();
        let sql = format!(
            "SELECT
                CAST(images.id AS TEXT),
                images.local_path,
                images.thumbnail_path,
                images.crawled_at as gallery_ts
             FROM images{} LIMIT ? OFFSET ?",
            decorator
        );

        // 参数顺序：decorator params -> limit -> offset
        let mut params: Vec<Box<dyn ToSql>> = built_params
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
    /// 为减少翻页数据量，**不**查询 `images.metadata` 列；详情区通过 `get_image_metadata` 按需加载。
    pub fn get_images_info_range_by_query(
        &self,
        query: &ImageQuery,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<crate::storage::ImageInfo>, String> {
        use crate::storage::FAVORITE_ALBUM_ID;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let (decorator, built_params) = query.build_sql();
        // 参数顺序：decorator params -> limit -> offset
        let mut params: Vec<Box<dyn ToSql>> = built_params
            .iter()
            .map(|p| Box::new(p.clone()) as Box<dyn ToSql>)
            .collect();
        params.push(Box::new(limit as i64));
        params.push(Box::new(offset as i64));
        let params_ref: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();

        // 为避免与 query 的 album_images/ai 冲突，这里 favorites join 使用独立 alias：fav_ai
        let sql = format!(
            "SELECT
                CAST(images.id AS TEXT) as id,
                images.url,
                images.local_path,
                images.plugin_id,
                images.task_id,
                images.crawled_at,
                images.metadata_id,
                COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                images.hash,
                CASE WHEN fav_ai.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                images.width,
                images.height,
                images.display_name,
                COALESCE(images.type, 'image') as media_type,
                images.last_set_wallpaper_at,
                images.size
             FROM images
             LEFT JOIN album_images fav_ai
               ON images.id = fav_ai.image_id AND fav_ai.album_id = '{}'
             {} LIMIT ? OFFSET ?",
            FAVORITE_ALBUM_ID, decorator
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {} (SQL: {})", e, sql))?;

        let rows = stmt
            .query_map(params_from_iter(params_ref.iter().copied()), |row| {
                let last_ts: Option<i64> = row.get(14)?;
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
                    local_exists: true,
                    width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                    display_name: row.get(12)?,
                    media_type: crate::image_type::normalize_stored_media_type(
                        row.get::<_, Option<String>>(13)?,
                    ),
                    last_set_wallpaper_at,
                    size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
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
