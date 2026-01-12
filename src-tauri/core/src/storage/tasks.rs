use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::storage::{Storage, FAVORITE_ALBUM_ID, ImageInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "outputDir")]
    pub output_dir: Option<String>,
    #[serde(rename = "userConfig")]
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "httpHeaders")]
    pub http_headers: Option<HashMap<String, String>>,
    #[serde(rename = "outputAlbumId")]
    pub output_album_id: Option<String>,
    pub status: String,
    pub progress: f64,
    #[serde(rename = "deletedCount")]
    pub deleted_count: i64,
    #[serde(rename = "startTime")]
    pub start_time: Option<u64>,
    #[serde(rename = "endTime")]
    pub end_time: Option<u64>,
    pub error: Option<String>,
    #[serde(rename = "rhaiDumpPresent", default)]
    pub rhai_dump_present: bool,
    #[serde(rename = "rhaiDumpConfirmed", default)]
    pub rhai_dump_confirmed: bool,
    #[serde(rename = "rhaiDumpCreatedAt", default)]
    pub rhai_dump_created_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFailedImage {
    pub id: i64,
    pub task_id: String,
    pub plugin_id: String,
    pub url: String,
    pub order: i64,
    pub created_at: i64,
    pub last_error: Option<String>,
    pub last_attempted_at: Option<i64>,
}

