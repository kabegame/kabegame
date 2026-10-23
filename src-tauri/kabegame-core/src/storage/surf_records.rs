use crate::emitter::GlobalEmitter;
use crate::storage::Storage;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct SurfRecord {
    pub id: String,
    pub host: String,
    pub name: String,
    pub root_url: String,
    pub cookie: String,
    pub icon: Option<Vec<u8>>,
    pub last_visit_at: u64,
    pub created_at: u64,
    /// 安卓畅游是否以桌面版网站打开该站。只存模式不存 UA 串，UA 每次由系统默认 UA 派生。
    #[serde(default)]
    pub desktop_mode: bool,
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

fn update_surf_record_cookie_row_if_changed(
    conn: &Connection,
    id: &str,
    cookie: &str,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE surf_records SET cookie = ?1 WHERE id = ?2 AND cookie != ?1",
        params![cookie, id],
    )
    .map(|changed| changed > 0)
    .map_err(|e| format!("Failed to update surf_record cookie: {e}"))
}

fn update_surf_record_desktop_mode_row_if_changed(
    conn: &Connection,
    id: &str,
    enabled: bool,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE surf_records SET desktop_mode = ?1 WHERE id = ?2 AND desktop_mode != ?1",
        params![enabled, id],
    )
    .map(|changed| changed > 0)
    .map_err(|e| format!("Failed to update surf_record desktop_mode: {e}"))
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
            "INSERT INTO surf_records (id, host, root_url, icon, last_visit_at, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
            params![id, host, root_url, ts as i64, ts as i64],
        )
        .map_err(|e| format!("Failed to create surf_record: {}", e))?;
        drop(conn);

        let created = self
            .get_surf_record(&id)?
            .ok_or_else(|| "新建畅游记录后读取失败".to_string())?;
        if let Ok(v) = serde_json::to_value(&created) {
            GlobalEmitter::global().emit_surf_record_added(v);
        }
        Ok(created)
    }

    pub fn get_surf_record_by_host(&self, host: &str) -> Result<Option<SurfRecord>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT sr.id, sr.host, sr.name, sr.root_url, sr.cookie, sr.icon, sr.last_visit_at, sr.created_at, sr.desktop_mode
                 FROM surf_records sr
                 WHERE sr.host = ?1
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
                created_at,
                desktop_mode,
            )) => Ok(Some(SurfRecord {
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at: last_visit_at as u64,
                created_at: created_at as u64,
                desktop_mode: desktop_mode != 0,
            })),
            None => Ok(None),
        }
    }

    pub fn get_surf_record(&self, id: &str) -> Result<Option<SurfRecord>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row = conn
            .query_row(
                "SELECT sr.id, sr.host, sr.name, sr.root_url, sr.cookie, sr.icon, sr.last_visit_at, sr.created_at, sr.desktop_mode
                 FROM surf_records sr
                 WHERE sr.id = ?1
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
                created_at,
                desktop_mode,
            )) => Ok(Some(SurfRecord {
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at: last_visit_at as u64,
                created_at: created_at as u64,
                desktop_mode: desktop_mode != 0,
            })),
            None => Ok(None),
        }
    }

    /// 批量查询多个畅游记录，返回 id → SurfRecord 映射。
    pub fn get_surf_records_by_ids(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, SurfRecord>, String> {
        use std::collections::HashMap;
        let mut out: HashMap<String, SurfRecord> = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT sr.id, sr.host, sr.name, sr.root_url, sr.cookie, sr.icon, sr.last_visit_at, sr.created_at, sr.desktop_mode
             FROM surf_records sr WHERE sr.id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
        let params_iter: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(params_iter.as_slice(), |r| {
                Ok(SurfRecord {
                    id: r.get::<_, String>(0)?,
                    host: r.get::<_, String>(1)?,
                    name: r.get::<_, String>(2)?,
                    root_url: r.get::<_, String>(3)?,
                    cookie: r.get::<_, String>(4)?,
                    icon: r.get::<_, Option<Vec<u8>>>(5)?,
                    last_visit_at: r.get::<_, i64>(6)? as u64,
                    created_at: r.get::<_, i64>(7)? as u64,
                    desktop_mode: r.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(|e| format!("query: {}", e))?;
        for r in rows {
            let rec = r.map_err(|e| format!("row: {}", e))?;
            out.insert(rec.id.clone(), rec);
        }
        Ok(out)
    }

    pub fn list_surf_records(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<RangedSurfRecords, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM surf_records", [], |row| {
                row.get::<_, i64>(0).map(|count| count as usize)
            })
            .map_err(|e| format!("Failed to query surf_records total: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT sr.id, sr.host, sr.name, sr.root_url, sr.cookie, sr.icon, sr.last_visit_at, sr.created_at, sr.desktop_mode
                 FROM surf_records sr
                 ORDER BY sr.last_visit_at DESC
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
        for (id, host, name, root_url, cookie, icon, last_visit_at, created_at, desktop_mode) in raw {
            records.push(SurfRecord {
                id,
                host,
                name,
                root_url,
                cookie,
                icon,
                last_visit_at: last_visit_at as u64,
                created_at: created_at as u64,
                desktop_mode: desktop_mode != 0,
            });
        }

        Ok(RangedSurfRecords {
            records,
            total,
            offset,
            limit,
        })
    }

    pub fn list_all_surf_records(&self) -> Result<Vec<SurfRecord>, String> {
        Ok(self.list_surf_records(0, usize::MAX)?.records)
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
        GlobalEmitter::global().emit_surf_record_changed(id, json!({ "lastVisitAt": ts as u64 }));
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
        GlobalEmitter::global().emit_surf_record_changed(id, json!({ "iconChanged": true }));
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
        GlobalEmitter::global().emit_surf_record_changed(id, json!({ "rootUrl": root_url }));
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
        GlobalEmitter::global().emit_surf_record_changed(id, json!({ "name": name }));
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
        GlobalEmitter::global().emit_surf_record_changed(id, json!({ "cookie": cookie }));
        Ok(())
    }

    /// 仅在 Cookie 实际变化时写库并发 `SurfRecordChanged`；安卓内容页每次加载完成都会上报。
    pub fn update_surf_record_cookie_if_changed(
        &self,
        id: &str,
        cookie: &str,
    ) -> Result<(), String> {
        let cookie = cookie.trim();
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let changed = update_surf_record_cookie_row_if_changed(&conn, id, cookie)?;
        drop(conn);
        if changed {
            GlobalEmitter::global().emit_surf_record_changed(id, json!({ "cookie": cookie }));
        }
        Ok(())
    }

    /// 安卓畅游「桌面版网站」开关：值变化才写库并发 `SurfRecordChanged { desktopMode }`。
    pub fn set_surf_record_desktop_mode(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let changed = update_surf_record_desktop_mode_row_if_changed(&conn, id, enabled)?;
        drop(conn);
        if changed {
            GlobalEmitter::global()
                .emit_surf_record_changed(id, json!({ "desktopMode": enabled }));
        }
        Ok(())
    }

    /// 删除遨游记录：将关联图片的 surf_record_id 置空后删除记录。
    pub fn delete_surf_record(&self, id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let image_ids = {
            let mut stmt = conn
                .prepare("SELECT id FROM images WHERE surf_record_id = ?1 ORDER BY id")
                .map_err(|e| format!("Failed to prepare affected surf images query: {e}"))?;
            let rows = stmt
                .query_map(params![id], |row| {
                    let id = row.get_ref(0)?;
                    Ok(match id {
                        rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                        rusqlite::types::ValueRef::Text(value) => {
                            String::from_utf8_lossy(value).into_owned()
                        }
                        _ => String::new(),
                    })
                })
                .map_err(|e| format!("Failed to query affected surf images: {e}"))?;
            rows.filter(|row| row.as_ref().map_or(true, |id| !id.is_empty()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to collect affected surf images: {e}"))?
        };
        conn.execute(
            "UPDATE images SET surf_record_id = NULL WHERE surf_record_id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to clear images surf_record_id: {}", e))?;
        conn.execute("DELETE FROM surf_records WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete surf_record: {}", e))?;
        drop(conn);
        GlobalEmitter::global().emit_surf_record_deleted(id);
        GlobalEmitter::global().emit_image_fields(&image_ids, json!({ "surfRecordId": null }));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn update_cookie_only_writes_when_value_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE surf_records (id TEXT PRIMARY KEY, cookie TEXT NOT NULL DEFAULT '');
            INSERT INTO surf_records (id, cookie) VALUES ('surf-1', 'sid=old');",
        )
        .unwrap();

        assert!(!super::update_surf_record_cookie_row_if_changed(&conn, "surf-1", "sid=old").unwrap());
        assert!(super::update_surf_record_cookie_row_if_changed(&conn, "surf-1", "sid=new").unwrap());
        assert_eq!(
            conn.query_row("SELECT cookie FROM surf_records WHERE id = 'surf-1'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "sid=new"
        );
    }

    #[test]
    fn desktop_mode_only_writes_when_value_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE surf_records (
                 id TEXT PRIMARY KEY,
                 desktop_mode INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO surf_records (id) VALUES ('surf-1');",
        )
        .unwrap();

        assert!(
            !super::update_surf_record_desktop_mode_row_if_changed(&conn, "surf-1", false).unwrap()
        );
        assert!(
            super::update_surf_record_desktop_mode_row_if_changed(&conn, "surf-1", true).unwrap()
        );
        assert!(
            !super::update_surf_record_desktop_mode_row_if_changed(&conn, "surf-1", true).unwrap()
        );
        assert_eq!(
            conn.query_row(
                "SELECT desktop_mode FROM surf_records WHERE id = 'surf-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }
}
