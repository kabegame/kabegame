use crate::emitter::GlobalEmitter;
use crate::local_folder::{FolderSyncService, SyncMode};
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use kabegame_i18n::t;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::PathBuf,
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
    /// 从根画册到自身的 id 链，格式为 `/root-id/.../self-id/`
    pub ancestor_path: String,
    /// 本地文件夹画册的逐画册同步状态
    pub sync_mode: String,
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
        ancestor_path: row.get(7)?,
        sync_mode: row.get(8)?,
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

#[derive(Debug)]
struct LocalFolderRechainRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    sync_path: PathBuf,
    created_at: i64,
}

#[derive(Debug)]
struct AlbumRechainChange {
    id: String,
    parent_id: Option<String>,
    name: Option<String>,
}

/// 修复本地文件夹画册同步状态不变量，并返回实际发生的 `(画册 id, 新状态)`。
pub(crate) fn normalize_local_folder_sync_modes(
    conn: &Connection,
) -> Result<Vec<(String, String)>, String> {
    let delegated_ids = {
        let mut stmt = conn
            .prepare(
                r#"
SELECT albums.id
  FROM albums
 WHERE albums.type = 'local_folder'
   AND albums.sync_mode <> 'delegated'
   AND EXISTS (
       SELECT 1
         FROM albums anc
        WHERE anc.type = 'local_folder'
          AND anc.sync_mode = 'recursive'
          AND anc.id <> albums.id
          AND substr(albums.ancestor_path, 1, length(anc.ancestor_path)) = anc.ancestor_path
   )
 ORDER BY albums.id
"#,
            )
            .map_err(|e| format!("prepare delegated sync mode normalization: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query delegated sync mode normalization: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read delegated sync mode normalization: {e}"))?
    };
    let none_ids = {
        let mut stmt = conn
            .prepare(
                r#"
SELECT albums.id
  FROM albums
 WHERE albums.type = 'local_folder'
   AND albums.sync_mode = 'delegated'
   AND NOT EXISTS (
       SELECT 1
         FROM albums anc
        WHERE anc.type = 'local_folder'
          AND anc.sync_mode = 'recursive'
          AND anc.id <> albums.id
          AND substr(albums.ancestor_path, 1, length(anc.ancestor_path)) = anc.ancestor_path
   )
 ORDER BY albums.id
"#,
            )
            .map_err(|e| format!("prepare none sync mode normalization: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query none sync mode normalization: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read none sync mode normalization: {e}"))?
    };

    conn.execute(
        r#"
UPDATE albums
   SET sync_mode = 'delegated'
 WHERE type = 'local_folder'
   AND sync_mode <> 'delegated'
   AND EXISTS (
       SELECT 1
         FROM albums anc
        WHERE anc.type = 'local_folder'
          AND anc.sync_mode = 'recursive'
          AND anc.id <> albums.id
          AND substr(albums.ancestor_path, 1, length(anc.ancestor_path)) = anc.ancestor_path
   )
"#,
        [],
    )
    .map_err(|e| format!("normalize delegated local folder sync modes: {e}"))?;
    conn.execute(
        r#"
UPDATE albums
   SET sync_mode = 'none'
 WHERE type = 'local_folder'
   AND sync_mode = 'delegated'
   AND NOT EXISTS (
       SELECT 1
         FROM albums anc
        WHERE anc.type = 'local_folder'
          AND anc.sync_mode = 'recursive'
          AND anc.id <> albums.id
          AND substr(albums.ancestor_path, 1, length(anc.ancestor_path)) = anc.ancestor_path
   )
"#,
        [],
    )
    .map_err(|e| format!("normalize none local folder sync modes: {e}"))?;

    Ok(delegated_ids
        .into_iter()
        .map(|id| (id, SyncMode::Delegated.as_str().to_string()))
        .chain(
            none_ids
                .into_iter()
                .map(|id| (id, SyncMode::None.as_str().to_string())),
        )
        .collect())
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
            pathql_rs::escape_path_segment(album_id.trim()),
            pathql_rs::escape_path_segment(image_id.trim())
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
            let ancestor_path = format!("/{FAVORITE_ALBUM_ID}/");
            conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path)
                 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL, ?4)",
                params![
                    FAVORITE_ALBUM_ID,
                    "收藏",
                    created_at as i64,
                    ancestor_path
                ],
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
            let ancestor_path = format!("/{HIDDEN_ALBUM_ID}/");
            conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path)
                 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL, ?4)",
                params![HIDDEN_ALBUM_ID, name, created_at as i64, ancestor_path],
            )
            .map_err(|e| format!("Failed to create hidden album: {}", e))?;
        }

        Ok(())
    }

    pub fn add_album(&self, name: &str, parent_id: Option<&str>) -> Result<Album, String> {
        let name_trimmed = validate_album_name(name)?;

        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(pid) = parent_id {
            let parent_kind: Option<String> = conn
                .query_row(
                    "SELECT type FROM albums WHERE id = ?1",
                    params![pid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to verify parent album: {}", e))?;
            match parent_kind.as_deref() {
                None => {
                    return Err(t!("albums.errors.parentNotFound", id = pid).to_string());
                }
                Some("local_folder") => {
                    return Err(t!("albums.errors.parentIsLocalFolder").to_string());
                }
                _ => {}
            }
        }

        Self::ensure_album_name_unique_ci(&conn, name_trimmed, parent_id, None)?;

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();
        let ancestor_path = Self::album_ancestor_path_of(&conn, parent_id, &id)?;

        conn.execute(
            "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
             VALUES (?1, ?2, ?3, ?4, 'normal', NULL, NULL, ?5, 'none')",
            params![
                id,
                name_trimmed,
                created_at as i64,
                parent_id,
                ancestor_path
            ],
        )
        .map_err(|e| format!("Failed to add album: {}", e))?;

        let album = Album {
            id: id.clone(),
            name: name_trimmed.to_string(),
            created_at,
            parent_id: parent_id.map(|s| s.to_string()),
            kind: "normal".to_string(),
            sync_folder: None,
            folder_status: None,
            ancestor_path,
            sync_mode: SyncMode::None.as_str().to_string(),
        };
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_added(&album);
        }
        Ok(album)
    }

    pub fn get_albums(&self, parent_id: Option<&str>) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = match parent_id {
            None => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode FROM albums WHERE parent_id IS NULL ORDER BY created_at ASC",
            ),
            Some(_) => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode FROM albums WHERE parent_id = ?1 ORDER BY created_at ASC",
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
            .prepare("SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode FROM albums ORDER BY created_at DESC")
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
                |row| row.get::<_, i64>(0).map(|count| count as usize),
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
            "images://gallery/album/{}/sort/by-album-order",
            pathql_rs::escape_path_segment(album_id)
        ))
    }

    /// 获取画册中的图片总数，用于固定任务分母。
    pub fn count_album_images(&self, album_id: &str) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        conn.query_row(
            "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
            params![album_id],
            |row| row.get::<_, i64>(0).map(|count| count as usize),
        )
        .map_err(|e| format!("Failed to count album images: {e}"))
    }

    /// 从画册头部获取一批图片 id。调用方删除 `album_images` 后可继续无游标读取。
    pub fn get_album_image_ids_batch(
        &self,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT image_id FROM album_images WHERE album_id = ?1 LIMIT ?2")
            .map_err(|e| format!("Failed to prepare album image batch: {e}"))?;
        let rows = stmt
            .query_map(params![album_id, limit as i64], |row| {
                Ok(row.get::<_, i64>(0)?.to_string())
            })
            .map_err(|e| format!("Failed to query album image batch: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read album image batch: {e}"))
    }

    /// 按 BFS 顺序收集某画册子树内的所有画册 id（含根）。根在前，子画册按 `created_at`。
    pub fn list_subtree_album_ids(&self, root_id: &str) -> Result<Vec<String>, String> {
        self.collect_subtree_album_ids_bfs(root_id)
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
        if Self::scoped_album_name_exists_ci(conn, parent_id, new_name_trimmed, exclude_album_id)? {
            return Err(t!("albums.errors.nameExists").to_string());
        }
        Ok(())
    }

    fn scoped_album_name_exists_ci(
        conn: &Connection,
        parent_id: Option<&str>,
        name: &str,
        exclude_album_id: Option<&str>,
    ) -> Result<bool, String> {
        let count: i64 = match (parent_id, exclude_album_id) {
            (None, None) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1)",
                    params![name],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (None, Some(ex)) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1) AND id != ?2",
                    params![name, ex],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (Some(pid), None) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2)",
                    params![pid, name],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
            (Some(pid), Some(ex)) => conn
                .query_row(
                    "SELECT COUNT(*) FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2) AND id != ?3",
                    params![pid, name, ex],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to query album name uniqueness: {}", e))?,
        };
        Ok(count > 0)
    }

    /// 在给定父级作用域内返回首个不发生大小写不敏感撞名的名称。
    pub(crate) fn resolve_scoped_name_ci(
        conn: &Connection,
        parent_id: Option<&str>,
        base: &str,
        exclude_album_id: Option<&str>,
    ) -> Result<String, String> {
        if !Self::scoped_album_name_exists_ci(conn, parent_id, base, exclude_album_id)? {
            return Ok(base.to_string());
        }
        for suffix in 2usize.. {
            let candidate = format!("{base} ({suffix})");
            if !Self::scoped_album_name_exists_ci(conn, parent_id, &candidate, exclude_album_id)? {
                return Ok(candidate);
            }
        }
        unreachable!("an unbounded numeric suffix always has an available value")
    }

    /// 自顶向下重算全表 `albums.ancestor_path`。
    /// 画册数量级小（几百至几千），全表重算换掉所有增量维护逻辑。
    pub(crate) fn rebuild_album_ancestor_paths(conn: &Connection) -> Result<(), String> {
        conn.execute(
            r#"
WITH RECURSIVE tree(id, path) AS (
    SELECT id, '/' || id || '/' FROM albums WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, tree.path || a.id || '/'
      FROM albums a JOIN tree ON a.parent_id = tree.id
)
UPDATE albums SET ancestor_path = tree.path
  FROM tree WHERE albums.id = tree.id
"#,
            [],
        )
        .map_err(|e| format!("rebuild_album_ancestor_paths: {e}"))?;
        Ok(())
    }

    pub(crate) fn album_ancestor_path_of(
        conn: &Connection,
        parent_id: Option<&str>,
        id: &str,
    ) -> Result<String, String> {
        let Some(parent_id) = parent_id else {
            return Ok(format!("/{id}/"));
        };
        let parent_path: String = conn
            .query_row(
                "SELECT ancestor_path FROM albums WHERE id = ?1",
                params![parent_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("album_ancestor_path_of parent={parent_id}: {e}"))?;
        Ok(format!("{parent_path}{id}/"))
    }

    pub fn get_album_by_id(&self, id: &str) -> Result<Option<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode FROM albums WHERE id = ?1",
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
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode
                 FROM albums WHERE type = 'local_folder' ORDER BY created_at ASC",
            )
            .map_err(|e| format!("prepare list_local_folder_albums: {e}"))?;
        let rows = stmt
            .query_map([], album_from_storage_row)
            .map_err(|e| format!("query list_local_folder_albums: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_local_folder_albums: {e}"))
    }

    pub fn set_album_sync_mode(&self, album_id: &str, mode: SyncMode) -> Result<(), String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("start set_album_sync_mode transaction: {e}"))?;

        let album: Option<(String, String)> = tx
            .query_row(
                "SELECT type, sync_mode FROM albums WHERE id = ?1",
                params![album_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("query album sync mode: {e}"))?;
        let Some((kind, current_mode)) = album else {
            return Err("画册不存在".to_string());
        };
        if kind != "local_folder" {
            return Err("只有本地文件夹画册可以设置同步模式".to_string());
        }
        if mode == SyncMode::Delegated {
            return Err("不能直接设置同步委托状态".to_string());
        }
        let current_mode = SyncMode::from_str(&current_mode)
            .ok_or_else(|| format!("画册同步模式无效: {current_mode}"))?;
        if current_mode == SyncMode::Delegated {
            return Err("同步委托画册不能自行设置同步模式".to_string());
        }

        tx.execute(
            "UPDATE albums SET sync_mode = ?1 WHERE id = ?2",
            params![mode.as_str(), album_id],
        )
        .map_err(|e| format!("update album sync mode: {e}"))?;
        let normalized = normalize_local_folder_sync_modes(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit set_album_sync_mode: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(album_id, json!({ "syncMode": mode.as_str() }));
            for (id, sync_mode) in normalized {
                emitter.emit_album_changed(&id, json!({ "syncMode": sync_mode }));
            }
        }
        Ok(())
    }

    /// 将本地文件夹画册及其全部后代原地转换为普通画册。
    pub fn convert_local_folder_album_to_normal(
        &self,
        album_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("start convert local folder album transaction: {e}"))?;

        let album: Option<(String, String, String, Option<String>, String)> = tx
            .query_row(
                "SELECT type, sync_mode, ancestor_path, parent_id, name FROM albums WHERE id = ?1",
                params![album_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("query local folder album conversion root: {e}"))?;
        let Some((kind, sync_mode, root_ancestor_path, root_parent_id, root_name)) = album else {
            return Err("画册不存在".to_string());
        };
        if kind != "local_folder" {
            return Err(t!("albums.localFolderErrors.notLocalFolder").to_string());
        }
        if sync_mode == SyncMode::Delegated.as_str() {
            return Err(t!("albums.localFolderErrors.delegatedConversion").to_string());
        }

        for task in FolderSyncService::global().snapshot() {
            if task.album_id == album_id {
                return Err(t!("albums.localFolderErrors.syncInProgress").to_string());
            }
            let running_ancestor_path: Option<String> = tx
                .query_row(
                    "SELECT ancestor_path FROM albums WHERE id = ?1",
                    params![task.album_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("query running folder sync album path: {e}"))?;
            if running_ancestor_path.is_some_and(|running_path| {
                running_path.starts_with(&root_ancestor_path)
                    || root_ancestor_path.starts_with(&running_path)
            }) {
                return Err(t!("albums.localFolderErrors.syncInProgress").to_string());
            }
        }

        let converted_ids = {
            let mut stmt = tx
                .prepare(
                    r#"
SELECT id
  FROM albums
 WHERE type = 'local_folder'
   AND substr(ancestor_path, 1, length(?1)) = ?1
 ORDER BY length(ancestor_path), id
"#,
                )
                .map_err(|e| format!("prepare local folder album conversion ids: {e}"))?;
            let rows = stmt
                .query_map(params![root_ancestor_path], |row| row.get::<_, String>(0))
                .map_err(|e| format!("query local folder album conversion ids: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("read local folder album conversion ids: {e}"))?
        };

        tx.execute(
            r#"
UPDATE albums
   SET type = 'normal', sync_folder = NULL, folder_status = NULL, sync_mode = 'none'
 WHERE type = 'local_folder'
   AND substr(ancestor_path, 1, length(?1)) = ?1
"#,
            params![root_ancestor_path],
        )
        .map_err(|e| format!("convert local folder album subtree: {e}"))?;

        // 普通画册不能挂在本地文件夹画册下（`add_album` 拒绝该组合，v029 迁移专门清理它）。
        // 只转子树时父级仍是 local_folder，若原地不动就会制造这种非法状态，并且父级下一次
        // 递归同步重建同名子画册时会撞上它，被迫改名成「X (2)」，两个画册指向同一个目录。
        // 照 v029 `lift_normal_albums_from_local_folders` 的语义：把子树根提到根级并解重名，
        // 子树内部父子关系保持不变（它们一起变 normal，内部组合是合法的）。
        let mut lifted: Option<(String, Option<String>)> = None;
        if let Some(parent_id) = root_parent_id.as_deref() {
            let parent_kind: Option<String> = tx
                .query_row(
                    "SELECT type FROM albums WHERE id = ?1",
                    params![parent_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("query converted album parent type: {e}"))?;
            if parent_kind.as_deref() == Some("local_folder") {
                let resolved = Self::resolve_scoped_name_ci(&tx, None, &root_name, Some(album_id))?;
                tx.execute(
                    "UPDATE albums SET parent_id = NULL, name = ?1 WHERE id = ?2",
                    params![resolved, album_id],
                )
                .map_err(|e| format!("lift converted album to root: {e}"))?;
                // parent_id 变了，整棵子树的 ancestor_path 必须重算。
                Self::rebuild_album_ancestor_paths(&tx)?;
                lifted = Some((
                    album_id.to_string(),
                    (resolved != root_name).then_some(resolved),
                ));
            }
        }

        let normalized = normalize_local_folder_sync_modes(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit local folder album conversion: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            for id in &converted_ids {
                emitter.emit_album_changed(
                    id,
                    json!({
                        "albumType": "normal",
                        "syncFolder": null,
                        "folderStatus": null,
                        "syncMode": "none",
                    }),
                );
            }
            if let Some((id, renamed)) = lifted {
                let payload = match renamed {
                    Some(name) => json!({ "parentId": null, "name": name }),
                    None => json!({ "parentId": null }),
                };
                emitter.emit_album_changed(&id, payload);
            }
            for (id, sync_mode) in normalized {
                emitter.emit_album_changed(&id, json!({ "syncMode": sync_mode }));
            }
        }

        Ok(converted_ids)
    }

    /// 按同步目录的最近真祖先重建本地文件夹画册层级。
    ///
    /// 路径可访问时优先使用 canonicalize 结果；离线目录退回词法路径比较。
    /// 所有数据库更新与 ancestor_path 重建在同一事务内完成，事件在提交后发出。
    pub fn rechain_local_folder_albums(&self) -> Result<Vec<String>, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut rows = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, parent_id, sync_folder, created_at
                       FROM albums
                      WHERE type = 'local_folder' AND sync_folder IS NOT NULL
                      ORDER BY created_at ASC, id ASC",
                )
                .map_err(|e| format!("prepare rechain_local_folder_albums: {e}"))?;
            let mapped = stmt
                .query_map([], |row| {
                    let raw_path = PathBuf::from(row.get::<_, String>(3)?);
                    let sync_path = fs::canonicalize(&raw_path)
                        .unwrap_or_else(|_| raw_path.components().collect());
                    Ok(LocalFolderRechainRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        parent_id: row.get(2)?,
                        sync_path,
                        created_at: row.get(4)?,
                    })
                })
                .map_err(|e| format!("query rechain_local_folder_albums: {e}"))?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("read rechain_local_folder_albums: {e}"))?
        };
        rows.sort_by(|a, b| {
            a.sync_path
                .components()
                .count()
                .cmp(&b.sync_path.components().count())
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });

        let desired_parents: Vec<(String, Option<String>)> = rows
            .iter()
            .map(|album| {
                let album_depth = album.sync_path.components().count();
                let parent = rows
                    .iter()
                    .filter(|candidate| {
                        let candidate_depth = candidate.sync_path.components().count();
                        candidate.id != album.id
                            && candidate_depth < album_depth
                            && album.sync_path.starts_with(&candidate.sync_path)
                    })
                    .max_by(|a, b| {
                        a.sync_path
                            .components()
                            .count()
                            .cmp(&b.sync_path.components().count())
                            .then_with(|| b.created_at.cmp(&a.created_at))
                            .then_with(|| b.id.cmp(&a.id))
                    })
                    .map(|candidate| candidate.id.clone());
                (album.id.clone(), parent)
            })
            .collect();

        let tx = conn
            .transaction()
            .map_err(|e| format!("start rechain_local_folder_albums transaction: {e}"))?;
        let mut changes = Vec::new();
        for (id, desired_parent) in desired_parents {
            let album = rows
                .iter()
                .find(|album| album.id == id)
                .expect("desired parent must refer to a loaded album");
            if album.parent_id == desired_parent {
                continue;
            }
            let resolved_name = Self::resolve_scoped_name_ci(
                &tx,
                desired_parent.as_deref(),
                &album.name,
                Some(&album.id),
            )?;
            tx.execute(
                "UPDATE albums SET name = ?1, parent_id = ?2 WHERE id = ?3",
                params![resolved_name, desired_parent.as_deref(), album.id],
            )
            .map_err(|e| format!("rechain local folder album {}: {e}", album.id))?;
            changes.push(AlbumRechainChange {
                id: album.id.clone(),
                parent_id: desired_parent,
                name: (resolved_name != album.name).then_some(resolved_name),
            });
        }
        if !changes.is_empty() {
            Self::rebuild_album_ancestor_paths(&tx)?;
        }
        let sync_mode_changes = normalize_local_folder_sync_modes(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit rechain_local_folder_albums: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            for change in &changes {
                let payload = match &change.name {
                    Some(name) => json!({ "parentId": change.parent_id, "name": name }),
                    None => json!({ "parentId": change.parent_id }),
                };
                emitter.emit_album_changed(&change.id, payload);
            }
            for (id, sync_mode) in &sync_mode_changes {
                emitter.emit_album_changed(id, json!({ "syncMode": sync_mode }));
            }
        }
        Ok(changes.into_iter().map(|change| change.id).collect())
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
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
                 VALUES (?1, ?2, ?3, ?4, 'local_folder', ?5, NULL, '', ?6)",
                params![
                    entry.id.as_str(),
                    entry.name.as_str(),
                    created_at as i64,
                    entry.parent_id.as_deref(),
                    entry.sync_folder.as_str(),
                    entry.sync_mode.as_str(),
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
                ancestor_path: String::new(),
                sync_mode: entry.sync_mode.as_str().to_string(),
            });
        }

        Self::rebuild_album_ancestor_paths(&tx)?;
        for album in &mut created {
            album.ancestor_path = tx
                .query_row(
                    "SELECT ancestor_path FROM albums WHERE id = ?1",
                    params![album.id.as_str()],
                    |row| row.get(0),
                )
                .map_err(|e| format!("read rebuilt ancestor_path for {}: {e}", album.id))?;
        }

        tx.commit().map_err(|e| format!("commit: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            for album in &created {
                emitter.emit_album_added(album);
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
        let album = self
            .get_album_by_id(album_id)?
            .ok_or_else(|| "画册不存在".to_string())?;
        if album.kind == "local_folder" {
            return Err(t!("albums.errors.cannotMoveLocalFolder").to_string());
        }
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
            let parent = self
                .get_album_by_id(pid)?
                .ok_or_else(|| t!("albums.errors.parentNotFound", id = pid).to_string())?;
            if parent.kind == "local_folder" {
                return Err(t!("albums.errors.cannotMoveIntoLocalFolder").to_string());
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

        Self::rebuild_album_ancestor_paths(&conn)?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(album_id, json!({ "parentId": new_parent_id }));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_folder::create::build_entries_non_recursive;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    fn test_storage() -> Storage {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::migrations::init::create_all_tables(&conn);
        Storage {
            db: Arc::new(Mutex::new(conn)),
            cached_images_total: Arc::new(Mutex::new(None)),
        }
    }

    fn add_local_folder(storage: &Storage, name: &str, path: &Path) -> Album {
        let entry = build_entries_non_recursive(name, path, None);
        storage
            .add_local_folder_albums_tx(&[entry])
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    #[test]
    fn move_and_rename_maintain_ancestor_paths() {
        let storage = test_storage();
        let a = storage.add_album("a", None).unwrap();
        let b = storage.add_album("b", Some(&a.id)).unwrap();
        let c = storage.add_album("c", Some(&b.id)).unwrap();

        assert_eq!(a.ancestor_path, format!("/{}/", a.id));
        assert_eq!(b.ancestor_path, format!("/{}/{}/", a.id, b.id));
        assert_eq!(c.ancestor_path, format!("/{}/{}/{}/", a.id, b.id, c.id));

        storage.move_album(&b.id, None).unwrap();
        let moved_b = storage.get_album_by_id(&b.id).unwrap().unwrap();
        let moved_c = storage.get_album_by_id(&c.id).unwrap().unwrap();
        assert_eq!(moved_b.ancestor_path, format!("/{}/", b.id));
        assert_eq!(moved_c.ancestor_path, format!("/{}/{}/", b.id, c.id));

        let b_path_before_rename = moved_b.ancestor_path;
        let c_path_before_rename = moved_c.ancestor_path;
        storage.rename_album(&b.id, "renamed-b").unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&b.id)
                .unwrap()
                .unwrap()
                .ancestor_path,
            b_path_before_rename
        );
        assert_eq!(
            storage
                .get_album_by_id(&c.id)
                .unwrap()
                .unwrap()
                .ancestor_path,
            c_path_before_rename
        );

        let d = storage.add_album("d", Some(&c.id)).unwrap();
        assert_eq!(d.ancestor_path, format!("/{}/{}/{}/", b.id, c.id, d.id));
    }

    #[test]
    fn rechain_uses_nearest_canonical_ancestor_and_is_idempotent() {
        let storage = test_storage();
        let temp = tempfile::tempdir().unwrap();
        let a_path = temp.path().join("A");
        let c_path = a_path.join("C");
        let e_path = c_path.join("E");
        fs::create_dir_all(&e_path).unwrap();

        let a = add_local_folder(&storage, "A", &a_path);
        let e = add_local_folder(&storage, "E", &e_path);
        assert_eq!(
            storage.rechain_local_folder_albums().unwrap(),
            vec![e.id.clone()]
        );
        assert_eq!(
            storage.get_album_by_id(&e.id).unwrap().unwrap().parent_id,
            Some(a.id.clone())
        );

        let c = add_local_folder(&storage, "C", &c_path);
        let mut changed = storage.rechain_local_folder_albums().unwrap();
        changed.sort();
        let mut expected = vec![c.id.clone(), e.id.clone()];
        expected.sort();
        assert_eq!(changed, expected);
        assert_eq!(
            storage.get_album_by_id(&c.id).unwrap().unwrap().parent_id,
            Some(a.id)
        );
        assert_eq!(
            storage.get_album_by_id(&e.id).unwrap().unwrap().parent_id,
            Some(c.id)
        );
        assert!(storage.rechain_local_folder_albums().unwrap().is_empty());
    }

    #[test]
    fn rechain_falls_back_to_lexical_paths_for_offline_folders() {
        let storage = test_storage();
        let temp = tempfile::tempdir().unwrap();
        let offline_root = temp.path().join("offline").join("A");
        let offline_child = offline_root.join("B");
        let root = add_local_folder(&storage, "offline-a", &offline_root);
        let child = add_local_folder(&storage, "offline-b", &offline_child);

        assert_eq!(
            storage.rechain_local_folder_albums().unwrap(),
            vec![child.id.clone()]
        );
        assert_eq!(
            storage
                .get_album_by_id(&child.id)
                .unwrap()
                .unwrap()
                .parent_id,
            Some(root.id)
        );
    }

    #[test]
    fn rechain_and_set_sync_mode_preserve_delegation_invariant() {
        let storage = test_storage();
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join("root");
        let child_path = root_path.join("child");
        let grandchild_path = child_path.join("grandchild");

        let root = add_local_folder(&storage, "root", &root_path);
        storage
            .set_album_sync_mode(&root.id, SyncMode::Recursive)
            .unwrap();

        let child = add_local_folder(&storage, "child", &child_path);
        let grandchild = add_local_folder(&storage, "grandchild", &grandchild_path);
        storage.rechain_local_folder_albums().unwrap();

        assert_eq!(
            storage
                .get_album_by_id(&child.id)
                .unwrap()
                .unwrap()
                .sync_mode,
            SyncMode::Delegated.as_str()
        );
        assert_eq!(
            storage
                .get_album_by_id(&grandchild.id)
                .unwrap()
                .unwrap()
                .sync_mode,
            SyncMode::Delegated.as_str()
        );
        assert_eq!(
            storage
                .set_album_sync_mode(&child.id, SyncMode::None)
                .unwrap_err(),
            "同步委托画册不能自行设置同步模式"
        );

        storage
            .set_album_sync_mode(&root.id, SyncMode::Shallow)
            .unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&child.id)
                .unwrap()
                .unwrap()
                .sync_mode,
            SyncMode::None.as_str()
        );
        assert_eq!(
            storage
                .get_album_by_id(&grandchild.id)
                .unwrap()
                .unwrap()
                .sync_mode,
            SyncMode::None.as_str()
        );
    }

    #[test]
    fn normalize_sync_modes_treats_album_id_wildcards_literally() {
        let storage = test_storage();
        let conn = storage.db.lock().unwrap();
        conn.execute_batch(
            r#"
INSERT INTO albums
    (id, name, created_at, type, sync_folder, ancestor_path, sync_mode)
VALUES
    ('root_%', 'root', 1, 'local_folder', '/root', '/root_%/', 'recursive'),
    ('actual', 'actual', 2, 'local_folder', '/root/actual', '/root_%/actual/', 'none'),
    ('imposter', 'imposter', 3, 'local_folder', '/imposter', '/root-AB/imposter/', 'none'),
    ('stale', 'stale', 4, 'local_folder', '/stale', '/stale/', 'delegated');
"#,
        )
        .unwrap();

        assert_eq!(
            normalize_local_folder_sync_modes(&conn).unwrap(),
            vec![
                ("actual".to_string(), "delegated".to_string()),
                ("stale".to_string(), "none".to_string()),
            ]
        );
        let imposter_mode: String = conn
            .query_row(
                "SELECT sync_mode FROM albums WHERE id = 'imposter'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(imposter_mode, SyncMode::None.as_str());
    }

    #[test]
    fn convert_local_folder_album_to_normal_converts_subtree_and_preserves_images() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                r#"
INSERT INTO albums
    (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
VALUES
    ('root', 'root', 1, NULL, 'local_folder', '/root', '{"state":"ok"}', '/root/', 'recursive'),
    ('child', 'child', 2, 'root', 'local_folder', '/root/child', '{"state":"ok"}', '/root/child/', 'delegated'),
    ('grandchild', 'grandchild', 3, 'child', 'local_folder', '/root/child/grandchild', '{"state":"ok"}', '/root/child/grandchild/', 'delegated');

INSERT INTO images (id, local_path, crawled_at)
VALUES
    (1, '/tmp/convert-root.jpg', 1),
    (2, '/tmp/convert-child.jpg', 2),
    (3, '/tmp/convert-grandchild.jpg', 3);

INSERT INTO album_images (album_id, image_id, "order")
VALUES ('root', 1, 1), ('child', 2, 1), ('grandchild', 3, 1);
"#,
            )
            .unwrap();
        }

        let associations_before = storage
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM album_images", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(
            storage
                .convert_local_folder_album_to_normal("root")
                .unwrap(),
            vec![
                "root".to_string(),
                "child".to_string(),
                "grandchild".to_string(),
            ]
        );

        let conn = storage.db.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT type, sync_folder, folder_status, sync_mode
                   FROM albums
                  WHERE id IN ('root', 'child', 'grandchild')
                  ORDER BY created_at",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("normal".to_string(), None, None, "none".to_string()),
                ("normal".to_string(), None, None, "none".to_string()),
                ("normal".to_string(), None, None, "none".to_string()),
            ]
        );
        let associations_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM album_images", [], |row| row.get(0))
            .unwrap();
        assert_eq!(associations_after, associations_before);
    }

    #[test]
    fn convert_local_folder_album_to_normal_lifts_subtree_out_of_local_folder_parent() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                r#"