impl Storage {
    pub fn add_task(&self, task: TaskInfo) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let user_config_json = serde_json::to_string(&task.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;
        let http_headers_json = serde_json::to_string(&task.http_headers)
            .map_err(|e| format!("Failed to serialize http headers: {}", e))?;

        conn.execute(
            "INSERT INTO tasks (id, plugin_id, output_dir, user_config, http_headers, output_album_id, status, progress, start_time, end_time, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                task.id,
                task.plugin_id,
                task.output_dir,
                user_config_json,
                http_headers_json,
                task.output_album_id,
                task.status,
                task.progress,
                task.start_time.map(|t| t as i64),
                task.end_time.map(|t| t as i64),
                task.error,
            ],
        )
        .map_err(|e| format!("Failed to add task: {}", e))?;
        Ok(())
    }

    pub fn update_task(&self, task: TaskInfo) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE tasks SET status = ?1, progress = ?2, start_time = ?3, end_time = ?4, error = ?5, deleted_count = ?6, output_album_id = ?7 WHERE id = ?8",
            params![
                task.status,
                task.progress,
                task.start_time.map(|t| t as i64),
                task.end_time.map(|t| t as i64),
                task.error,
                task.deleted_count,
                task.output_album_id,
                task.id,
            ],
        )
        .map_err(|e| format!("Failed to update task: {}", e))?;
        Ok(())
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let task: Option<TaskInfo> = conn
            .query_row(
                "SELECT id, plugin_id, output_dir, user_config, http_headers, status, progress, start_time, end_time, error, output_album_id, deleted_count,
                 rhai_dump_json IS NOT NULL as dump_present, rhai_dump_confirmed, rhai_dump_created_at
                 FROM tasks WHERE id = ?1",
                params![task_id],
                |row| {
                    let user_config_json: Option<String> = row.get(3)?;
                    let user_config = user_config_json
                        .and_then(|s| serde_json::from_str(&s).ok());
                    let http_headers_json: Option<String> = row.get(4)?;
                    let http_headers = http_headers_json
                        .and_then(|s| serde_json::from_str(&s).ok());
                    Ok(TaskInfo {
                        id: row.get(0)?,
                        plugin_id: row.get(1)?,
                        output_dir: row.get(2)?,
                        user_config,
                        http_headers,
                        status: row.get(5)?,
                        progress: row.get(6)?,
                        start_time: row.get::<_, Option<i64>>(7)?.map(|t| t as u64),
                        end_time: row.get::<_, Option<i64>>(8)?.map(|t| t as u64),
                        error: row.get(9)?,
                        output_album_id: row.get(10)?,
                        deleted_count: row.get(11)?,
                        rhai_dump_present: row.get(12)?,
                        rhai_dump_confirmed: row.get::<_, i64>(13)? != 0,
                        rhai_dump_created_at: row.get::<_, Option<i64>>(14)?.map(|t| t as u64),
                    })
                },
            )
            .optional()
            .map_err(|e| format!("Failed to query task: {}", e))?;
        Ok(task)
    }

    pub fn get_all_tasks(&self) -> Result<Vec<TaskInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, plugin_id, output_dir, user_config, http_headers, status, progress, start_time, end_time, error, output_album_id, deleted_count,
                      rhai_dump_json IS NOT NULL as dump_present, rhai_dump_confirmed, rhai_dump_created_at
                      FROM tasks ORDER BY start_time DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let task_rows = stmt
            .query_map([], |row| {
                let user_config_json: Option<String> = row.get(3)?;
                let user_config = user_config_json
                    .and_then(|s| serde_json::from_str(&s).ok());
                let http_headers_json: Option<String> = row.get(4)?;
                let http_headers = http_headers_json
                    .and_then(|s| serde_json::from_str(&s).ok());
                Ok(TaskInfo {
                    id: row.get(0)?,
                    plugin_id: row.get(1)?,
                    output_dir: row.get(2)?,
                    user_config,
                    http_headers,
                    status: row.get(5)?,
                    progress: row.get(6)?,
                    start_time: row.get::<_, Option<i64>>(7)?.map(|t| t as u64),
                    end_time: row.get::<_, Option<i64>>(8)?.map(|t| t as u64),
                    error: row.get(9)?,
                    output_album_id: row.get(10)?,
                    deleted_count: row.get(11)?,
                    rhai_dump_present: row.get(12)?,
                    rhai_dump_confirmed: row.get::<_, i64>(13)? != 0,
                    rhai_dump_created_at: row.get::<_, Option<i64>>(14)?.map(|t| t as u64),
                })
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut tasks = Vec::new();
        for row_result in task_rows {
            tasks.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(tasks)
    }

    pub fn mark_pending_running_tasks_as_failed(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count = conn
            .execute(
                "UPDATE tasks SET status = 'failed', error = '应用异常退出，任务已中断' WHERE status IN ('pending', 'running')",
                [],
            )
            .map_err(|e| format!("Failed to mark tasks as failed: {}", e))?;
        Ok(count)
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete task: {}", e))?;
        let _ = conn.execute("DELETE FROM task_images WHERE task_id = ?1", params![task_id]);
        let _ = conn.execute("DELETE FROM task_failed_images WHERE task_id = ?1", params![task_id]);
        Ok(())
    }

    /// 获取“有图片”的任务 ID 列表（用于 TaskGroupProvider）
    pub fn get_task_ids_with_images(&self) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id
                 FROM tasks t
                 WHERE EXISTS (SELECT 1 FROM task_images ti WHERE ti.task_id = t.id)
                 ORDER BY COALESCE(t.start_time, 0) DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query task ids: {}", e))?;

        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(ids)
    }

    /// 获取“有图片”的任务 (id + plugin_id)（用于 VD 在目录名中显示插件名/ID）。
    pub fn get_tasks_with_images(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.plugin_id
                 FROM tasks t
                 WHERE EXISTS (SELECT 1 FROM task_images ti WHERE ti.task_id = t.id)
                 ORDER BY COALESCE(t.start_time, 0) DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let plugin_id: String = row.get(1)?;
                Ok((id, plugin_id))
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(out)
    }

    pub fn clear_finished_tasks(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count = conn
            .execute(
                "DELETE FROM tasks WHERE status IN ('completed', 'failed', 'cancelled')",
                [],
            )
            .map_err(|e| format!("Failed to clear finished tasks: {}", e))?;
        Ok(count)
    }

    pub fn add_task_failed_image(
        &self,
        task_id: &str,
        plugin_id: &str,
        url: &str,
        order: i64,
        error: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "INSERT INTO task_failed_images (task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![task_id, plugin_id, url, order, now, error, now],
        )
        .map_err(|e| format!("Failed to add failed image: {}", e))?;
        Ok(())
    }

    pub fn update_task_failed_image_attempt(
        &self,
        id: i64,
        error: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "UPDATE task_failed_images SET last_error = ?1, last_attempted_at = ?2 WHERE id = ?3",
            params![error, now, id],
        )
        .map_err(|e| format!("Failed to update failed image: {}", e))?;
        Ok(())
    }

    pub fn delete_task_failed_image(&self, id: i64) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM task_failed_images WHERE id = ?1", params![id])
            .map_err(|_e| format!("Failed to delete failed image: {}", id))?;
        Ok(())
    }

    pub fn get_task_failed_images(&self, task_id: &str) -> Result<Vec<TaskFailedImage>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at FROM task_failed_images WHERE task_id = ?1 ORDER BY \"order\" ASC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![task_id], |row| {
                Ok(TaskFailedImage {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    plugin_id: row.get(2)?,
                    url: row.get(3)?,
                    order: row.get(4)?,
                    created_at: row.get(5)?,
                    last_error: row.get(6)?,
                    last_attempted_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query failed images: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            images.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }

    pub fn get_task_failed_image_by_id(&self, id: i64) -> Result<Option<TaskFailedImage>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let image = conn
            .query_row(
                "SELECT id, task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at FROM task_failed_images WHERE id = ?1",
                params![id],
                |row| {
                    Ok(TaskFailedImage {
                        id: row.get(0)?,
                        task_id: row.get(1)?,
                        plugin_id: row.get(2)?,
                        url: row.get(3)?,
                        order: row.get(4)?,
                        created_at: row.get(5)?,
                        last_error: row.get(6)?,
                        last_attempted_at: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("Failed to query failed image: {}", e))?;
        Ok(image)
    }

    pub fn get_task_image_ids(&self, task_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT CAST(image_id AS TEXT) FROM task_images WHERE task_id = ?1 ORDER BY added_at ASC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![task_id], |row| row.get(0))
            .map_err(|e| format!("Failed to query task image IDs: {}", e))?;

        let mut ids = Vec::new();
        for r in rows {
            ids.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(ids)
    }

    pub fn get_task_images(&self, task_id: &str) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 i.\"order\"
                 FROM images i
                 INNER JOIN task_images ti ON i.id = ti.image_id
                 LEFT JOIN album_images ON i.id = album_images.image_id AND album_images.album_id = ?2
                 WHERE ti.task_id = ?1
                 ORDER BY COALESCE(ti.\"order\", ti.added_at) ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![task_id, FAVORITE_ALBUM_ID], |row| {
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
                    order: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to query task images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }

    pub fn get_task_images_paginated(
        &self,
        task_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 i.\"order\"
                 FROM images i
                 INNER JOIN task_images ti ON i.id = ti.image_id
                 LEFT JOIN album_images ON i.id = album_images.image_id AND album_images.album_id = ?2
                 WHERE ti.task_id = ?1
                 ORDER BY COALESCE(ti.\"order\", ti.added_at) ASC
                 LIMIT ?3 OFFSET ?4",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![task_id, FAVORITE_ALBUM_ID, limit as i64, offset as i64], |row| {
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
                    order: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to query task images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }

    pub fn set_task_rhai_dump(&self, task_id: &str, dump_json: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "UPDATE tasks SET rhai_dump_json = ?1, rhai_dump_created_at = ?2, rhai_dump_confirmed = 0 WHERE id = ?3",
            params![dump_json, now, task_id],
        )
        .map_err(|e| format!("Failed to set rhai dump: {}", e))?;
        Ok(())
    }

    pub fn confirm_task_rhai_dump(&self, task_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE tasks SET rhai_dump_confirmed = 1 WHERE id = ?1",
            params![task_id],
        )
        .map_err(|e| format!("Failed to confirm rhai dump: {}", e))?;
        Ok(())
    }

    pub fn get_task_rhai_dump(&self, task_id: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let dump: Option<String> = conn
            .query_row(
                "SELECT rhai_dump_json FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query rhai dump: {}", e))?;
        Ok(dump)
    }
}
