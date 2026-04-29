//! 逕ｻ蟒顔嶌蜈ｳ譟･隸｢・育畑莠手劒諡溽｣∫尨逧・Gallery Provider・・
use rusqlite::{params, params_from_iter, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;

use pathql_rs::template::eval::TemplateContext;

use crate::storage::gallery_time::{gallery_month_groups_from_days, GalleryTimeFilterPayload};
use crate::storage::Storage;

/// 謠剃ｻｶ蛻・ｻ・ｿ｡諱ｯ





#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginGroup {
    pub plugin_id: String,
    pub count: usize,
}

/// 謖牙ｪ剃ｽ鍋ｱｻ蝙具ｼ亥崟迚・/ 隗・｢托ｼ臥噪謨ｰ驥擾ｼ・video` 謌・`video/*` 隶｡蜈･隗・｢托ｼ悟・菴吝性遨ｺ蛟ｼ隶｡蜈･蝗ｾ迚・ｼ・#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryMediaTypeCounts {
    pub image_count: usize,
    pub video_count: usize,
}

/// 譌･譛溷・扈・ｿ｡諱ｯ・亥ｹｴ-譛茨ｼ・#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateGroup {
    pub year_month: String, // 譬ｼ蠑・ "2024-01"
    pub count: usize,
}

/// 譌･譛溷・扈・ｿ｡諱ｯ・亥ｹｴ-譛・譌･・・#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayGroup {
    pub ymd: String, // 譬ｼ蠑・ "2024-01-15"
    pub count: usize,
}

/// 逕ｻ蟒雁崟迚・擅逶ｮ





#[derive(Debug, Clone)]
pub struct GalleryImageFsEntry {
    pub file_name: String,
    pub image_id: String,
    pub resolved_path: String,
    /// 逕ｻ蟒頑賜蠎乗慮髣ｴ謌ｳ・啻images.crawled_at`
    pub gallery_ts: u64,
}

fn json_string(row: &JsonValue, key: &str) -> Result<String, String> {
    row.get(key)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing string column `{key}`"))
}

fn json_opt_string(row: &JsonValue, key: &str) -> Option<String> {
    row.get(key)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
}

fn json_i64(row: &JsonValue, key: &str) -> Result<i64, String> {
    row.get(key)
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| format!("missing integer column `{key}`"))
}

fn json_opt_i64(row: &JsonValue, key: &str) -> Option<i64> {
    row.get(key).and_then(JsonValue::as_i64)
}

fn json_bool(row: &JsonValue, key: &str) -> bool {
    match row.get(key) {
        Some(JsonValue::Bool(v)) => *v,
        Some(v) => v.as_i64().unwrap_or(0) != 0,
        None => false,
    }
}

fn json_row_to_image_info(row: &JsonValue) -> Result<crate::storage::ImageInfo, String> {
    if !row.is_object() {
        return Err("executor row is not a JSON object".to_string());
    }

    let crawled_at = json_i64(row, "crawled_at")?;
    let last_set_wallpaper_at = json_opt_i64(row, "last_set_wallpaper_at")
        .filter(|&t| t >= 0)
        .map(|t| t as u64);

    Ok(crate::storage::ImageInfo {
        id: json_string(row, "id")?,
        url: json_opt_string(row, "url"),
        local_path: json_string(row, "local_path")?,
        plugin_id: json_string(row, "plugin_id")?,
        task_id: json_opt_string(row, "task_id"),
        surf_record_id: None,
        crawled_at: if crawled_at >= 0 { crawled_at as u64 } else { 0 },
        metadata: None,
        metadata_id: json_opt_i64(row, "metadata_id"),
        thumbnail_path: json_string(row, "thumbnail_path")?,
        hash: json_opt_string(row, "hash").unwrap_or_default(),
        favorite: json_bool(row, "is_favorite"),
        is_hidden: json_bool(row, "is_hidden"),
        local_exists: true,
        width: json_opt_i64(row, "width").map(|v| v as u32),
        height: json_opt_i64(row, "height").map(|v| v as u32),
        display_name: json_opt_string(row, "display_name").unwrap_or_default(),
        media_type: crate::image_type::normalize_stored_media_type(json_opt_string(
            row,
            "media_type",
        )),
        last_set_wallpaper_at,
        size: json_opt_i64(row, "size").map(|v| v as u64),
    })
}

impl Storage {
    /// 謇ｹ驥剰執蜿門崟迚・噪窶懃判蟒頑賜蠎乗慮髣ｴ謌ｳ窶晢ｼ育畑莠手劒諡溽尨/逕ｻ蟒贋ｸ閾ｴ逧・慮髣ｴ譏ｾ遉ｺ・峨・    ///
    /// 霑泌屓 map・啻image_id -> ts`・悟・荳ｭ `ts = images.crawled_at`縲・




    pub fn get_images_gallery_ts_by_ids(
        &self,
        image_ids: &[String],
    ) -> Result<HashMap<String, u64>, String> {
        let mut out: HashMap<String, u64> = HashMap::new();
        if image_ids.is_empty() {
            return Ok(out);
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        // IN (?, ?, ...) 蜉ｨ諤∝頃菴咲ｬｦ
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

    /// 闔ｷ蜿匁園譛画薯莉ｶ蛻・ｻ・所蜈ｶ蝗ｾ迚・焚驥・




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

    /// 逕ｻ蟒雁・螻・壽潔 `images.type` 扈溯ｮ｡蝗ｾ迚・ｸ手ｧ・｢第擅謨ｰ





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
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )
            .map_err(|e| format!("Failed to query media type counts: {}", e))?;
        Ok(GalleryMediaTypeCounts {
            image_count: image_count as usize,
            video_count: video_count as usize,
        })
    }

