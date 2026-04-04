use crate::emitter::GlobalEmitter;
use crate::storage::images::RangedImages;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfRecord {
    pub id: String,
    pub host: String,
    pub name: String,
    pub root_url: String,
    pub cookie: String,
    pub icon: Option<Vec<u8>>,
    pub last_visit_at: u64,
    pub download_count: i64,
    pub created_at: u64,
    pub last_image: Option<ImageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangedSurfRecords {
    pub records: Vec<SurfRecord>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Storage {
    pub fn get_or_create_surf_record(
        &self,
        host: &str,
        root_url: &str,
    ) -> Result<SurfRecord, String> {
        let host = host.trim().to_lowercase();
        if host.is_empty() {
            return Err("host 不能为空".to_string());
        }
        if let Some(existing) = self.get_surf_record_by_host(&host)? {
            return Ok(existing);
        }

        let root = root_url.trim();
        let root_url = if root.is_empty() {
            format!("https://{}", host)
        } else {
            root.to_string()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_secs();
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "INSERT INTO surf_records (id, host, root_url, icon, last_visit_at, download_count, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, 0, ?5)",
            params![id, host, root_url, ts as i64, ts as i64],
        )
        .map_err(|e| format!("Failed to create surf_record: {}", e))?;
        drop(conn);

        GlobalEmitter::global().emit_surf_records_change("created", &id);
        self.get_surf_record(&id)?
            .ok_or_else(|| "新建畅游记录后读取失败".to_string())
    }

    pub fn get_surf_record_by_host(&self, host: &str) -> Result<Option<SurfRecord>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT id, host, name, root_url, cookie, icon, last_visit_at, download_count, created_at
                 FROM surf_records
                 WHERE host = ?1
                 LIMIT 1",
                params![host],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<Vec<u8>>>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("Failed to query surf_record by host: {}", e))?;
        drop(conn);

        match row {
            Some((
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at,
                download_count,
                created_at,
            )) => {
                let last_image = self.find_latest_image_by_surf_record(&id)?;
                Ok(Some(SurfRecord {
                    id,
                    host,
                    name,
                    root_url,
                    cookie,
                    icon,
                    last_visit_at: last_visit_at as u64,
                    download_count,
                    created_at: created_at as u64,
                    last_image,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn get_surf_record(&self, id: &str) -> Result<Option<SurfRecord>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT id, host, name, root_url, cookie, icon, last_visit_at, download_count, created_at
                 FROM surf_records
                 WHERE id = ?1
                 LIMIT 1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<Vec<u8>>>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("Failed to query surf_record: {}", e))?;
        drop(conn);

        match row {
            Some((
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at,
                download_count,
                created_at,
            )) => {
                let last_image = self.find_latest_image_by_surf_record(&id)?;
                Ok(Some(SurfRecord {
                    id,
                    host,
                    name,
                    root_url,
                    cookie,
                    icon,
                    last_visit_at: last_visit_at as u64,
                    download_count,
                    created_at: created_at as u64,
                    last_image,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn list_surf_records(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<RangedSurfRecords, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM surf_records", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query surf_records total: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, host, name, root_url, cookie, icon, last_visit_at, download_count, created_at
                 FROM surf_records
                 ORDER BY last_visit_at DESC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| format!("Failed to prepare surf_records query: {}", e))?;
        let rows = stmt
            .query_map(params![limit as i64, offset as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<Vec<u8>>>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                ))
            })
            .map_err(|e| format!("Failed to query surf_records: {}", e))?;

        let mut raw = Vec::new();
        for row in rows {
            raw.push(row.map_err(|e| format!("Failed to read surf_record row: {}", e))?);
        }
        drop(stmt);
        drop(conn);

        let mut records = Vec::with_capacity(raw.len());
        for (id, host, name, root_url, cookie, icon, last_visit_at, download_count, created_at) in
            raw
        {
            records.push(SurfRecord {
                last_image: self.find_latest_image_by_surf_record(&id)?,
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at: last_visit_at as u64,
                download_count,
                created_at: created_at as u64,
            });
        }

        Ok(RangedSurfRecords {
            records,
            total,
            offset,
            limit,
        })
    }

    pub fn get_surf_records_with_images(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT sr.id, sr.host
                 FROM surf_records sr
                 WHERE EXISTS (
                   SELECT 1
                   FROM images i
                   WHERE i.surf_record_id = sr.id
                 )
                 ORDER BY sr.last_visit_at DESC",
            )
            .map_err(|e| format!("Failed to prepare surf records with images query: {}", e))?;

        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("Failed to query surf records with images: {}", e))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|e| format!("Failed to read surf record row: {}", e))?);
        }
        Ok(records)
    }

    pub fn get_surf_record_id_by_host(&self, host: &str) -> Result<Option<String>, String> {
        let host = host.trim().to_lowercase();
        if host.is_empty() {
            return Ok(None);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let id = conn
            .query_row(
                "SELECT id FROM surf_records WHERE host = ?1 LIMIT 1",
                params![host],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query surf record id by host: {}", e))?;
        Ok(id)
    }

    pub fn surf_record_exists(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM surf_records WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query surf record exists: {}", e))?;
        Ok(count > 0)
    }

    pub fn update_surf_record_visit(&self, id: &str) -> Result<(), String> {
        let ts = now_secs() as i64;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET last_visit_at = ?1 WHERE id = ?2",
            params![ts, id],
        )
        .map_err(|e| format!("Failed to update surf_record visit: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("visited", id);
        Ok(())
    }

    pub fn update_surf_record_icon(&self, id: &str, icon_bytes: &[u8]) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET icon = ?1 WHERE id = ?2",
            params![icon_bytes, id],
        )
        .map_err(|e| format!("Failed to update surf_record icon: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("icon-updated", id);
        Ok(())
    }

    pub fn increment_surf_record_download_count(&self, id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET download_count = download_count + 1 WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to increment surf_record download_count: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("downloaded", id);
        Ok(())
    }

    pub fn update_surf_record_root_url(&self, id: &str, root_url: &str) -> Result<(), String> {
        let root_url = root_url.trim();
        if root_url.is_empty() {
            return Err("root_url 不能为空".to_string());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET root_url = ?1 WHERE id = ?2",
            params![root_url, id],
        )
        .map_err(|e| format!("Failed to update surf_record root_url: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("updated", id);
        Ok(())
    }

    pub fn update_surf_record_name(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("Failed to update surf_record name: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("updated", id);
        Ok(())
    }

    pub fn update_surf_record_cookie(&self, id: &str, cookie: &str) -> Result<(), String> {
        let cookie = cookie.trim();
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE surf_records SET cookie = ?1 WHERE id = ?2",
            params![cookie, id],
        )
        .map_err(|e| format!("Failed to update surf_record cookie: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("cookie-updated", id);
        Ok(())
    }

    /// 删除遨游记录：将关联图片的 surf_record_id 置空后删除记录。
    pub fn delete_surf_record(&self, id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET surf_record_id = NULL WHERE surf_record_id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to clear images surf_record_id: {}", e))?;
        conn.execute("DELETE FROM surf_records WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete surf_record: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_records_change("deleted", id);
        Ok(())
    }

    pub fn get_surf_record_images(
        &self,
        surf_record_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<RangedImages, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE surf_record_id = ?1",
                params![surf_record_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query surf images total: {}", e))?;
        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata_id,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.width,
             images.height,
             images.display_name,
             COALESCE(images.type, 'image') as media_type,
             images.last_set_wallpaper_at,
             images.size
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             WHERE images.surf_record_id = ?1
             ORDER BY images.crawled_at DESC
             LIMIT ?2 OFFSET ?3",
            FAVORITE_ALBUM_ID
        );
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare surf images query: {}", e))?;
        let rows = stmt
            .query_map(
                params![surf_record_id, limit as i64, offset as i64],
                |row| {
                    let local_path: String = row.get(2)?;
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path: local_path.clone(),
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: Some(surf_record_id.to_string()),
                        crawled_at: row.get(5)?,
                        metadata: None,
                        metadata_id: row.get::<_, Option<i64>>(6)?,
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: row.get::<_, i64>(9)? != 0,
                        local_exists: PathBuf::from(&local_path).exists(),
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: crate::image_type::normalize_stored_media_type(
                            row.get::<_, Option<String>>(13)?,
                        ),
                        last_set_wallpaper_at: crate::storage::images::row_optional_u64_ts(
                            row, 14,
                        )?,
                        size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                    })
                },
            )
            .map_err(|e| format!("Failed to query surf images: {}", e))?;
        let mut images = Vec::new();
        for row in rows {
            images.push(row.map_err(|e| format!("Failed to read surf image row: {}", e))?);
        }

        Ok(RangedImages {
            images,
            total,
            offset,
            limit,
        })
    }

    pub fn find_latest_image_by_surf_record(
        &self,
        surf_record_id: &str,
    ) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let query = format!(
            "SELECT CAST(images.id AS TEXT) as id, images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, images.metadata_id,
             COALESCE(NULLIF(images.thumbnail_path, ''), images.local_path) as thumbnail_path,
             images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.width,
             images.height,
             images.display_name,
             COALESCE(images.type, 'image') as media_type,
             images.last_set_wallpaper_at,
             images.size
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             WHERE images.surf_record_id = ?1
             ORDER BY images.crawled_at DESC
             LIMIT 1",
            FAVORITE_ALBUM_ID
        );
        let result = conn
            .query_row(&query, params![surf_record_id], |row| {
                let local_path: String = row.get(2)?;
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get::<_, Option<String>>(1)?,
                    local_path: local_path.clone(),
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    surf_record_id: Some(surf_record_id.to_string()),
                    crawled_at: row.get(5)?,
                    metadata: None,
                    metadata_id: row.get::<_, Option<i64>>(6)?,
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists: PathBuf::from(&local_path).exists(),
                    width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                    display_name: row.get(12)?,
                    media_type: crate::image_type::normalize_stored_media_type(
                        row.get::<_, Option<String>>(13)?,
                    ),
                    last_set_wallpaper_at: crate::storage::images::row_optional_u64_ts(row, 14)?,
                    size: row.get::<_, Option<i64>>(15)?.map(|v| v as u64),
                })
            })
            .optional()
            .map_err(|e| format!("Failed to query latest surf image: {}", e))?;
        Ok(result)
    }
}
