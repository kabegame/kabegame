use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::storage::{Storage, FAVORITE_ALBUM_ID, default_true};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    pub url: String,
    pub local_path: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    pub crawled_at: u64,
    pub metadata: Option<HashMap<String, String>>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    pub favorite: bool,
    /// 本地文件是否存在（用于前端标记缺失文件：仍展示条目，但提示用户源文件已丢失/移动）
    #[serde(default = "default_true")]
    pub local_exists: bool,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub order: Option<i64>,
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

impl Storage {
    pub fn get_images_range(&self, offset: usize, limit: usize) -> Result<RangedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total = self.get_images_total_cached(&conn)?;

        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.\"order\"
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             ORDER BY COALESCE(images.\"order\", images.crawled_at) ASC 
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
                    url: row.get(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    crawled_at: row.get(5)?,
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
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.id = ?1",
                params![image_id],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row
                            .get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
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

    pub fn find_image_by_path(&self, local_path: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut result = conn
            .query_row(
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.local_path = ?1",
                params![local_path],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
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
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.url = ?1",
                params![url],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
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
                "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata,
                 COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
                 images.hash,
                 images.\"order\"
                 FROM images
                 WHERE images.hash = ?1",
                params![hash],
                |row| {
                    let local_path: String = row.get(2)?;
                    let local_exists = PathBuf::from(&local_path).exists();
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        local_path,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        crawled_at: row.get(5)?,
                        metadata: row.get::<_, Option<String>>(6)?
                            .and_then(|s| serde_json::from_str(&s).ok()),
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: false,
                        local_exists,
                        order: row.get::<_, Option<i64>>(9)?,
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

    pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let metadata_json = serde_json::to_string(&image.metadata)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

        let thumbnail_path = if image.thumbnail_path.trim().is_empty() {
            image.local_path.clone()
        } else {
            image.thumbnail_path.clone()
        };

        let order = image.order.unwrap_or(image.crawled_at as i64);

        conn.execute(
            "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, \"order\")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.crawled_at as i64,
                metadata_json,
                thumbnail_path,
                image.hash,
                order,
            ],
        )
        .map_err(|e| format!("Failed to add image: {}", e))?;

        let id = conn.last_insert_rowid();
        image.id = id.to_string();
        image.thumbnail_path = thumbnail_path;
        image.order = Some(order);

        if let Some(task_id) = image.task_id.as_ref() {
            let added_at = image.crawled_at;
            let _ = conn.execute(
                "INSERT OR REPLACE INTO task_images (task_id, image_id, added_at, \"order\") VALUES (?1, ?2, ?3, ?4)",
                params![task_id, id, added_at as i64, order],
            );
        }

        self.invalidate_images_total_cache();

        Ok(image)
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

        if let Some(path) = local_path {
            let _ = fs::remove_file(path);
        }

        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to delete image from DB: {}", e))?;

        let _ = conn.execute("DELETE FROM album_images WHERE image_id = ?1", params![image_id]);
        let _ = conn.execute("DELETE FROM task_images WHERE image_id = ?1", params![image_id]);

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn remove_image(&self, image_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])
            .map_err(|e| format!("Failed to remove image from DB: {}", e))?;

        let _ = conn.execute("DELETE FROM album_images WHERE image_id = ?1", params![image_id]);
        let _ = conn.execute("DELETE FROM task_images WHERE image_id = ?1", params![image_id]);

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn batch_delete_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;

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
            let _ = tx.execute("DELETE FROM task_images WHERE image_id = ?1", params![id]);
        }

        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;

        self.invalidate_images_total_cache();

        Ok(())
    }

    pub fn batch_remove_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;

        for id in image_ids {
            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to remove image: {}", e))?;

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
            let _ = tx.execute("DELETE FROM task_images WHERE image_id = ?1", params![id]);
        }

        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;

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

    pub fn update_images_order(&self, image_orders: &[(String, i64)]) -> Result<(), String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;

        for (id, order) in image_orders {
            tx.execute(
                "UPDATE images SET \"order\" = ?1 WHERE id = ?2",
                params![order, id],
            )
            .map_err(|e| format!("Failed to update image order: {}", e))?;
        }

        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(())
    }

    pub fn pick_existing_gallery_image_id(&self, mode: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = match mode {
            "random" => "SELECT CAST(id AS TEXT) FROM images ORDER BY RANDOM() LIMIT 1",
            _ => "SELECT CAST(id AS TEXT) FROM images ORDER BY COALESCE(\"order\", crawled_at) ASC LIMIT 1",
        };

        let id: Option<String> = conn
            .query_row(sql, [], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Failed to pick image: {}", e))?;

        Ok(id)
    }
}