INSERT INTO albums
    (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
VALUES
    ('root', 'root', 1, NULL, 'local_folder', '/root', NULL, '/root/', 'none'),
    ('child', 'child', 2, 'root', 'local_folder', '/root/child', NULL, '/root/child/', 'none'),
    ('grandchild', 'grandchild', 3, 'child', 'local_folder', '/root/child/gc', NULL, '/root/child/grandchild/', 'none');
-- 根级已有同名画册，上提时必须解重名
INSERT INTO albums (id, name, created_at, parent_id, type, ancestor_path, sync_mode)
VALUES ('other', 'child', 4, NULL, 'normal', '/other/', 'none');
"#,
            )
            .unwrap();
        }

        storage
            .convert_local_folder_album_to_normal("child")
            .unwrap();

        let conn = storage.db.lock().unwrap();
        let (parent_id, name, ancestor_path): (Option<String>, String, String) = conn
            .query_row(
                "SELECT parent_id, name, ancestor_path FROM albums WHERE id = 'child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        // 提到根级，不再挂在 local_folder 父下
        assert_eq!(parent_id, None);
        // 根级撞名 'child' → 解重名
        assert_ne!(name, "child");
        // parent_id 变了，ancestor_path 必须已重算
        assert_eq!(ancestor_path, "/child/");

        // 子树内部关系保持不变，且 ancestor_path 跟着重算
        let (gc_parent, gc_path): (Option<String>, String) = conn
            .query_row(
                "SELECT parent_id, ancestor_path FROM albums WHERE id = 'grandchild'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(gc_parent.as_deref(), Some("child"));
        assert_eq!(gc_path, "/child/grandchild/");

        // 没有普通画册残留在 local_folder 画册下（`add_album` 与 v029 都视其为非法）
        let illegal: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM albums c JOIN albums p ON p.id = c.parent_id
                  WHERE c.type = 'normal' AND p.type = 'local_folder'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(illegal, 0);
    }

    #[test]
    fn convert_local_folder_album_to_normal_keeps_root_level_album_in_place() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                r#"
INSERT INTO albums
    (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
VALUES
    ('root', 'root', 1, NULL, 'local_folder', '/root', NULL, '/root/', 'none'),
    ('child', 'child', 2, 'root', 'local_folder', '/root/child', NULL, '/root/child/', 'none');
"#,
            )
            .unwrap();
        }

        storage
            .convert_local_folder_album_to_normal("root")
            .unwrap();

        // 整棵树从根转换：根本来就在根级，不该被改名或改挂
        let conn = storage.db.lock().unwrap();
        let (parent_id, name): (Option<String>, String) = conn
            .query_row(
                "SELECT parent_id, name FROM albums WHERE id = 'root'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(parent_id, None);
        assert_eq!(name, "root");
        let child_parent: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM albums WHERE id = 'child'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(child_parent.as_deref(), Some("root"));
    }

    #[test]
    fn convert_local_folder_album_to_normal_rejects_delegated_album() {
        let storage = test_storage();
        let conn = storage.db.lock().unwrap();
        conn.execute(
            "INSERT INTO albums
                (id, name, created_at, type, sync_folder, ancestor_path, sync_mode)
             VALUES ('delegated', 'delegated', 1, 'local_folder', '/delegated', '/delegated/', 'delegated')",
            [],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            storage
                .convert_local_folder_album_to_normal("delegated")
                .unwrap_err(),
            t!("albums.localFolderErrors.delegatedConversion").to_string()
        );
    }

    #[test]
    fn convert_local_folder_album_to_normal_treats_wildcards_literally() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                r#"
