use crate::emitter::GlobalEmitter;
use crate::local_folder::SyncMode;
#[cfg(feature = "ipc-server")]
use crate::storage::image_events::emit_membership_added;
use crate::storage::image_events::{emit_album_images_order_changed, AlbumImagesChangePayload};
use crate::storage::labels::{is_label_key, LabelSpec};
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use kabegame_i18n::t;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
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

/// 标签森林成员：目录（label_dir）或叶子（label）。
pub(crate) fn is_label_forest_kind(kind: &str) -> bool {
    matches!(kind, "label" | "label_dir")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub parent_id: Option<String>,
    /// "normal" | "local_folder" | "label" | "label_dir"（未来可扩展）
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
    /// kind 为 "label" 或 "label_dir" 时为 Some，用于插件定位与搜索
    pub label_key: Option<String>,
    /// 从标签森林根到自身的 key 链，格式为 `root/.../self`
    pub label_path: Option<String>,
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
        label_key: row.get(9)?,
        label_path: row.get(10)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToAlbumResult {
    pub added: usize,
    pub attempted: usize,
    pub can_add: usize,
    pub current_count: usize,
    #[serde(skip)]
    pub inserted_ids: Vec<String>,
    pub album_changes: Vec<AlbumImagesChangePayload>,
}

#[derive(Debug, Clone)]
pub struct EnsuredLabel {
    pub album_id: String,
    pub created: Vec<Album>,
}

#[derive(Debug, Clone)]
pub struct AppliedLabels {
    /// 实际新增了图片成员的标签叶子。
    pub album_ids: Vec<String>,
    /// 寻址失败而跳过的标签及原因；同批其它标签仍会继续处理。
    pub skipped: Vec<(LabelSpec, String)>,
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

    /// 批量图片当前所属的全部画册成员对；查询按 `album_images(image_id)` 索引执行。
    pub fn collect_album_memberships(
        &self,
        image_ids: &[String],
    ) -> Result<Vec<(String, String)>, String> {
        self.collect_album_memberships_with_paths(image_ids)
            .map(|(memberships, _)| memberships)
    }

    /// 批量图片当前所属的成员对及各画册祖先路径；两者在同一次数据库加锁中读取。
    pub fn collect_album_memberships_with_paths(
        &self,
        image_ids: &[String],
    ) -> Result<(Vec<(String, String)>, HashMap<String, String>), String> {
        if image_ids.is_empty() {
            return Ok((Vec::new(), HashMap::new()));
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut seen = HashSet::new();
        let mut memberships = Vec::new();
        let mut ancestor_paths = HashMap::new();
        let mut stmt = conn
            .prepare(
                "SELECT ai.album_id, COALESCE(a.ancestor_path, '/' || ai.album_id || '/')
                 FROM album_images ai
                 LEFT JOIN albums a ON a.id = ai.album_id
                 WHERE ai.image_id = ?1
                 ORDER BY ai.rowid",
            )
            .map_err(|e| format!("Failed to prepare album memberships query: {}", e))?;
        for id in image_ids {
            if !seen.insert(id.as_str()) {
                continue;
            }
            let rows = stmt
                .query_map(params![id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("Failed to query album memberships: {}", e))?;
            for row in rows {
                if let Ok((aid, ancestor_path)) = row {
                    ancestor_paths.entry(aid.clone()).or_insert(ancestor_path);
                    memberships.push((aid, id.clone()));
                }
            }
        }
        Ok((memberships, ancestor_paths))
    }

    pub fn get_image_album_ids(&self, image_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT album_id FROM album_images WHERE image_id = ?1 ORDER BY rowid")
            .map_err(|e| format!("Failed to prepare image album query: {e}"))?;
        let rows = stmt
            .query_map(params![image_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query image albums: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read image albums: {e}"))
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
                Some(kind) if is_label_forest_kind(kind) => {
                    return Err(t!("albums.errors.labelForestIsolated").to_string());
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
            label_key: None,
            label_path: None,
        };
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_added(&album);
        }
        Ok(album)
    }

    pub fn add_label_album(
        &self,
        key: &str,
        name: Option<&str>,
        parent_id: Option<&str>,
        directory: bool,
    ) -> Result<Album, String> {
        if !is_label_key(key) {
            return Err(t!("albums.errors.labelKeyInvalid").to_string());
        }
        let name = name.filter(|name| !name.trim().is_empty()).unwrap_or(key);
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let kind = if directory { "label_dir" } else { "label" };
        let album = Self::insert_label_album(&conn, key, name, parent_id, kind)?;
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_added(&album);
        }
        Ok(album)
    }

    pub fn set_label_key(&self, album_id: &str, new_key: &str) -> Result<(), String> {
        if !is_label_key(new_key) {
            return Err(t!("albums.errors.labelKeyInvalid").to_string());
        }
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;
        let (kind, parent_id): (String, Option<String>) = tx
            .query_row(
                "SELECT type, parent_id FROM albums WHERE id = ?1",
                params![album_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("Failed to query label album: {e}"))?
            .ok_or_else(|| "画册不存在".to_string())?;
        if !is_label_forest_kind(&kind) {
            return Err(t!("albums.errors.labelForestIsolated").to_string());
        }
        Self::ensure_label_key_unique_ci(&tx, new_key, parent_id.as_deref(), Some(album_id))?;
        tx.execute(
            "UPDATE albums SET label_key = ?1 WHERE id = ?2",
            params![new_key, album_id],
        )
        .map_err(|e| format!("Failed to update label key: {e}"))?;
        Self::rebuild_album_ancestor_paths(&tx)?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(album_id, json!({ "labelKey": new_key }));
        }
        Ok(())
    }

    pub fn ensure_label_path(&self, spec: &LabelSpec) -> Result<EnsuredLabel, String> {
        if !is_label_key(&spec.key)
            || spec.segments.is_empty()
            || spec.segments.iter().any(|segment| !is_label_key(segment))
        {
            return Err(t!("albums.errors.labelKeyInvalid").to_string());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;
        let mut parent_id: Option<String> = None;
        let mut created = Vec::new();

        for segment in &spec.segments {
            if let Some(existing) =
                Self::find_label_child_by_key_ci(&tx, parent_id.as_deref(), segment)?
            {
                if existing.kind != "label_dir" {
                    return Err(t!("albums.errors.labelKindConflict").to_string());
                }
                parent_id = Some(existing.id);
                continue;
            }
            let name =
                Self::resolve_new_label_name_ci(&tx, parent_id.as_deref(), segment, segment)?;
            let album =
                Self::insert_label_album(&tx, segment, &name, parent_id.as_deref(), "label_dir")?;
            parent_id = Some(album.id.clone());
            created.push(album);
        }

        let leaf = if let Some(existing) =
            Self::find_label_child_by_key_ci(&tx, parent_id.as_deref(), &spec.key)?
        {
            if existing.kind != "label" {
                return Err(t!("albums.errors.labelKindConflict").to_string());
            }
            existing
        } else {
            let requested_name = spec.name.as_deref().unwrap_or(&spec.key);
            let name = Self::resolve_new_label_name_ci(
                &tx,
                parent_id.as_deref(),
                requested_name,
                &spec.key,
            )?;
            let album =
                Self::insert_label_album(&tx, &spec.key, &name, parent_id.as_deref(), "label")?;
            created.push(album.clone());
            album
        };

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {e}"))?;
        Ok(EnsuredLabel {
            album_id: leaf.id,
            created,
        })
    }

    pub fn apply_labels_to_images(
        &self,
        specs: &[LabelSpec],
        image_ids: &[String],
    ) -> Result<AppliedLabels, String> {
        let mut album_ids = Vec::new();
        let mut skipped = Vec::new();
        let mut seen = HashSet::new();
        for spec in specs {
            let ensured = match self.ensure_label_path(spec) {
                Ok(ensured) => ensured,
                Err(error) => {
                    skipped.push((spec.clone(), error));
                    continue;
                }
            };
            if let Some(emitter) = GlobalEmitter::try_global() {
                for album in &ensured.created {
                    emitter.emit_album_added(album);
                }
            }
            let result = self.add_images_to_album(&ensured.album_id, image_ids)?;
            if result.added > 0 && seen.insert(ensured.album_id.clone()) {
                #[cfg(feature = "ipc-server")]
                if GlobalEmitter::try_global().is_some() {
                    emit_membership_added(&ensured.album_id, &result.inserted_ids)?;
                }
                album_ids.push(ensured.album_id);
            }
        }
        Ok(AppliedLabels { album_ids, skipped })
    }

    pub fn get_albums(&self, parent_id: Option<&str>) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = match parent_id {
            None => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path FROM albums WHERE parent_id IS NULL ORDER BY created_at ASC",
            ),
            Some(_) => conn.prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path FROM albums WHERE parent_id = ?1 ORDER BY created_at ASC",
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
            .prepare("SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path FROM albums ORDER BY created_at DESC")
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

        let deleted_album = self
            .get_album_by_id(album_id)?
            .ok_or_else(|| "画册不存在".to_string())?;
        let subtree_ids = self.collect_subtree_album_ids_bfs(album_id)?;
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
        // 子树内画册被删后，引用它们的定时任务不能再往已删画册写入，先把 output_album_id 置空。
        // 必须在 DELETE albums 之前执行：递归 CTE 依赖子树行仍然存在。
        conn.execute(
            "WITH RECURSIVE sub(id) AS (
                SELECT ?1
                UNION ALL
                SELECT a.id FROM albums a INNER JOIN sub ON a.parent_id = sub.id
            )
            UPDATE run_configs SET output_album_id = NULL WHERE output_album_id IN (SELECT id FROM sub)",
            params![album_id],
        )
        .map_err(|e| format!("Failed to clear run config output album: {}", e))?;
        conn.execute("DELETE FROM albums WHERE id = ?1", params![album_id])
            .map_err(|e| format!("Failed to delete album: {}", e))?;
        drop(conn);
        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_deleted(&deleted_album);
            for id in subtree_ids {
                emit_album_images_order_changed(&id, &[]);
            }
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

        let kind: Option<String> = tx
            .query_row(
                "SELECT type FROM albums WHERE id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query album type: {e}"))?;
        if kind.as_deref() == Some("label_dir") {
            return Err(t!("albums.errors.labelDirNoImages").to_string());
        }

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

        let mut inserted_ids = Vec::new();
        for id in image_ids {
            max_order += 1;
            let result = tx.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![album_id, id, max_order],
            );
            if let Ok(n) = result {
                if n > 0 {
                    inserted_ids.push(id.clone());
                }
            }
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        let added = inserted_ids.len();
        Ok(AddToAlbumResult {
            added,
            attempted: image_ids.len(),
            can_add: image_ids.len(),
            current_count: current_count + added,
            inserted_ids,
            album_changes: Vec::new(),
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
    ) -> Result<Vec<String>, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        let mut removed = Vec::new();
        for id in image_ids {
            let changed = tx
                .execute(
                    "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                    params![album_id, id],
                )
                .map_err(|e| format!("Failed to remove image from album: {}", e))?;
            if changed > 0 {
                removed.push(id.clone());
            }
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

    fn ensure_label_key_unique_ci(
        conn: &Connection,
        key: &str,
        parent_id: Option<&str>,
        exclude_album_id: Option<&str>,
    ) -> Result<(), String> {
        let count: i64 = match (parent_id, exclude_album_id) {
            (None, None) => conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE type IN ('label', 'label_dir') AND parent_id IS NULL AND LOWER(label_key) = LOWER(?1)",
                params![key],
                |row| row.get(0),
            ),
            (None, Some(exclude)) => conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE type IN ('label', 'label_dir') AND parent_id IS NULL AND LOWER(label_key) = LOWER(?1) AND id != ?2",
                params![key, exclude],
                |row| row.get(0),
            ),
            (Some(parent_id), None) => conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE type IN ('label', 'label_dir') AND parent_id = ?1 AND LOWER(label_key) = LOWER(?2)",
                params![parent_id, key],
                |row| row.get(0),
            ),
            (Some(parent_id), Some(exclude)) => conn.query_row(
                "SELECT COUNT(*) FROM albums WHERE type IN ('label', 'label_dir') AND parent_id = ?1 AND LOWER(label_key) = LOWER(?2) AND id != ?3",
                params![parent_id, key, exclude],
                |row| row.get(0),
            ),
        }
        .map_err(|e| format!("Failed to query label key uniqueness: {e}"))?;
        if count > 0 {
            return Err(t!("albums.errors.labelKeyExists").to_string());
        }
        Ok(())
    }

    fn insert_label_album(
        conn: &Connection,
        key: &str,
        name: &str,
        parent_id: Option<&str>,
        kind: &str,
    ) -> Result<Album, String> {
        if !is_label_forest_kind(kind) {
            return Err(t!("albums.errors.labelForestIsolated").to_string());
        }
        let (ancestor_prefix, label_prefix) = match parent_id {
            None => (String::new(), None),
            Some(parent_id) => {
                let parent: Option<(String, String, Option<String>)> = conn
                    .query_row(
                        "SELECT type, ancestor_path, label_path FROM albums WHERE id = ?1",
                        params![parent_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .map_err(|e| format!("Failed to verify label parent: {e}"))?;
                let Some((kind, ancestor_path, label_path)) = parent else {
                    return Err(t!("albums.errors.parentNotFound", id = parent_id).to_string());
                };
                if kind == "label" {
                    return Err(t!("albums.errors.labelLeafNoChildren").to_string());
                }
                if kind != "label_dir" {
                    return Err(t!("albums.errors.labelForestIsolated").to_string());
                }
                let label_path =
                    label_path.ok_or_else(|| "标签父画册缺少 label_path".to_string())?;
                (ancestor_path, Some(label_path))
            }
        };

        Self::ensure_label_key_unique_ci(conn, key, parent_id, None)?;
        Self::ensure_album_name_unique_ci(conn, name, parent_id, None)?;

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {e}"))?
            .as_secs();
        let ancestor_path = if ancestor_prefix.is_empty() {
            format!("/{id}/")
        } else {
            format!("{ancestor_prefix}{id}/")
        };
        let label_path = match label_prefix {
            Some(prefix) => format!("{prefix}/{key}"),
            None => key.to_string(),
        };
        conn.execute(
            "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, 'none', ?7, ?8)",
            params![id, name, created_at as i64, parent_id, kind, ancestor_path, key, label_path],
        )
        .map_err(|e| format!("Failed to add label album: {e}"))?;

        Ok(Album {
            id,
            name: name.to_string(),
            created_at,
            parent_id: parent_id.map(str::to_string),
            kind: kind.to_string(),
            sync_folder: None,
            folder_status: None,
            ancestor_path,
            sync_mode: SyncMode::None.as_str().to_string(),
            label_key: Some(key.to_string()),
            label_path: Some(label_path),
        })
    }

    fn find_label_child_by_key_ci(
        conn: &Connection,
        parent_id: Option<&str>,
        key: &str,
    ) -> Result<Option<Album>, String> {
        let sql = if parent_id.is_some() {
            "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path
               FROM albums
              WHERE type IN ('label', 'label_dir') AND parent_id = ?1 AND LOWER(label_key) = LOWER(?2)
              LIMIT 1"
        } else {
            "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path
               FROM albums
              WHERE type IN ('label', 'label_dir') AND parent_id IS NULL AND LOWER(label_key) = LOWER(?1)
              LIMIT 1"
        };
        let album = match parent_id {
            Some(parent_id) => conn
                .query_row(sql, params![parent_id, key], album_from_storage_row)
                .optional(),
            None => conn
                .query_row(sql, params![key], album_from_storage_row)
                .optional(),
        }
        .map_err(|e| format!("Failed to query label child: {e}"))?;
        Ok(album)
    }

    fn resolve_new_label_name_ci(
        conn: &Connection,
        parent_id: Option<&str>,
        requested_name: &str,
        key: &str,
    ) -> Result<String, String> {
        let mut candidates = vec![
            requested_name.to_string(),
            format!("{requested_name} ({key})"),
            key.to_string(),
        ];
        let mut seen = HashSet::new();
        candidates.retain(|candidate| seen.insert(candidate.to_lowercase()));
        for candidate in candidates {
            if !Self::scoped_album_name_exists_ci(conn, parent_id, &candidate, None)? {
                return Ok(candidate);
            }
        }
        for suffix in 2usize.. {
            let candidate = format!("{key} ({suffix})");
            if !Self::scoped_album_name_exists_ci(conn, parent_id, &candidate, None)? {
                return Ok(candidate);
            }
        }
        unreachable!("an unbounded numeric suffix always has an available value")
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

    /// 自顶向下重算全表 `albums.ancestor_path` 与标签画册的 `label_path`。
    /// 画册数量级小（几百至几千），全表重算换掉所有增量维护逻辑。
    pub(crate) fn rebuild_album_ancestor_paths(conn: &Connection) -> Result<(), String> {
        conn.execute(
            r#"
WITH RECURSIVE tree(id, path, lpath) AS (
    SELECT id, '/' || id || '/', CASE WHEN type IN ('label', 'label_dir') THEN label_key END
      FROM albums WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, tree.path || a.id || '/',
           CASE WHEN a.type IN ('label', 'label_dir') THEN tree.lpath || '/' || a.label_key END
      FROM albums a JOIN tree ON a.parent_id = tree.id
)
UPDATE albums SET ancestor_path = tree.path, label_path = tree.lpath
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
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path FROM albums WHERE id = ?1",
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
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status, ancestor_path, sync_mode, label_key, label_path
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

        // 普通画册不能挂在本地文件夹或标签画册下。只转子树时若保留这两类父级，
        // 会直接破坏画册树不变量；本地文件夹父级下还会在下一次递归同步时撞上同名画册。
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
            if matches!(
                parent_kind.as_deref(),
                Some("local_folder" | "label" | "label_dir")
            ) {
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
                    let parent_kind: Option<String> = tx
                        .query_row(
                            "SELECT type FROM albums WHERE id = ?1",
                            params![parent_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|e| format!("verify external parent: {e}"))?;
                    match parent_kind.as_deref() {
                        None => {
                            return Err(
                                t!("albums.errors.parentNotFound", id = parent_id).to_string()
                            );
                        }
                        Some(kind) if is_label_forest_kind(kind) => {
                            return Err(t!("albums.errors.labelForestIsolated").to_string());
                        }
                        _ => {}
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
                label_key: None,
                label_path: None,
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
            let album_is_label = is_label_forest_kind(&album.kind);
            let parent_is_label = is_label_forest_kind(&parent.kind);
            if album_is_label != parent_is_label {
                return Err(t!("albums.errors.labelForestIsolated").to_string());
            }
            if album_is_label && parent.kind == "label" {
                return Err(t!("albums.errors.labelLeafNoChildren").to_string());
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
        if is_label_forest_kind(&album.kind) {
            let key = album
                .label_key
                .as_deref()
                .ok_or_else(|| t!("albums.errors.labelKeyInvalid").to_string())?;
            Self::ensure_label_key_unique_ci(&conn, key, new_parent_id, Some(album_id))?;
        }

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

        let old_ancestor_path = album.ancestor_path.clone();
        Self::rebuild_album_ancestor_paths(&conn)?;
        let new_ancestor_path: String = conn
            .query_row(
                "SELECT ancestor_path FROM albums WHERE id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to read moved album ancestor path: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            emitter.emit_album_changed(
                album_id,
                json!({
                    "parentId": new_parent_id,
                    "ancestorPath": new_ancestor_path,
                    "oldAncestorPath": old_ancestor_path,
                }),
            );
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
    fn rebuild_album_ancestor_paths_tracks_label_add_move_and_key_change() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                r#"
INSERT INTO albums
    (id, name, created_at, parent_id, type, ancestor_path, sync_mode, label_key)
VALUES
    ('pixiv', 'Pixiv', 1, NULL, 'label_dir', '', 'none', 'pixiv'),
    ('character', '角色', 2, 'pixiv', 'label', '', 'none', 'character'),
    ('booru', 'Booru', 3, NULL, 'label_dir', '', 'none', 'booru');
"#,
            )
            .unwrap();
            Storage::rebuild_album_ancestor_paths(&conn).unwrap();
        }

        let character = storage.get_album_by_id("character").unwrap().unwrap();
        assert_eq!(character.label_path.as_deref(), Some("pixiv/character"));

        storage.move_album("character", Some("booru")).unwrap();
        let moved = storage.get_album_by_id("character").unwrap().unwrap();
        assert_eq!(moved.label_path.as_deref(), Some("booru/character"));

        {
            let conn = storage.db.lock().unwrap();
            conn.execute(
                "UPDATE albums SET label_key = 'person' WHERE id = 'character'",
                [],
            )
            .unwrap();
            Storage::rebuild_album_ancestor_paths(&conn).unwrap();
        }
        let renamed = storage.get_album_by_id("character").unwrap().unwrap();
        assert_eq!(renamed.label_key.as_deref(), Some("person"));
        assert_eq!(renamed.label_path.as_deref(), Some("booru/person"));
    }

    #[test]
    fn label_album_create_and_key_change_enforce_invariants() {
        let storage = test_storage();
        let root = storage
            .add_label_album("Root", Some("标签根"), None, true)
            .unwrap();
        let child = storage
            .add_label_album("Child", None, Some(&root.id), true)
            .unwrap();
        let grandchild = storage
            .add_label_album("Leaf", Some("叶子"), Some(&child.id), false)
            .unwrap();
        assert_eq!(child.name, "Child");
        assert_eq!(grandchild.label_path.as_deref(), Some("Root/Child/Leaf"));

        storage.set_label_key(&root.id, "renamed").unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&grandchild.id)
                .unwrap()
                .unwrap()
                .label_path
                .as_deref(),
            Some("renamed/Child/Leaf")
        );

        storage.add_label_album("Other", None, None, false).unwrap();
        assert!(storage.add_label_album("other", None, None, true).is_err());
        assert!(storage.set_label_key(&root.id, "OTHER").is_err());
        let arbitrary_name = storage
            .add_label_album("display", Some("任意 / 名称"), None, false)
            .unwrap();
        assert_eq!(arbitrary_name.name, "任意 / 名称");
        let default_name = storage
            .add_label_album("default-name", Some("  "), None, false)
            .unwrap();
        assert_eq!(default_name.name, "default-name");
        for key in ["bad.key", "bad/key", "bad,key", " bad", "bad  key", "中文"] {
            assert!(
                storage.add_label_album(key, None, None, false).is_err(),
                "{key}"
            );
            assert!(storage.set_label_key(&root.id, key).is_err(), "{key}");
        }

        assert!(storage.add_album("normal-child", Some(&root.id)).is_err());
        let normal = storage.add_album("normal", None).unwrap();
        assert!(storage
            .add_label_album("nested", None, Some(&normal.id), false)
            .is_err());
        assert!(storage
            .add_label_album("child-of-leaf", None, Some(&grandchild.id), false)
            .is_err());
    }

    #[test]
    fn move_album_keeps_label_forest_isolated_and_checks_keys() {
        let storage = test_storage();
        let normal = storage.add_album("normal", None).unwrap();
        let label_a = storage.add_label_album("a", None, None, true).unwrap();
        let label_b = storage.add_label_album("b", None, None, true).unwrap();
        let child_a = storage
            .add_label_album("same", Some("a-same"), Some(&label_a.id), false)
            .unwrap();
        storage
            .add_label_album("SAME", Some("b-same"), Some(&label_b.id), false)
            .unwrap();
        let leaf = storage
            .add_label_album("leaf", None, Some(&label_a.id), false)
            .unwrap();
        let movable_dir = storage
            .add_label_album("dir", None, Some(&label_b.id), true)
            .unwrap();

        assert!(storage.move_album(&normal.id, Some(&label_a.id)).is_err());
        assert!(storage.move_album(&label_a.id, Some(&normal.id)).is_err());
        assert!(storage.move_album(&child_a.id, Some(&label_b.id)).is_err());
        assert!(storage.move_album(&movable_dir.id, Some(&leaf.id)).is_err());
        assert_eq!(
            storage
                .get_album_by_id(&child_a.id)
                .unwrap()
                .unwrap()
                .parent_id,
            Some(label_a.id)
        );
    }

    fn label_spec(segments: &[&str], key: &str, name: Option<&str>) -> LabelSpec {
        LabelSpec {
            segments: segments.iter().map(|segment| segment.to_string()).collect(),
            key: key.to_string(),
            name: name.map(str::to_string),
        }
    }

    #[test]
    fn ensure_label_path_reuses_paths_and_resolves_name_collisions() {
        let storage = test_storage();
        let spec = label_spec(&["plugin", "character"], "miku", Some("初音未来"));
        let first = storage.ensure_label_path(&spec).unwrap();
        assert_eq!(first.created.len(), 3);
        assert_eq!(first.created[0].kind, "label_dir");
        assert_eq!(first.created[1].kind, "label_dir");
        assert_eq!(first.created[2].kind, "label");
        assert_eq!(
            storage
                .get_album_by_id(&first.album_id)
                .unwrap()
                .unwrap()
                .label_path
                .as_deref(),
            Some("plugin/character/miku")
        );
        let reused = storage
            .ensure_label_path(&label_spec(
                &["PLUGIN", "CHARACTER"],
                "MIKU",
                Some("不应改名"),
            ))
            .unwrap();
        assert_eq!(reused.album_id, first.album_id);
        assert!(reused.created.is_empty());
        assert_eq!(
            storage
                .get_album_by_id(&first.album_id)
                .unwrap()
                .unwrap()
                .name,
            "初音未来"
        );

        let c1 = storage.add_label_album("c1", None, None, true).unwrap();
        storage
            .add_label_album("occupied", Some("Pretty"), Some(&c1.id), false)
            .unwrap();
        let leaf = storage
            .ensure_label_path(&label_spec(&["c1"], "leaf", Some("Pretty")))
            .unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&leaf.album_id)
                .unwrap()
                .unwrap()
                .name,
            "Pretty (leaf)"
        );

        let c2 = storage.add_label_album("c2", None, None, true).unwrap();
        storage
            .add_label_album("occupied1", Some("Pretty"), Some(&c2.id), false)
            .unwrap();
        storage
            .add_label_album("occupied2", Some("Pretty (leaf)"), Some(&c2.id), false)
            .unwrap();
        let leaf = storage
            .ensure_label_path(&label_spec(&["c2"], "leaf", Some("Pretty")))
            .unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&leaf.album_id)
                .unwrap()
                .unwrap()
                .name,
            "leaf"
        );

        let c3 = storage.add_label_album("c3", None, None, true).unwrap();
        for (key, name) in [
            ("occupied1", "Pretty"),
            ("occupied2", "Pretty (leaf)"),
            ("occupied3", "leaf"),
        ] {
            storage
                .add_label_album(key, Some(name), Some(&c3.id), false)
                .unwrap();
        }
        let leaf = storage
            .ensure_label_path(&label_spec(&["c3"], "leaf", Some("Pretty")))
            .unwrap();
        assert_eq!(
            storage
                .get_album_by_id(&leaf.album_id)
                .unwrap()
                .unwrap()
                .name,
            "leaf (2)"
        );
    }

    #[test]
    fn apply_labels_and_delete_label_subtree_remove_memberships() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute(
                "INSERT INTO images (id, local_path, crawled_at) VALUES (1, '/tmp/label.jpg', 1)",
                [],
            )
            .unwrap();
        }
        let image_ids = vec!["1".to_string()];
        let applied = storage
            .apply_labels_to_images(
                &[
                    label_spec(&["plugin"], "first", None),
                    label_spec(&["plugin", "nested"], "second", None),
                ],
                &image_ids,
            )
            .unwrap();
        assert_eq!(applied.album_ids.len(), 2);
        assert!(applied.skipped.is_empty());
        let memberships = storage.get_image_album_ids("1").unwrap();
        assert_eq!(memberships.len(), 2);
        assert!(applied.album_ids.iter().all(|id| memberships.contains(id)));

        let root = storage
            .get_albums(None)
            .unwrap()
            .into_iter()
            .find(|album| album.label_key.as_deref() == Some("plugin"))
            .unwrap();
        storage.delete_album(&root.id).unwrap();
        assert!(storage.get_image_album_ids("1").unwrap().is_empty());
        assert!(storage
            .list_all_albums()
            .unwrap()
            .into_iter()
            .all(|album| !is_label_forest_kind(&album.kind)));
    }

    #[test]
    fn label_directory_rejects_images() {
        let storage = test_storage();
        let directory = storage.add_label_album("plugin", None, None, true).unwrap();
        let error = storage
            .add_images_to_album(&directory.id, &["1".to_string()])
            .unwrap_err();
        assert_eq!(error, t!("albums.errors.labelDirNoImages").to_string());
    }

    #[test]
    fn apply_labels_skips_kind_conflict_and_continues() {
        let storage = test_storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute(
                "INSERT INTO images (id, local_path, crawled_at) VALUES (1, '/tmp/label.jpg', 1)",
                [],
            )
            .unwrap();
        }
        storage
            .add_label_album("blocked", None, None, false)
            .unwrap();

        let applied = storage
            .apply_labels_to_images(
                &[
                    label_spec(&["blocked"], "skipped", None),
                    label_spec(&["valid"], "kept", None),
                ],
                &["1".to_string()],
            )
            .unwrap();

        assert_eq!(applied.skipped.len(), 1);
        assert_eq!(applied.skipped[0].0.key, "skipped");
        assert_eq!(applied.album_ids.len(), 1);
        assert_eq!(storage.get_image_album_ids("1").unwrap(), applied.album_ids);
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
    fn delete_album_clears_run_config_output_album_for_subtree() {
        let storage = test_storage();
        let root = storage.add_album("root", None).unwrap();
        let child = storage.add_album("child", Some(&root.id)).unwrap();
        let grandchild = storage.add_album("grandchild", Some(&child.id)).unwrap();
        let other = storage.add_album("other", None).unwrap();

        for (id, album_id) in [
            ("c-root", &root.id),
            ("c-child", &child.id),
            ("c-grandchild", &grandchild.id),
            ("c-other", &other.id),
        ] {
            storage
                .add_run_config(run_config_with_output_album(id, album_id))
                .unwrap();
        }

        // delete_album 末尾的 `emit_album_images_order_changed` 会调用 `Storage::global()`
        // （默认 feature 下 `GlobalEmitter::try_global()` 恒为 Some），而单测进程没有全局
        // Storage——既有的 `apply_labels_and_delete_label_subtree_remove_memberships`
        // 同样在这步 panic。该副作用发生在 `drop(conn)` 之后，落库结果已经生效，
        // 所以这里吞掉 panic，直接用连接断言清空结果。
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            storage.delete_album(&root.id)
        }));
        assert!(
            storage.get_album_by_id(&root.id).unwrap().is_none(),
            "根画册应已删除，说明落库在 panic 前完成"
        );

        let conn = storage.db.lock().unwrap();
        for id in ["c-root", "c-child", "c-grandchild"] {
            let album_id: Option<String> = conn
                .query_row(
                    "SELECT output_album_id FROM run_configs WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(album_id, None, "{id} 引用了被删子树的画册，应被置空");
        }
        let other_album: Option<String> = conn
            .query_row(
                "SELECT output_album_id FROM run_configs WHERE id = 'c-other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            other_album.as_deref(),
            Some(other.id.as_str()),
            "引用无关画册的配置不应受影响"
        );
    }

    fn run_config_with_output_album(id: &str, output_album_id: &str) -> crate::storage::RunConfig {
        crate::storage::RunConfig {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            plugin_id: "plugin".to_string(),
            url: "https://example.com".to_string(),
            output_dir: None,
            output_album_id: Some(output_album_id.to_string()),
            user_config: None,
            http_headers: None,
            max_concurrent_downloads: None,
            created_at: 1,
            schedule_enabled: false,
            schedule_spec: None,
            schedule_planned_at: None,
            schedule_last_run_at: None,
        }
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
