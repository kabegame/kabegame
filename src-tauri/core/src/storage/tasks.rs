use crate::emitter::GlobalEmitter;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    #[serde(rename = "runConfigId")]
    #[serde(default)]
    pub run_config_id: Option<String>,
    #[serde(rename = "triggerSource")]
    #[serde(default = "default_trigger_source")]
    pub trigger_source: String,
    pub status: String,
    pub progress: f64,
    #[serde(rename = "deletedCount")]
    pub deleted_count: i64,
    #[serde(rename = "dedupCount")]
    #[serde(default)]
    pub dedup_count: i64,
    #[serde(rename = "successCount", default)]
    pub success_count: i64,
    #[serde(rename = "failedCount", default)]
    pub failed_count: i64,
    #[serde(rename = "startTime")]
    pub start_time: Option<u64>,
    #[serde(rename = "endTime")]
    pub end_time: Option<u64>,
    pub error: Option<String>,
}

fn default_trigger_source() -> String {
    "manual".to_string()
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
    pub header_snapshot: Option<HashMap<String, String>>,
    pub metadata_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogEntry {
    pub id: i64,
    pub task_id: String,
    pub level: String,
    pub content: String,
    pub time: i64,
}

impl Storage {
    pub fn add_task(&self, task: TaskInfo) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let user_config_json = serde_json::to_string(&task.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;
        let http_headers_json = serde_json::to_string(&task.http_headers)
            .map_err(|e| format!("Failed to serialize http headers: {}", e))?;

        conn.execute(
            "INSERT INTO tasks (
                id, plugin_id, output_dir, user_config, http_headers, output_album_id, run_config_id, trigger_source,
                status, progress, deleted_count, dedup_count, success_count, failed_count, start_time, end_time, error
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                task.id,
                task.plugin_id,
                task.output_dir,
                user_config_json,
                http_headers_json,
                task.output_album_id,
                task.run_config_id,
                if task.trigger_source.is_empty() {
                    "manual".to_string()
                } else {
                    task.trigger_source.clone()
                },
                task.status,
                task.progress,
                task.deleted_count,
                task.dedup_count,
                task.success_count,
                task.failed_count,
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
            "UPDATE tasks
             SET status = ?1, progress = ?2, start_time = ?3, end_time = ?4, error = ?5,
                 deleted_count = ?6, dedup_count = ?7, success_count = ?8, failed_count = ?9,
                 output_album_id = ?10, run_config_id = ?11, trigger_source = ?12
             WHERE id = ?13",
            params![
                task.status,
                task.progress,
                task.start_time.map(|t| t as i64),
                task.end_time.map(|t| t as i64),
                task.error,
                task.deleted_count,
                task.dedup_count,
                task.success_count,
                task.failed_count,
                task.output_album_id,
                task.run_config_id,
                if task.trigger_source.is_empty() {
                    "manual".to_string()
                } else {
                    task.trigger_source.clone()
                },
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
                "SELECT t.id, t.plugin_id, t.output_dir, t.user_config, t.http_headers, t.status, t.progress, t.start_time, t.end_time, t.error, t.output_album_id, t.deleted_count, t.dedup_count, t.success_count, t.failed_count, t.run_config_id, t.trigger_source
                 FROM tasks t WHERE t.id = ?1",
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
                        dedup_count: row.get(12)?,
                        success_count: row.get(13)?,
                        failed_count: row.get(14)?,
                        run_config_id: row.get(15)?,
                        trigger_source: row
                            .get::<_, Option<String>>(16)?
                            .unwrap_or_else(default_trigger_source),
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
            .prepare(
                "SELECT t.id, t.plugin_id, t.output_dir, t.user_config, t.http_headers, t.status, t.progress, t.start_time, t.end_time, t.error, t.output_album_id, t.deleted_count, t.dedup_count, t.success_count, t.failed_count
                 , t.run_config_id, t.trigger_source
                 FROM tasks t ORDER BY t.start_time DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let task_rows = stmt
            .query_map([], |row| {
                let user_config_json: Option<String> = row.get(3)?;
                let user_config = user_config_json.and_then(|s| serde_json::from_str(&s).ok());
                let http_headers_json: Option<String> = row.get(4)?;
                let http_headers = http_headers_json.and_then(|s| serde_json::from_str(&s).ok());
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
                    dedup_count: row.get(12)?,
                    success_count: row.get(13)?,
                    failed_count: row.get(14)?,
                    run_config_id: row.get(15)?,
                    trigger_source: row
                        .get::<_, Option<String>>(16)?
                        .unwrap_or_else(default_trigger_source),
                })
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut tasks = Vec::new();
        for row_result in task_rows {
            tasks.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(tasks)
    }

    /// 分页获取任务列表，按 start_time DESC 排序
    pub fn get_tasks_page(&self, limit: u32, offset: u32) -> Result<(Vec<TaskInfo>, u64), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count tasks: {}", e))?;
        let total = total.max(0) as u64;

        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.plugin_id, t.output_dir, t.user_config, t.http_headers, t.status, t.progress, t.start_time, t.end_time, t.error, t.output_album_id, t.deleted_count, t.dedup_count, t.success_count, t.failed_count
                 , t.run_config_id, t.trigger_source
                 FROM tasks t ORDER BY t.start_time DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let task_rows = stmt
            .query_map(params![limit as i64, offset as i64], |row| {
                let user_config_json: Option<String> = row.get(3)?;
                let user_config = user_config_json.and_then(|s| serde_json::from_str(&s).ok());
                let http_headers_json: Option<String> = row.get(4)?;
                let http_headers = http_headers_json.and_then(|s| serde_json::from_str(&s).ok());
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
                    dedup_count: row.get(12)?,
                    success_count: row.get(13)?,
                    failed_count: row.get(14)?,
                    run_config_id: row.get(15)?,
                    trigger_source: row
                        .get::<_, Option<String>>(16)?
                        .unwrap_or_else(default_trigger_source),
                })
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut tasks = Vec::new();
        for row_result in task_rows {
            tasks.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok((tasks, total))
    }

    pub fn mark_pending_running_tasks_as_failed(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let count = conn
            .execute(
                "UPDATE tasks SET status = 'failed', error = '任务已失效', end_time = ?1 WHERE status IN ('pending', 'running')",
                params![now],
            )
            .map_err(|e| format!("Failed to mark tasks as failed: {}", e))?;
        Ok(count)
    }

    pub fn increment_task_dedup_count(&self, task_id: &str) -> Result<i64, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE tasks SET dedup_count = dedup_count + 1 WHERE id = ?1",
            params![task_id],
        )
        .map_err(|e| format!("Failed to increment dedup_count: {}", e))?;
        let count: i64 = conn
            .query_row(
                "SELECT dedup_count FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to get dedup_count: {}", e))?;
        Ok(count)
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let failed_image_ids: Vec<i64> = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let ids = {
                let mut stmt = conn
                    .prepare("SELECT id FROM task_failed_images WHERE task_id = ?1")
                    .map_err(|e| format!("Failed to prepare failed images query: {}", e))?;
                let rows = stmt
                    .query_map(params![task_id], |row| row.get::<_, i64>(0))
                    .map_err(|e| format!("Failed to query failed images: {}", e))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(row.map_err(|e| format!("Failed to read failed image row: {}", e))?);
                }
                ids
            };

            // 先删除关联数据（日志、失败图片、任务主表）
            conn.execute("DELETE FROM task_logs WHERE task_id = ?1", params![task_id])
                .map_err(|e| format!("Failed to delete task logs: {}", e))?;
            conn.execute(
                "DELETE FROM task_failed_images WHERE task_id = ?1",
                params![task_id],
            )
            .map_err(|e| format!("Failed to delete task failed images: {}", e))?;
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
                .map_err(|e| format!("Failed to delete task: {}", e))?;
            ids
        };

        if !failed_image_ids.is_empty() {
            GlobalEmitter::global().emit_failed_images_removed(task_id, &failed_image_ids);
        }
        Ok(())
    }

    /// 获取“有图片”的任务 ID 列表（用于 TaskGroupProvider）
    pub fn get_task_ids_with_images(&self) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id
                 FROM tasks t
                 WHERE EXISTS (SELECT 1 FROM images i WHERE i.task_id = t.id)
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

    /// 获取任务 (id + plugin_id)（用于 VD 在目录名中显示插件名/ID）。
    pub fn get_tasks_with_images(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.plugin_id
                 FROM tasks t
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
        let (count, removed_failed_by_task): (usize, Vec<(String, Vec<i64>)>) = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let removed_failed_by_task: Vec<(String, Vec<i64>)> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT tfi.task_id, tfi.id
                         FROM task_failed_images tfi
                         WHERE tfi.task_id IN (
                            SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'canceled', 'cancelled')
                         )
                         ORDER BY tfi.task_id, tfi.id",
                    )
                    .map_err(|e| format!("Failed to prepare failed images query: {}", e))?;
                let rows = stmt
                    .query_map([], |row| {
                        let task_id: String = row.get(0)?;
                        let id: i64 = row.get(1)?;
                        Ok((task_id, id))
                    })
                    .map_err(|e| {
                        format!("Failed to query failed images for finished tasks: {}", e)
                    })?;

                let mut removed_failed_by_task: Vec<(String, Vec<i64>)> = Vec::new();
                for row in rows {
                    let (task_id, id) =
                        row.map_err(|e| format!("Failed to read failed image row: {}", e))?;
                    if let Some((last_task_id, ids)) = removed_failed_by_task.last_mut() {
                        if *last_task_id == task_id {
                            ids.push(id);
                            continue;
                        }
                    }
                    removed_failed_by_task.push((task_id, vec![id]));
                }
                removed_failed_by_task
            };

            let _ = conn.execute(
                "DELETE FROM task_logs WHERE task_id IN (
                    SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'canceled', 'cancelled')
                )",
                [],
            );
            let _ = conn.execute(
                "DELETE FROM task_failed_images WHERE task_id IN (
                    SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'canceled', 'cancelled')
                )",
                [],
            );
            let count = conn
                .execute(
                    "DELETE FROM tasks WHERE status IN ('completed', 'failed', 'canceled', 'cancelled')",
                    [],
                )
                .map_err(|e| format!("Failed to clear finished tasks: {}", e))?;
            (count, removed_failed_by_task)
        };

        for (task_id, ids) in removed_failed_by_task {
            if !ids.is_empty() {
                GlobalEmitter::global().emit_failed_images_removed(&task_id, &ids);
            }
        }
        Ok(count)
    }

    pub fn add_task_log(&self, task_id: &str, level: &str, content: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        conn.execute(
            "INSERT INTO task_logs (task_id, level, content, time) VALUES (?1, ?2, ?3, ?4)",
            params![task_id, level, content, now],
        )
        .map_err(|e| format!("Failed to add task log: {}", e))?;
        Ok(())
    }

    pub fn get_task_logs(&self, task_id: &str) -> Result<Vec<TaskLogEntry>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, level, content, time
                 FROM task_logs
                 WHERE task_id = ?1
                 ORDER BY time ASC, id ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![task_id], |row| {
                Ok(TaskLogEntry {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    level: row.get(2)?,
                    content: row.get(3)?,
                    time: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query task logs: {}", e))?;

        let mut logs = Vec::new();
        for r in rows {
            logs.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(logs)
    }

    pub fn add_task_failed_image(
        &self,
        task_id: &str,
        plugin_id: &str,
        url: &str,
        order: i64,
        error: Option<&str>,
        header_snapshot: Option<&HashMap<String, String>>,
        metadata_id: Option<i64>,
    ) -> Result<TaskFailedImage, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let error_owned = error.map(str::to_string);
        let header_snapshot_owned = header_snapshot.cloned();
        let header_snapshot_json = header_snapshot
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| format!("Failed to serialize failed image header snapshot: {}", e))?;
        conn.execute(
            "INSERT INTO task_failed_images (task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at, header_snapshot, metadata_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                task_id,
                plugin_id,
                url,
                order,
                now,
                error_owned.as_deref(),
                now,
                header_snapshot_json,
                metadata_id
            ],
        )
        .map_err(|e| format!("Failed to add failed image: {}", e))?;
        let _ = conn.execute(
            "UPDATE tasks SET failed_count = failed_count + 1 WHERE id = ?1",
            params![task_id],
        );
        let id = conn.last_insert_rowid();
        Ok(TaskFailedImage {
            id,
            task_id: task_id.to_string(),
            plugin_id: plugin_id.to_string(),
            url: url.to_string(),
            order,
            created_at: now,
            last_error: error_owned,
            last_attempted_at: Some(now),
            header_snapshot: header_snapshot_owned,
            metadata_id,
        })
    }

    pub fn update_task_failed_image_attempt(&self, id: i64, error: &str) -> Result<(), String> {
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

    pub fn update_task_failed_image_header_snapshot(
        &self,
        id: i64,
        header_snapshot: &HashMap<String, String>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let header_snapshot_json = serde_json::to_string(header_snapshot)
            .map_err(|e| format!("Failed to serialize failed image header snapshot: {}", e))?;
        conn.execute(
            "UPDATE task_failed_images SET header_snapshot = ?1 WHERE id = ?2",
            params![header_snapshot_json, id],
        )
        .map_err(|e| format!("Failed to update failed image header snapshot: {}", e))?;
        Ok(())
    }

    pub fn delete_task_failed_image(&self, id: i64) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let task_id: Option<String> = conn
            .query_row(
                "SELECT task_id FROM task_failed_images WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query failed image: {}", e))?;
        conn.execute("DELETE FROM task_failed_images WHERE id = ?1", params![id])
            .map_err(|_e| format!("Failed to delete failed image: {}", id))?;
        if let Some(tid) = task_id {
            let _ = conn.execute(
                "UPDATE tasks SET failed_count = MAX(0, failed_count - 1) WHERE id = ?1",
                params![tid],
            );
        }
        Ok(())
    }

    /// 批量删除失败图片记录；按 task 扣减 `failed_count`。返回 `(task_id, 已删 id 列表)` 供上层发事件。
    pub fn delete_failed_images(&self, ids: &[i64]) -> Result<Vec<(String, Vec<i64>)>, String> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut seen = std::collections::HashSet::new();
        let unique_ids: Vec<i64> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut by_task: HashMap<String, Vec<i64>> = HashMap::new();
        for &id in &unique_ids {
            let task_id: Option<String> = conn
                .query_row(
                    "SELECT task_id FROM task_failed_images WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to query failed image: {}", e))?;
            if let Some(tid) = task_id {
                by_task.entry(tid).or_default().push(id);
            }
        }
        if by_task.is_empty() {
            return Ok(vec![]);
        }

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        for &id in &unique_ids {
            tx.execute("DELETE FROM task_failed_images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete failed image: {}", e))?;
        }

        for (tid, del_ids) in &by_task {
            let n = del_ids.len() as i64;
            tx.execute(
                "UPDATE tasks SET failed_count = MAX(0, failed_count - ?1) WHERE id = ?2",
                params![n, tid],
            )
            .map_err(|e| format!("Failed to update task failed_count: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit delete_failed_images: {}", e))?;
        Ok(by_task.into_iter().collect())
    }

    pub fn get_task_failed_images(&self, task_id: &str) -> Result<Vec<TaskFailedImage>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at, header_snapshot, metadata_id FROM task_failed_images WHERE task_id = ?1 ORDER BY id DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![task_id], |row| {
                let header_snapshot_json: Option<String> = row.get(8)?;
                let header_snapshot =
                    header_snapshot_json.and_then(|s| serde_json::from_str(&s).ok());
                Ok(TaskFailedImage {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    plugin_id: row.get(2)?,
                    url: row.get(3)?,
                    order: row.get(4)?,
                    created_at: row.get(5)?,
                    last_error: row.get(6)?,
                    last_attempted_at: row.get(7)?,
                    header_snapshot,
                    metadata_id: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query failed images: {}", e))?;

        let mut images = Vec::new();
        for r in rows {
            images.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }

    pub fn get_all_failed_images(&self) -> Result<Vec<TaskFailedImage>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at, header_snapshot, metadata_id
                 FROM task_failed_images
                 ORDER BY id DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let header_snapshot_json: Option<String> = row.get(8)?;
                let header_snapshot =
                    header_snapshot_json.and_then(|s| serde_json::from_str(&s).ok());
                Ok(TaskFailedImage {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    plugin_id: row.get(2)?,
                    url: row.get(3)?,
                    order: row.get(4)?,
                    created_at: row.get(5)?,
                    last_error: row.get(6)?,
                    last_attempted_at: row.get(7)?,
                    header_snapshot,
                    metadata_id: row.get(9)?,
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
                "SELECT id, task_id, plugin_id, url, \"order\", created_at, last_error, last_attempted_at, header_snapshot, metadata_id FROM task_failed_images WHERE id = ?1",
                params![id],
                |row| {
                    let header_snapshot_json: Option<String> = row.get(8)?;
                    let header_snapshot = header_snapshot_json
                        .and_then(|s| serde_json::from_str(&s).ok());
                    Ok(TaskFailedImage {
                        id: row.get(0)?,
                        task_id: row.get(1)?,
                        plugin_id: row.get(2)?,
                        url: row.get(3)?,
                        order: row.get(4)?,
                        created_at: row.get(5)?,
                        last_error: row.get(6)?,
                        last_attempted_at: row.get(7)?,
                        header_snapshot,
                        metadata_id: row.get(9)?,
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
            .prepare(
                "SELECT CAST(id AS TEXT) FROM images WHERE task_id = ?1 ORDER BY crawled_at ASC",
            )
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
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata_id,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 i.width,
                 i.height,
                 i.display_name,
                 COALESCE(i.type, 'image') as media_type,
                 i.last_set_wallpaper_at
                 FROM images i
                 LEFT JOIN album_images ON i.id = album_images.image_id AND album_images.album_id = ?2
                 WHERE i.task_id = ?1
                 ORDER BY i.crawled_at ASC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(params![task_id, FAVORITE_ALBUM_ID], |row| {
                Ok(ImageInfo {
                    id: row.get(0)?,
                    url: row.get::<_, Option<String>>(1)?,
                    local_path: row.get(2)?,
                    plugin_id: row.get(3)?,
                    task_id: row.get(4)?,
                    surf_record_id: None,
                    crawled_at: row.get(5)?,
                    metadata: None,
                    metadata_id: row.get::<_, Option<i64>>(6)?,
                    thumbnail_path: row.get(7)?,
                    hash: row.get(8)?,
                    favorite: row.get::<_, i64>(9)? != 0,
                    local_exists: true,
                    width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                    display_name: row.get(12)?,
                    media_type: crate::image_type::normalize_stored_media_type(
                        row.get::<_, Option<String>>(13)?,
                    ),
                    last_set_wallpaper_at: crate::storage::images::row_optional_u64_ts(row, 14)?,
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
                "SELECT CAST(i.id AS TEXT), i.url, i.local_path, i.plugin_id, i.task_id, i.crawled_at, i.metadata_id,
                 COALESCE(NULLIF(i.thumbnail_path, ''), i.local_path) as thumbnail_path,
                 i.hash,
                 CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
                 i.width,
                 i.height,
                 i.display_name,
                 COALESCE(i.type, 'image') as media_type,
                 i.last_set_wallpaper_at
                 FROM images i
                 LEFT JOIN album_images ON i.id = album_images.image_id AND album_images.album_id = ?2
                 WHERE i.task_id = ?1
                 ORDER BY i.crawled_at ASC
                 LIMIT ?3 OFFSET ?4",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let image_rows = stmt
            .query_map(
                params![task_id, FAVORITE_ALBUM_ID, limit as i64, offset as i64],
                |row| {
                    Ok(ImageInfo {
                        id: row.get(0)?,
                        url: row.get::<_, Option<String>>(1)?,
                        local_path: row.get(2)?,
                        plugin_id: row.get(3)?,
                        task_id: row.get(4)?,
                        surf_record_id: None,
                        crawled_at: row.get(5)?,
                        metadata: None,
                        metadata_id: row.get::<_, Option<i64>>(6)?,
                        thumbnail_path: row.get(7)?,
                        hash: row.get(8)?,
                        favorite: row.get::<_, i64>(9)? != 0,
                        local_exists: true,
                        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                        display_name: row.get(12)?,
                        media_type: crate::image_type::normalize_stored_media_type(
                            row.get::<_, Option<String>>(13)?,
                        ),
                        last_set_wallpaper_at: crate::storage::images::row_optional_u64_ts(
                            row, 14,
                        )?,
                    })
                },
            )
            .map_err(|e| format!("Failed to query task images: {}", e))?;

        let mut images = Vec::new();
        for row_result in image_rows {
            images.push(row_result.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(images)
    }
}