INSERT INTO albums
    (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode)
VALUES
    ('root_%', 'root', 1, NULL, 'local_folder', '/root', '{"state":"root"}', '/root_%/', 'none'),
    ('child', 'child', 2, 'root_%', 'local_folder', '/root/child', '{"state":"child"}', '/root_%/child/', 'none'),
    ('imposter', 'imposter', 3, NULL, 'local_folder', '/imposter', '{"state":"imposter"}', '/root-AB/imposter/', 'shallow');
"#,
            )
            .unwrap();
        }

        assert_eq!(
            storage
                .convert_local_folder_album_to_normal("root_%")
                .unwrap(),
            vec!["root_%".to_string(), "child".to_string()]
        );
        let imposter = storage.get_album_by_id("imposter").unwrap().unwrap();
        assert_eq!(imposter.kind, "local_folder");
        assert_eq!(imposter.sync_folder.as_deref(), Some("/imposter"));
        assert_eq!(
            imposter.folder_status.as_deref(),
            Some(r#"{"state":"imposter"}"#)
        );
        assert_eq!(imposter.sync_mode, "shallow");
    }

    #[test]
    fn resolve_scoped_name_ci_uses_incrementing_case_insensitive_suffixes() {
        let storage = test_storage();
        storage.add_album("Name", None).unwrap();
        storage.add_album("name (2)", None).unwrap();
        let conn = storage.db.lock().unwrap();

        assert_eq!(
            Storage::resolve_scoped_name_ci(&conn, None, "name", None).unwrap(),
            "name (3)"
        );
    }

    #[test]
    fn local_folder_album_type_guards_reject_manual_tree_changes() {
        let storage = test_storage();
        let temp = tempfile::tempdir().unwrap();
        let local = add_local_folder(&storage, "local", temp.path());
        let normal = storage.add_album("normal", None).unwrap();

        assert_eq!(
            storage.add_album("child", Some(&local.id)).unwrap_err(),
            t!("albums.errors.parentIsLocalFolder").to_string()
        );
        assert_eq!(
            storage.move_album(&local.id, None).unwrap_err(),
            t!("albums.errors.cannotMoveLocalFolder").to_string()
        );
        assert_eq!(
            storage.move_album(&normal.id, Some(&local.id)).unwrap_err(),
            t!("albums.errors.cannotMoveIntoLocalFolder").to_string()
        );
    }
}
