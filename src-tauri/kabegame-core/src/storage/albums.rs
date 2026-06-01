use crate::emitter::GlobalEmitter;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use kabegame_i18n::t;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashSet, VecDeque},
    fs,
};

fn validate_album_name(name: &str) -> Result<&str, String> {
    let t = name.trim();
    if t.is_empty() {
        return Err("画册名称不能为空".to_string());
    }
    if t.contains('/') {
        return Err("画册名称不能包含 '/'".to_string());
    }
    Ok(t)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub parent_id: Option<String>,
    /// "normal" | "local_folder"（未来可扩展）
    #[serde(rename(serialize = "type"), alias = "type")]
    pub kind: String,
    /// 仅 kind=="local_folder" 时为 Some，存绝对路径
    pub sync_folder: Option<String>,
    /// 仅 kind=="local_folder" 时使用，JSON 字符串，Phase 2 起填充
    pub folder_status: Option<String>,
}

fn album_from_storage_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Album> {
    Ok(Album {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get::<_, i64>(2)? as u64,
        parent_id: row.get(3)?,
        kind: row.get(4)?,
        sync_folder: row.get(5)?,
        folder_status: row.get(6)?,
    })
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

    /// Guard user-facing write paths that mutate an album's image membership.
    ///
    /// Sync internals intentionally use the lower-level Storage APIs directly so a
    /// local folder album can still be reconciled from its source directory.
    pub fn ensure_album_is_writable(&self, album_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let kind: Option<String> = conn
            .query_row(
                "SELECT type FROM albums WHERE id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query album kind: {}", e))?;
        match kind.as_deref() {
            Some("local_folder") => Err(t!("albums.localFolderErrors.readOnly").to_string()),
            _ => Ok(()),
        }
    }

    /// 顺序壁纸轮播 marker 查询。给定 (album_id, image_id), 返回该图片在
    /// album_images 中的 `order` 值。Some(n) = 在画册里且 n 为 order；None = 不在画册。
    pub fn get_album_image_order(album_id: &str, image_id: &str) -> Result<Option<i64>, String> {
        if album_id.trim().is_empty() || image_id.trim().is_empty() {
            return Ok(None);
        }
        let path = format!(
            "images://gallery/album/{}/id_{}",
            urlencoding::encode(album_id.trim()),
            urlencoding::encode(image_id.trim())
        );
        Ok(crate::providers::images_at(&path)?
            .into_iter()
            .next()
            .and_then(|image| image.album_order))
    }

    /// 批量图片在删除/移除前涉及的画册 id（去重），用于 `images-change` 事件。
    pub fn collect_album_ids_for_images(
        &self,
        image_ids: &[String],
    ) -> Result<Vec<String>, String> {
        if image_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut set = HashSet::new();
        let mut stmt = conn
            .prepare("SELECT DISTINCT album_id FROM album_images WHERE image_id = ?1")
            .map_err(|e| format!("Failed to prepare album_ids query: {}", e))?;
        for id in image_ids {
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query album IDs: {}", e))?;
            for row in rows {
                if let Ok(aid) = row {
                    set.insert(aid);
                }
            }
        }
        Ok(set.into_iter().collect())
    }

    // 确保收藏文件夹存在，可以不用走provider
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
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL)",
                params![FAVORITE_ALBUM_ID, "收藏", created_at as i64],
            )
            .map_err(|e| format!("Failed to create default '收藏' album: {}", e))?;
        }

        Ok(())
    }

    /// 确保隐藏画册存在。名称采用 `hidden-{8hex}` 形式（取自 UUID v4 前 8 字符），
    /// 便于大模型通过 `hidden-` 前缀识别，同时几乎不会与用户自定义画册重名。
    /// 幂等：若记录已存在则不动（保留既有名称）。可以不用走provider
    pub fn ensure_hidden_album(&self) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![HIDDEN_ALBUM_ID],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query hidden album existence: {}", e))?;

        if !exists {
            let rand_suffix = uuid::Uuid::new_v4().simple().to_string();
            let name = format!("hidden-{}", &rand_suffix[..8]);
            let created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Time error: {}", e))?
                .as_secs();
            conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL)",
                params![HIDDEN_ALBUM_ID, name, created_at as i64],
            )
            .map_err(|e| format!("Failed to create hidden album: {}", e))?;
        }

        Ok(())
    }

    pub fn add_album(&self, name: &str, parent_id: Option<&str>) -> Result<Album, String> {
        let name_trimmed = validate_album_name(name)?;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(pid) = parent_id {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                    params![pid],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to verify parent album: {}", e))?;
            if !exists {
                return Err("父画册不存在".to_string());
            }
        }

        Self::ensure_album_name_unique_ci(&conn, name_trimmed, parent_id, None)?;

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();

        match parent_id {
            None => conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL)",
                params![id, name_trimmed, created_at as i64],
            ),
            Some(pid) => conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, ?4, 'normal', NULL, NULL)",
                params![id, name_trimmed, created_at as i64, pid],
            ),
        }
        .map_err(|e| format!("Failed to add album: {}", e))?;

        let album = Album {
            id: id.clone(),
            name: name_trimmed.to_string(),
            created_at,
            parent_id: parent_id.map(|s| s.to_string()),
            kind: "normal".to_string(),
            sync_folder: None,
            folder_status: None,
        };
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_added(
                &album.id,
                &album.name,
                album.created_at,
                album.parent_id.as_deref(),
            );
        }
        Ok(album)
    }

    pub fn get_albums(&self, parent_id: Option<&str>) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = match parent_id {
            None => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status FROM albums WHERE parent_id IS NULL ORDER BY created_at ASC",
            ),
            Some(_) => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status FROM albums WHERE parent_id = ?1 ORDER BY created_at ASC",
            ),
        }
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let album_rows = match parent_id {
            None => stmt.query_map([], album_from_storage_row),
            Some(pid) => stmt.query_map(params![pid], album_from_storage_row),
        }
        .map_err(|e| format!("Failed to query albums: {}", e))?;

        let mut albums = Vec::new();
        for row_result in album_rows {
            albums.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }

        Ok(albums)
    }

    /// 列出全部画册（含嵌套子画册），按 `created_at` 降序；供前端构建树与扁平列表。
    pub fn list_all_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, parent_id, type, sync_folder, folder_status FROM albums ORDER BY created_at DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], album_from_storage_row)
            .map_err(|e| format!("Failed to query albums: {}", e))?;
        let mut albums = Vec::new();
        for row_result in rows {
            albums.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(albums)
    }

    pub fn delete_album(&self, album_id: &str) -> Result<(), String> {
        if album_id == FAVORITE_ALBUM_ID || album_id == HIDDEN_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "WITH RECURSIVE sub(id) AS (
                SELECT ?1
                UNION ALL
                SELECT a.id FROM albums a INNER JOIN sub ON a.parent_id = sub.id
            )
            DELETE FROM album_images WHERE album_id IN (SELECT id FROM sub)",
            params![album_id],
        )
        .map_err(|e| format!("Failed to delete album images: {}", e))?;
        conn.execute("DELETE FROM albums WHERE id = ?1", params![album_id])
            .map_err(|e| format!("Failed to delete album: {}", e))?;
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_deleted(album_id);
        }
        Ok(())
    }

    pub fn rename_album(&self, album_id: &str, new_name: &str) -> Result<(), String> {
        if album_id == FAVORITE_ALBUM_ID || album_id == HIDDEN_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }

        let new_name_trimmed = validate_album_name(new_name)?;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let current_parent_id: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM albums WHERE id = ?1",
                params![album_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| format!("Failed to read album parent: {}", e))?
            .ok_or_else(|| "画册不存在".to_string())?;

        Self::ensure_album_name_unique_ci(
            &conn,
            new_name_trimmed,
            current_parent_id.as_deref(),
            Some(album_id),
        )?;

        conn.execute(
            "UPDATE albums SET name = ?1 WHERE id = ?2",
            params![new_name_trimmed, album_id],
        )
        .map_err(|e| format!("Failed to rename album: {}", e))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(album_id, json!({ "name": new_name_trimmed }));
        }
        Ok(())
    }

    /// 仅用于收藏画册的 i18n 名称同步（由 kabegame 在语言变更时调用）。仅更新名称并发送 album-changed，不校验“系统画册不可重命名”。
    pub fn set_favorite_album_name(&self, name: &str) -> Result<(), String> {
        let name_trimmed = name.trim();
        if name_trimmed.is_empty() {
            return Ok(());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let updated = conn
            .execute(
                "UPDATE albums SET name = ?1 WHERE id = ?2",
                params![name_trimmed, FAVORITE_ALBUM_ID],
            )
            .map_err(|e| format!("Failed to set favorite album name: {}", e))?;
        if updated > 0 {
            if let Some(emitter) = GlobalEmitter::try_global() {
                emitter.emit_album_changed(FAVORITE_ALBUM_ID, json!({ "name": name_trimmed }));
            }
        }
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
        crate::providers::images_at(&format!(
            "images://gallery/album/{}/order",
            urlencoding::encode(album_id)
        ))
    }

    fn collect_subtree_album_ids_bfs(&self, root_id: &str) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        let mut queue = VecDeque::new();
        queue.push_back(root_id.to_string());
        while let Some(id) = queue.pop_front() {
            out.push(id.clone());
            let children = self.get_albums(Some(&id))?;
            for ch in children {
                queue.push_back(ch.id);
            }
        }
        Ok(out)
    }

    /// 壁纸轮播等场景：取指定画册下的图片。`include_descendants` 为真时按 BFS（根在前，子画册按 `created_at`）合并子树内各 `album_images`，同一 `image_id` 只保留首次出现。画册不存在时返回 `画册不存在`。
    pub fn get_album_images_for_wallpaper_rotation(
        &self,
        album_id: &str,
        include_descendants: bool,
    ) -> Result<Vec<ImageInfo>, String> {
        if self.get_album_by_id(album_id)?.is_none() {
            return Err("画册不存在".to_string());
        }
        if !include_descendants {
            return self.get_album_images(album_id);
        }
        let order = self.collect_subtree_album_ids_bfs(album_id)?;
        let mut seen = HashSet::new();
        let mut merged = Vec::new();
        for aid in order {
            for img in self.get_album_images(&aid)? {
                if seen.insert(img.id.clone()) {
                    merged.push(img);
                }
            }
        }
        Ok(merged)
    }

    pub fn get_album_preview(
        &self,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<ImageInfo>, String> {
        crate::providers::album_preview_at(album_id, limit)
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

    pub(crate) fn ensure_album_name_unique_ci(
        conn: &Connection,
        new_name_trimmed: &str,
        parent_id: Option<&str>,
        exclude_album_id: Option<&str>,
    ) -> Result<(), String> {
        let count: i64 = match (parent_id, exclude_album_id) {
            (None, None) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1)",
                    params![new_name_trimmed],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (None, Some(ex)) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1) AND id != ?2",
                    params![new_name_trimmed, ex],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (Some(pid), None) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2)",
                    params![pid, new_name_trimmed],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (Some(pid), Some(ex)) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2) AND id != ?3",
                    params![pid, new_name_trimmed, ex],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
        };

        if count > 0 {
            return Err(t!("albums.errors.nameExists").to_string());
        }
        Ok(())
    }

    pub fn get_album_by_id(&self, id: &str) -> Result<Option<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status FROM albums WHERE id = ?1",
                params![id],
                album_from_storage_row,
            )
            .optional()
            .map_err(|e| format!("Failed to query album: {}", e))?;
        Ok(row)
    }

    pub fn update_album_folder_status(
        &self,
        album_id: &str,
        status_json: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        conn.execute(
            "UPDATE albums SET folder_status = ?1 WHERE id = ?2",
            params![status_json, album_id],
        )
        .map_err(|e| format!("update_album_folder_status: {e}"))?;
        Ok(())
    }

    pub fn list_local_folder_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status
                 FROM albums WHERE type = 'local_folder' ORDER BY created_at ASC",
            )
            .map_err(|e| format!("prepare list_local_folder_albums: {e}"))?;
        let rows = stmt
            .query_map([], album_from_storage_row)
            .map_err(|e| format!("query list_local_folder_albums: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_local_folder_albums: {e}"))
    }

    pub fn add_local_folder_albums_tx(
        &self,
        entries: &[crate::local_folder::create::NewLocalFolderEntry],
    ) -> Result<Vec<Album>, String> {
        if entries.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;

        let batch_ids: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        for entry in entries {
            if let Some(parent_id) = entry.parent_id.as_deref() {
                if !batch_ids.contains(parent_id) {
                    let exists: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                            params![parent_id],
                            |row| row.get(0),
                        )
                        .map_err(|e| format!("verify external parent: {e}"))?;
                    if !exists {
                        return Err(t!("albums.errors.parentNotFound", id = parent_id).to_string());
                    }
                }
            }
        }

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {e}"))?
            .as_secs();

        let mut created = Vec::with_capacity(entries.len());
        for entry in entries {
            Self::ensure_album_name_unique_ci(&tx, &entry.name, entry.parent_id.as_deref(), None)?;
            tx.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, ?4, 'local_folder', ?5, NULL)",
                params![
                    entry.id.as_str(),
                    entry.name.as_str(),
                    created_at as i64,
                    entry.parent_id.as_deref(),
                    entry.sync_folder.as_str(),
                ],
            )
            .map_err(|e| format!("insert local_folder album: {e}"))?;

            created.push(Album {
                id: entry.id.clone(),
                name: entry.name.clone(),
                created_at,
                parent_id: entry.parent_id.clone(),
                kind: "local_folder".to_string(),
                sync_folder: Some(entry.sync_folder.clone()),
                folder_status: None,
            });
        }

        tx.commit().map_err(|e| format!("commit: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            for album in &created {
                emitter.emit_album_added(
                    &album.id,
                    &album.name,
                    album.created_at,
                    album.parent_id.as_deref(),
                );
            }
        }

        Ok(created)
    }

    pub fn find_child_album_by_name_ci(
        &self,
        parent_id: Option<&str>,
        name: &str,
    ) -> Result<Option<String>, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let id: Option<String> = match parent_id {
            None => conn
                .query_row(
                    "SELECT id FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1) LIMIT 1",
                    params![trimmed],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query child album: {}", e))?,
            Some(pid) => conn
                .query_row(
                    "SELECT id FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
                    params![pid, trimmed],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query child album: {}", e))?,
        };
        Ok(id)
    }

    pub fn get_album_ancestors(&self, album_id: &str) -> Result<Vec<Album>, String> {
        let mut out = Vec::new();
        let mut cur_pid = self
            .get_album_by_id(album_id)?
            .ok_or_else(|| "画册不存在".to_string())?
            .parent_id;
        while let Some(pid) = cur_pid {
            let parent = self
                .get_album_by_id(&pid)?
                .ok_or_else(|| "父画册不存在".to_string())?;
            cur_pid = parent.parent_id.clone();
            out.push(parent);
        }
        out.reverse();
        Ok(out)
    }

    pub fn move_album(&self, album_id: &str, new_parent_id: Option<&str>) -> Result<(), String> {
        if album_id == FAVORITE_ALBUM_ID || album_id == HIDDEN_ALBUM_ID {
            return Err("不能移动系统默认画册".to_string());
        }
        if new_parent_id == Some(FAVORITE_ALBUM_ID) {
            return Err("不能将画册移动到收藏画册下".to_string());
        }
        if new_parent_id == Some(HIDDEN_ALBUM_ID) {
            return Err("不能将画册移动到隐藏画册下".to_string());
        }
        if let Some(pid) = new_parent_id {
            if pid == album_id {
                return Err("不能将画册移动到自身".to_string());
            }
            if !self.album_exists(pid)? {
                return Err("父画册不存在".to_string());
            }
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let would_cycle: bool = conn
                .query_row(
                    "WITH RECURSIVE sub(id) AS (
                        SELECT ?1
                        UNION ALL
                        SELECT a.id FROM albums a INNER JOIN sub s ON a.parent_id = s.id
                    )
                    SELECT EXISTS(SELECT 1 FROM sub WHERE id = ?2)",
                    params![album_id, pid],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to check move cycle: {}", e))?;
            if would_cycle {
                return Err("不能将画册移动到其子画册下".to_string());
            }
        }

        let album = self
            .get_album_by_id(album_id)?
            .ok_or_else(|| "画册不存在".to_string())?;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        Self::ensure_album_name_unique_ci(&conn, &album.name, new_parent_id, Some(album_id))?;

        match new_parent_id {
            None => conn.execute(
                "UPDATE albums SET parent_id = NULL WHERE id = ?1",
                params![album_id],
            ),
            Some(pid) => conn.execute(
                "UPDATE albums SET parent_id = ?1 WHERE id = ?2",
                params![pid, album_id],
            ),
        }
        .map_err(|e| format!("Failed to move album: {}", e))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(album_id, json!({ "parentId": new_parent_id }));
        }
        Ok(())
    }
}
