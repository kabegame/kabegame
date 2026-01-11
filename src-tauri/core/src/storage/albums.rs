use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToAlbumResult {
    pub added: usize,
    pub attempted: usize,
    pub can_add: usize,
    pub current_count: usize,
}

#[derive(Debug, Clone)]
pub struct AlbumImageFsEntry {
    pub file_name: String,
    pub image_id: String,
    pub resolved_path: String,
}

impl Storage {
    pub fn get_album_name_by_id(&self, album_id: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let name: Option<String> = conn
            .query_row(
                "SELECT name FROM albums WHERE id = ?1 LIMIT 1",
                params![album_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query album name: {}", e))?;
        Ok(name)
    }

    pub fn album_exists(&self, album_id: &str) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to check album existence: {}", e))?;
        Ok(exists)
    }

    pub fn is_image_in_album(&self, album_id: &str, image_id: &str) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM album_images WHERE album_id = ?1 AND image_id = ?2)",
                params![album_id, image_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to check image in album: {}", e))?;
        Ok(exists)
    }

    pub fn pick_existing_album_image_id(
        &self,
        album_id: &str,
        mode: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = match mode {
            "random" => "SELECT CAST(image_id AS TEXT) FROM album_images WHERE album_id = ?1 ORDER BY RANDOM() LIMIT 1",
            _ => "SELECT CAST(image_id AS TEXT) FROM album_images WHERE album_id = ?1 ORDER BY COALESCE(\"order\", rowid) ASC LIMIT 1",
        };

        let id: Option<String> = conn
            .query_row(sql, params![album_id], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Failed to pick album image: {}", e))?;

        Ok(id)
    }

    pub fn ensure_favorite_album(&self) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![FAVORITE_ALBUM_ID],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query favorite album existence: {}", e))?;

        if !exists {
            let created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Time error: {}", e))?
                .as_secs();
            conn.execute(
                "INSERT INTO albums (id, name, created_at) VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, "收藏", created_at as i64],
            )
            .map_err(|e| format!("Failed to create default '收藏' album: {}", e))?;
        }

        Ok(())
    }

