use crate::storage::{Storage, FAVORITE_ALBUM_ID};
use rusqlite::params;
use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-runtime")]
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRemoveResult {
    pub removed: usize,
    pub removed_ids: Vec<String>,
    #[serde(default)]
    pub removed_ids_truncated: bool,
}

#[derive(Debug, Clone)]
pub struct DedupeCursor {
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct DedupeScanRow {
    pub id: String,
    pub hash: String,
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
}

impl DedupeScanRow {
    pub fn cursor(&self) -> DedupeCursor {
        DedupeCursor {
            is_favorite: self.is_favorite,
            sort_key: self.sort_key,
            crawled_at: self.crawled_at,
            id: self.id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesResult {
    pub inserted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesProgress {
    pub inserted: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct BaseImageRow {
    pub(crate) url: String,
    pub(crate) local_path: String,
    pub(crate) plugin_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) crawled_at: i64,
    pub(crate) metadata_json: Option<String>,
    pub(crate) thumbnail_path: String,
    pub(crate) hash: String,
    pub(crate) order: Option<i64>,
}

impl Storage {
    pub fn get_dedupe_total_hash_images_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: usize = conn
            .query_row("SELECT COUNT(*) FROM images WHERE hash != ''", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to query hash count: {}", e))?;
        Ok(count)
    }

    pub fn get_dedupe_batch(
        &self,
        cursor: Option<&DedupeCursor>,
        limit: usize,
    ) -> Result<Vec<DedupeScanRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let query = format!(
            "SELECT CAST(images.id AS TEXT), images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             COALESCE(images.\"order\", images.crawled_at) as sort_key,
             images.crawled_at
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             WHERE images.hash != ''
             {}
             ORDER BY is_favorite DESC, sort_key ASC, images.crawled_at ASC, images.id ASC
             LIMIT ?",
            FAVORITE_ALBUM_ID,
            if cursor.is_some() {
                "AND (is_favorite < ? OR (is_favorite = ? AND (sort_key > ? OR (sort_key = ? AND (images.crawled_at > ? OR (images.crawled_at = ? AND images.id > ?))))))"
            } else {
                ""
            }
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mapper = |row: &rusqlite::Row| {
            Ok(DedupeScanRow {
                id: row.get(0)?,
                hash: row.get(1)?,
                is_favorite: row.get(2)?,
                sort_key: row.get(3)?,
                crawled_at: row.get(4)?,
            })
        };

        let rows = if let Some(c) = cursor {
            stmt.query_map(
                params![
                    c.is_favorite,
                    c.is_favorite,
                    c.sort_key,
                    c.sort_key,
                    c.crawled_at,
                    c.crawled_at,
                    c.id,
                    limit as i64
                ],
                mapper,
            )
        } else {
            stmt.query_map(params![limit as i64], mapper)
        }
        .map_err(|e| format!("Failed to query dedupe batch: {}", e))?;

        let mut results: Vec<DedupeScanRow> = Vec::new();
        for r in rows {
            results.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(results)
    }

    pub fn dedupe_gallery_by_hash(&self, delete_files: bool) -> Result<DedupeRemoveResult, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut seen_hashes = std::collections::HashSet::new();
        let mut to_remove_ids = Vec::new();
        let mut to_remove_paths = Vec::new();

        {
            let mut stmt = conn
                .prepare(
                    "SELECT hash, CAST(id AS TEXT), local_path,
                     CASE WHEN EXISTS(SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ?1) THEN 1 ELSE 0 END as is_fav
                     FROM images
                     WHERE hash != ''
                     ORDER BY is_fav DESC, COALESCE(\"order\", crawled_at) ASC, crawled_at ASC, id ASC",
                )
                .map_err(|e| format!("Failed to prepare dedupe query: {}", e))?;

            let rows = stmt
                .query_map(params![FAVORITE_ALBUM_ID], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| format!("Failed to query images for dedupe: {}", e))?;

            for r in rows {
                let (hash, id, path) = r.map_err(|e| format!("Failed to read row: {}", e))?;
                if seen_hashes.contains(&hash) {
                    to_remove_ids.push(id);
                    to_remove_paths.push(path);
                } else {
                    seen_hashes.insert(hash);
                }
            }
        }

        if to_remove_ids.is_empty() {
            return Ok(DedupeRemoveResult {
                removed: 0,
                removed_ids: Vec::new(),
                removed_ids_truncated: false,
            });
        }

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        for id in &to_remove_ids {
            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete image: {}", e))?;
            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
            let _ = tx.execute("DELETE FROM task_images WHERE image_id = ?1", params![id]);
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        if delete_files {
            for path in to_remove_paths {
                let _ = std::fs::remove_file(path);
            }
        }

        self.invalidate_images_total_cache();

        let removed_ids_truncated = to_remove_ids.len() > 100;
        let mut removed_ids = to_remove_ids;
        if removed_ids_truncated {
            removed_ids.truncate(100);
        }

        Ok(DedupeRemoveResult {
            removed: removed_ids.len(),
            removed_ids,
            removed_ids_truncated,
        })
    }

    #[cfg(feature = "tauri-runtime")]
    pub fn debug_clone_images(
        &self,
        app: AppHandle,
        count: usize,
        pool_size: usize,
        seed: Option<u64>,
    ) -> Result<DebugCloneImagesResult, String> {
        use crate::storage::XorShift64;

        if count == 0 {
            return Ok(DebugCloneImagesResult { inserted: 0 });
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let pool_size = pool_size.clamp(1, 5000);
        let pool: Vec<BaseImageRow> = {
            let mut pool_stmt = conn
                .prepare(
                    "SELECT url, local_path, plugin_id, task_id, crawled_at, metadata,
                            COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, ''), \"order\"
                     FROM images
                     ORDER BY RANDOM()
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare pool query: {}", e))?;

            let rows = pool_stmt
                .query_map(params![pool_size as i64], |row| {
                    Ok(BaseImageRow {
                        url: row.get(0)?,
                        local_path: row.get(1)?,
                        plugin_id: row.get(2)?,
                        task_id: row.get(3)?,
                        crawled_at: row.get(4)?,
                        metadata_json: row.get(5)?,
                        thumbnail_path: row.get(6)?,
                        hash: row.get(7)?,
                        order: row.get(8)?,
                    })
                })
                .map_err(|e| format!("Failed to query pool: {}", e))?;

            let mut v = Vec::new();
            for r in rows {
                v.push(r.map_err(|e| format!("Failed to read pool row: {}", e))?);
            }
            v
        };
        if pool.is_empty() {
            return Err("数据库里没有任何图片记录，无法生成测试数据".to_string());
        }

        let default_seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let mut rng = XorShift64::new(seed.unwrap_or(default_seed));

        let total = count;
        let batch_size = 5000usize.min(total).max(1);
        let mut inserted = 0usize;

        while inserted < total {
            let cur = (total - inserted).min(batch_size);
            let tx = conn
                .transaction()
                .map_err(|e| format!("Failed to begin transaction: {}", e))?;

            {
                let mut insert_img = tx
                    .prepare(
                        "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, \"order\")
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    )
                    .map_err(|e| format!("Failed to prepare insert image: {}", e))?;

                let mut insert_task_img = tx
                    .prepare(
                        "INSERT OR REPLACE INTO task_images (task_id, image_id, added_at, \"order\")
                         VALUES (?1, ?2, ?3, ?4)",
                    )
                    .map_err(|e| format!("Failed to prepare insert task_images: {}", e))?;

                for _ in 0..cur {
                    let base = &pool[rng.gen_usize(pool.len())];

                    let thumbnail_path = if base.thumbnail_path.trim().is_empty() {
                        base.local_path.clone()
                    } else {
                        base.thumbnail_path.clone()
                    };

                    let jitter = (rng.next_u64() % 1_000_000) as i64;
                    let crawled_at = base.crawled_at.saturating_add(jitter);
                    let base_order = base.order.unwrap_or(base.crawled_at);
                    let order = base_order.saturating_add(jitter);

                    insert_img
                        .execute(params![
                            &base.url,
                            &base.local_path,
                            &base.plugin_id,
                            &base.task_id,
                            crawled_at,
                            &base.metadata_json,
                            thumbnail_path,
                            &base.hash,
                            order,
                        ])
                        .map_err(|e| format!("Failed to insert image (debug clone): {}", e))?;
                    let new_id = tx.last_insert_rowid();

                    if let Some(task_id) = base.task_id.as_ref() {
                        let added_at = crawled_at;
                        insert_task_img
                            .execute(params![task_id, new_id, added_at, order])
                            .map_err(|e| {
                                format!("Failed to insert task-image relation (debug clone): {}", e)
                            })?;
                    }
                }
            }

            tx.commit()
                .map_err(|e| format!("Failed to commit debug clone transaction: {}", e))?;

            inserted += cur;
            let _ = app.emit(
                "debug-clone-images-progress",
                DebugCloneImagesProgress { inserted, total },
            );
        }

        self.invalidate_images_total_cache();

        Ok(DebugCloneImagesResult { inserted })
    }
}
