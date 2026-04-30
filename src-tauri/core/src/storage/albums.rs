use crate::emitter::GlobalEmitter;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub parent_id: Option<String>,
}

fn album_from_storage_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Album> {
    Ok(Album {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get::<_, i64>(2)? as u64,
        parent_id: row.get(3)?,
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

    /// 7b S1e S4-b: 顺序壁纸轮播 marker 查询。给定 (album_id, image_id), 返回该图片在
    /// album_images 中的 `order` 值。Some(n) = 在画册里且 n 为 order；None = 不在画册。
    pub fn get_album_image_order(
        &self,
        album_id: &str,
        image_id: &str,
    ) -> Result<Option<i64>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT \"order\" FROM album_images WHERE album_id = ?1 AND image_id = ?2",
            params![album_id, image_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query album image order: {}", e))
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
                "INSERT INTO albums (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, NULL)",
                params![FAVORITE_ALBUM_ID, "收藏", created_at as i64],
            )
            .map_err(|e| format!("Failed to create default '收藏' album: {}", e))?;
        }

        Ok(())
    }

    /// 确保隐藏画册存在。名称采用 `hidden-{8hex}` 形式（取自 UUID v4 前 8 字符），
    /// 便于大模型通过 `hidden-` 前缀识别，同时几乎不会与用户自定义画册重名。
    /// 幂等：若记录已存在则不动（保留既有名称）。
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
                "INSERT INTO albums (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, NULL)",
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
                "INSERT INTO albums (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, NULL)",
                params![id, name_trimmed, created_at as i64],
            ),
            Some(pid) => conn.execute(
                "INSERT INTO albums (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, ?4)",
                params![id, name_trimmed, created_at as i64, pid],
            ),
        }
        .map_err(|e| format!("Failed to add album: {}", e))?;

        let album = Album {
            id: id.clone(),
            name: name_trimmed.to_string(),
            created_at,
            parent_id: parent_id.map(|s| s.to_string()),
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
                "SELECT id, name, created_at, parent_id FROM albums WHERE parent_id IS NULL ORDER BY created_at ASC",
            ),
            Some(pid) => conn.prepare(
                "SELECT id, name, created_at, parent_id FROM albums WHERE parent_id = ?1 ORDER BY created_at ASC",
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
            .prepare("SELECT id, name, created_at, parent_id FROM albums ORDER BY created_at DESC")
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

    /// 仅用于收藏画册的 i18n 名称同步（由 app-main 在语言变更时调用）。仅更新名称并发送 album-changed，不校验“系统画册不可重命名”。
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
            "/gallery/album/{}/order",
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

    // TODO: 改为前端计算，后端只需要返回各画册下图片数量即可
    /// 每个画册的图片总数 = 该画册内直接关联的图片数 + 所有子画册（递归）的图片总数。
    pub fn get_album_counts(&self) -> Result<HashMap<String, usize>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut direct: HashMap<String, usize> = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT album_id, COUNT(*) FROM album_images GROUP BY album_id")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })
            .map_err(|e| format!("Failed to query album counts: {}", e))?;
        for r in rows {
            let (id, count) = r.map_err(|e| format!("Failed to read row: {}", e))?;
            direct.insert(id, count);
        }

        let mut children: HashMap<Option<String>, Vec<String>> = HashMap::new();
        let mut all_ids: Vec<String> = Vec::new();
        let mut stmt2 = conn
            .prepare("SELECT id, parent_id FROM albums")
            .map_err(|e| format!("Failed to prepare album tree: {}", e))?;
        let rows2 = stmt2
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| format!("Failed to query albums: {}", e))?;
        for r in rows2 {
            let (id, parent_id) = r.map_err(|e| format!("Failed to read row: {}", e))?;
            all_ids.push(id.clone());
            children.entry(parent_id).or_default().push(id);
        }

        fn recursive_total(
            id: &str,
            children: &HashMap<Option<String>, Vec<String>>,
            direct: &HashMap<String, usize>,
            memo: &mut HashMap<String, usize>,
        ) -> usize {
            if let Some(&v) = memo.get(id) {
                return v;
            }
            let mut sum = *direct.get(id).unwrap_or(&0);
            if let Some(kids) = children.get(&Some(id.to_string())) {
                for kid in kids {
                    sum += recursive_total(kid, children, direct, memo);
                }
            }
            memo.insert(id.to_string(), sum);
            sum
        }

        let mut memo = HashMap::new();
        for id in &all_ids {
            recursive_total(id, &children, &direct, &mut memo);
        }
        Ok(memo)
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
            return Err("画册名称已存在，请换一个名称".to_string());
        }
        Ok(())
    }

    pub fn get_album_by_id(&self, id: &str) -> Result<Option<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT id, name, created_at, parent_id FROM albums WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Album {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        created_at: row.get::<_, i64>(2)? as u64,
                        parent_id: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("Failed to query album: {}", e))?;
        Ok(row)
    }

    pub fn get_album_image_count(&self, album_id: &str) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count album images: {}", e))?;
        Ok(n as usize)
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