    pub fn add_album(&self, name: &str) -> Result<Album, String> {
        let name_trimmed = name.trim();
        if name_trimmed.is_empty() {
            return Err("画册名称不能为空".to_string());
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        Self::ensure_album_name_unique_ci(&conn, name_trimmed, None)?;

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();

        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(\"order\"), 0) FROM albums",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let order = max_order + 1;

        conn.execute(
            "INSERT INTO albums (id, name, created_at, \"order\") VALUES (?1, ?2, ?3, ?4)",
            params![id, name_trimmed, created_at as i64, order],
        )
        .map_err(|e| format!("Failed to add album: {}", e))?;

        Ok(Album {
            id,
            name: name_trimmed.to_string(),
            created_at,
            order: Some(order),
        })
    }

    pub fn get_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, \"order\" FROM albums ORDER BY \"order\" ASC, created_at ASC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let album_rows = stmt
            .query_map([], |row| {
                Ok(Album {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get::<_, i64>(2)? as u64,
                    order: row.get(3)?,
                })
            })
            .map_err(|e| format!("Failed to query albums: {}", e))?;

        let mut albums = Vec::new();
        for row_result in album_rows {
            albums.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(albums)
    }

    pub fn delete_album(&self, album_id: &str) -> Result<(), String> {
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM albums WHERE id = ?1", params![album_id])
            .map_err(|e| format!("Failed to delete album: {}", e))?;
        let _ = conn.execute(
            "DELETE FROM album_images WHERE album_id = ?1",
            params![album_id],
        );
        Ok(())
    }

    pub fn rename_album(&self, album_id: &str, new_name: &str) -> Result<(), String> {
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }

        let new_name_trimmed = new_name.trim();
        if new_name_trimmed.is_empty() {
            return Err("画册名称不能为空".to_string());
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        Self::ensure_album_name_unique_ci(&conn, new_name_trimmed, Some(album_id))?;

        conn.execute(
            "UPDATE albums SET name = ?1 WHERE id = ?2",
            params![new_name_trimmed, album_id],
        )
        .map_err(|e| format!("Failed to rename album: {}", e))?;
        Ok(())
    }

    pub fn find_album_id_by_name_ci(&self, name: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM albums WHERE LOWER(name) = LOWER(?1) LIMIT 1",
                params![name.trim()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query album by name: {}", e))?;
        Ok(id)
    }

    pub fn resolve_album_image_local_or_thumbnail_path(
        &self,
        album_id: &str,
        image_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT i.local_path, i.thumbnail_path
                 FROM images i
                 INNER JOIN album_images ai ON i.id = ai.image_id
                 WHERE ai.album_id = ?1 AND i.id = ?2",
                params![album_id, image_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("Failed to resolve image path: {}", e))?;
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

    pub fn get_album_images_fs_entries(
        &self,
        album_id: &str,
    ) -> Result<Vec<AlbumImageFsEntry>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(i.id AS TEXT), i.local_path, i.thumbnail_path, i.url
                 FROM images i
                 INNER JOIN album_images ai ON i.id = ai.image_id
                 WHERE ai.album_id = ?1
                 ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![album_id], |row| {
                let id: String = row.get(0)?;
                let local_path: String = row.get(1)?;
                let thumb_path: String = row.get(2)?;
                let _url: String = row.get(3)?;

                let resolved_path =
                    if !local_path.trim().is_empty() && fs::metadata(&local_path).is_ok() {
                        Some(local_path.clone())
                    } else if !thumb_path.trim().is_empty() && fs::metadata(&thumb_path).is_ok() {
                        Some(thumb_path.clone())
                    } else {
                        None
                    };

                let Some(resolved_path) = resolved_path else {
                    return Ok(None);
                };

                // 扩展名优先使用原图，若不存在则回退到实际文件路径
                let ext_source = if !local_path.trim().is_empty() {
                    &local_path
                } else {
                    &resolved_path
                };
                let ext = std::path::Path::new(ext_source)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("jpg");

                let file_name = format!("{}.{}", id, ext);

                Ok(Some(AlbumImageFsEntry {
                    file_name,
                    image_id: id,
                    resolved_path,
                }))
            })
            .map_err(|e| format!("Failed to query album images for FS: {}", e))?;

        let mut entries = Vec::new();
        for r in rows {
            if let Some(entry) = r.map_err(|e| format!("Failed to read row: {}", e))? {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    pub fn add_images_to_album(
        &self,
        album_id: &str,
        image_ids: &[String],
    ) -> Result<AddToAlbumResult, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        let current_count: usize = tx
            .query_row(
                "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut max_order: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(\"order\"), 0) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut added = 0;
        for id in image_ids {
            max_order += 1;
            let result = tx.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![album_id, id, max_order],
            );
            if let Ok(n) = result {
                if n > 0 {
                    added += 1;
                }
            }
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(AddToAlbumResult {
            added,
            attempted: image_ids.len(),
            can_add: image_ids.len(),
            current_count: current_count + added,
        })
    }

    pub fn add_images_to_album_silent(&self, album_id: &str, image_ids: &[String]) -> usize {
        self.add_images_to_album(album_id, image_ids)
            .map(|r| r.added)
            .unwrap_or(0)
    }

    pub fn remove_images_from_album(
        &self,
        album_id: &str,
        image_ids: &[String],
    ) -> Result<usize, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        let mut removed = 0usize;
        for id in image_ids {
            let changed = tx
                .execute(
                    "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![album_id, id],
                )
                .map_err(|e| format!("Failed to remove image from album: {}", e))?;
            removed += changed as usize;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(removed)
    }

    pub fn get_album_images(&self, album_id: &str) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 i.\"order\"
                 FROM images i
                 INNER JOIN album_images ai ON i.id = ai.image_id
                 WHERE ai.album_id = ?1
                 ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![album_id], |row| {
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
                    favorite: album_id == FAVORITE_ALBUM_ID,
                    local_exists: true,
                    order: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query album images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            let mut img = row_result.map_err(|e| format!("Failed to read row: {}", e))?;
            if album_id != FAVORITE_ALBUM_ID {
                let is_fav = conn
                    .query_row(
                        "SELECT COUNT(*) FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                        params![FAVORITE_ALBUM_ID, img.id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
                    > 0;
                img.favorite = is_fav;
            }
            images.push(img);
        }

        Ok(images)
    }

    pub fn get_album_preview(
        &self,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 i.\"order\"
                 FROM images i
                 INNER JOIN album_images ai ON i.id = ai.image_id
                 WHERE ai.album_id = ?1
                 ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC
                 LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![album_id, limit as i64], |row| {
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
                    favorite: album_id == FAVORITE_ALBUM_ID,
                    local_exists: true,
                    order: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query album preview: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(images)
    }

    pub fn get_album_image_ids(&self, album_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT CAST(image_id AS TEXT) FROM album_images WHERE album_id = ?1 ORDER BY COALESCE(\"order\", rowid) ASC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![album_id], |row| row.get(0))
            .map_err(|e| format!("Failed to query album image IDs: {}", e))?;

        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(ids)
    }

    pub fn get_album_counts(&self) -> Result<HashMap<String, usize>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT album_id, COUNT(*) FROM album_images GROUP BY album_id")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })
            .map_err(|e| format!("Failed to query album counts: {}", e))?;

        let mut counts = HashMap::new();
        for r in rows {
            let (id, count) = r.map_err(|e| format!("Failed to read row: {}", e))?;
            counts.insert(id, count);
        }
        Ok(counts)
    }

    pub fn update_album_images_order(
        &self,
        album_id: &str,
        image_orders: &[(String, i64)],
    ) -> Result<(), String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        for (id, order) in image_orders {
            tx.execute(
                "UPDATE album_images SET \"order\" = ?1 WHERE album_id = ?2 AND image_id = ?3",
                params![order, album_id, id],
            )
            .map_err(|e| format!("Failed to update album image order: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(())
    }

    pub fn update_albums_order(&self, album_orders: &[(String, i64)]) -> Result<(), String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        for (id, order) in album_orders {
            tx.execute(
                "UPDATE albums SET \"order\" = ?1 WHERE id = ?2",
                params![order, id],
            )
            .map_err(|e| format!("Failed to update album order: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(())
    }

    pub(crate) fn ensure_album_name_unique_ci(
        conn: &Connection,
        new_name_trimmed: &str,
        exclude_album_id: Option<&str>,
    ) -> Result<(), String> {
        let count: i64 = if let Some(exclude_id) = exclude_album_id {
            conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE LOWER(name) = LOWER(?1) AND id != ?2",
                params![new_name_trimmed, exclude_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE LOWER(name) = LOWER(?1)",
                params![new_name_trimmed],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?
        };

        if count > 0 {
            return Err("画册名称已存在，请换一个名称".to_string());
        }
        Ok(())
    }
}