    /// 謖・ｮ夂判蜀悟・・壽潔蟐剃ｽ鍋ｱｻ蝙狗ｻ溯ｮ｡譚｡謨ｰ





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
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )
            .map_err(|e| format!("Failed to query album media type counts: {}", e))?;
        Ok(GalleryMediaTypeCounts {
            image_count: image_count as usize,
            video_count: video_count as usize,
        })
    }

    /// 闔ｷ蜿匁園譛画律譛溷・扈・ｼ亥ｹｴ-譛茨ｼ牙所蜈ｶ蝗ｾ迚・焚驥擾ｼ育罰譌･邊貞ｺｦ閨壼粋豢ｾ逕滂ｼ瑚ｧ・`gallery_time`・峨・




    pub fn get_gallery_date_groups(&self) -> Result<Vec<DateGroup>, String> {
        let days = self.get_gallery_day_groups()?;
        Ok(gallery_month_groups_from_days(&days))
    }

    /// 逕ｻ蟒頑慮髣ｴ霑・ｻ､・壻ｸ谺｡霑泌屓譛茨ｼ域ｴｾ逕滂ｼ・ 譌･・亥次蟋具ｼ・




    pub fn get_gallery_time_filter_payload(&self) -> Result<GalleryTimeFilterPayload, String> {
        let days = self.get_gallery_day_groups()?;
        Ok(GalleryTimeFilterPayload::from_storage_days(days))
    }

    /// 闔ｷ蜿匁園譛峨瑚・辟ｶ譌･縲榊・扈・所蝗ｾ迚・焚驥擾ｼ育畑莠守判蟒頑潔譌･遲幃会ｼ・




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

    /// 闔ｷ蜿也ｬｦ蜷域擅莉ｶ逧・崟迚・ｻ謨ｰ・育畑莠・CommonProvider・峨・    ///
    /// 6b 襍ｷ・嘔uery 譏ｯ pathql-rs 逧・`ProviderQuery`・檎罰 `build_sql` 莠ｧ SQL・・    /// 逕ｨ `SELECT COUNT(*) FROM (<inner>) AS sub` wrapper 謨ｰ陦後・




    pub fn get_images_count_by_query(
        &self,
        query: &pathql_rs::compose::ProviderQuery,
        ctx: &TemplateContext,
    ) -> Result<usize, String> {
        let executor = crate::providers::provider_runtime().executor();
        let (inner_sql, inner_values) = query
            .build_sql(&ctx, executor.dialect())
            .map_err(|e| format!("build_sql: {}", e))?;

        let sql = format!("SELECT COUNT(*) AS n FROM ({}) AS sub", inner_sql);
        let rows = executor
            .execute(&sql, &inner_values)
            .map_err(|e| format!("Failed to count images: {} (SQL: {})", e, sql))?;
        let count = rows
            .first()
            .and_then(|row| row.get("n"))
            .and_then(JsonValue::as_u64)
            .unwrap_or(0);
        Ok(count as usize)
    }

    /// 闔ｷ蜿也ｬｦ蜷域擅莉ｶ逧・崟迚・擅逶ｮ・亥・鬘ｵ・檎畑莠・CommonProvider・峨・    ///
    /// 隗｣譫千判蟒雁崟迚・噪譛ｬ蝨ｰ霍ｯ蠕・ｼ育畑莠手劒諡溽｣∫尨隸ｻ蜿匁枚莉ｶ・・




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

    /// 闔ｷ蜿也ｬｦ蜷域擅莉ｶ逧・崟迚・ｿ｡諱ｯ・亥・鬘ｵ・檎ｻ・app-main 逕ｻ蟒・Provider 豬剰ｧ亥､咲畑・峨・    ///
    /// 6b 襍ｷ・嘔uery 譏ｯ `ProviderQuery`・孃ffset/limit 逕ｱ隹・畑譁ｹ蝨ｨ query 荳願ｮｾ鄂ｮ縲・    /// 蜀・ｱ・SQL 逕ｨ `images.*` 謚募ｽｱ驕ｿ蜈・JOIN 蛻怜・遯・ｼ帛､門ｱ・wrapper 蜉 fav_ai / ai_hid 謚募ｽｱ is_favorite / is_hidden縲・    ///





    pub fn get_images_info_range_by_query(
        &self,
        query: &pathql_rs::compose::ProviderQuery,
        ctx: &TemplateContext,
    ) -> Result<Vec<crate::storage::ImageInfo>, String> {
        let executor = crate::providers::provider_runtime().executor();
        let (sql, values) = query
            .build_sql(&ctx, executor.dialect())
            .map_err(|e| format!("build_sql: {}", e))?;

        executor
            .execute(&sql, &values)
            .map_err(|e| format!("Failed to query images: {} (SQL: {})", e, sql))?
            .iter()
            .map(json_row_to_image_info)
            .collect()
    }
}
