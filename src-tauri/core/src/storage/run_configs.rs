use crate::storage::Storage;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 定时策略（存 DB 的 `schedule_spec` JSON，与 `schedule_enabled` / `planned_at` 等运行态分列）
///
/// JSON 与前端 `ScheduleSpec` 一致：`mode` + camelCase 字段名（间隔为 `intervalSecs`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode")]
pub enum ScheduleSpec {
    #[serde(rename = "interval")]
    Interval {
        #[serde(rename = "intervalSecs")]
        interval_secs: i64,
    },
    #[serde(rename = "daily")]
    Daily { hour: i32, minute: i32 },
    /// `weekday`: 0=周一 … 6=周日（与 `chrono::Weekday::num_days_from_monday()` 一致）
    #[serde(rename = "weekly")]
    Weekly {
        weekday: i32,
        hour: i32,
        minute: i32,
    },
}

fn parse_schedule_spec_cell(s: Option<String>) -> Result<Option<ScheduleSpec>, String> {
    match s {
        None => Ok(None),
        Some(ref x) if x.trim().is_empty() => Ok(None),
        Some(s) => serde_json::from_str(&s).map_err(|e| format!("Failed to parse schedule_spec: {}", e)),
    }
}

fn schedule_spec_to_cell(spec: &Option<ScheduleSpec>) -> Result<Option<String>, String> {
    match spec {
        None => Ok(None),
        Some(sp) => serde_json::to_string(sp)
            .map(Some)
            .map_err(|e| format!("Failed to serialize schedule_spec: {}", e)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    pub url: String,
    #[serde(rename = "outputDir")]
    pub output_dir: Option<String>,
    #[serde(rename = "userConfig")]
    pub user_config: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "httpHeaders")]
    pub http_headers: Option<HashMap<String, String>>,
    pub created_at: u64,
    #[serde(default)]
    pub schedule_enabled: bool,
    pub schedule_spec: Option<ScheduleSpec>,
    pub schedule_planned_at: Option<i64>,
    pub schedule_last_run_at: Option<i64>,
}

impl Storage {
    pub fn get_run_config(&self, config_id: &str) -> Result<Option<RunConfig>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id, name, description, plugin_id, url, output_dir, user_config, http_headers, created_at,
                    schedule_enabled, schedule_spec, schedule_planned_at, schedule_last_run_at
                 FROM run_configs
                 WHERE id = ?1
                 LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![config_id])
            .map_err(|e| format!("Failed to query run config: {}", e))?;
        let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to read row: {}", e))?
        else {
            return Ok(None);
        };

        let user_config_json: Option<String> = row.get(6).ok();
        let user_config = user_config_json.and_then(|s| serde_json::from_str(&s).ok());
        let http_headers_json: Option<String> = row.get(7).ok();
        let http_headers = http_headers_json.and_then(|s| serde_json::from_str(&s).ok());

        let schedule_spec_raw: Option<String> = row.get(10).ok();
        let schedule_spec = parse_schedule_spec_cell(schedule_spec_raw)?;

        Ok(Some(RunConfig {
            id: row
                .get(0)
                .map_err(|e| format!("Failed to parse id: {}", e))?,
            name: row
                .get(1)
                .map_err(|e| format!("Failed to parse name: {}", e))?,
            description: row
                .get(2)
                .map_err(|e| format!("Failed to parse description: {}", e))?,
            plugin_id: row
                .get(3)
                .map_err(|e| format!("Failed to parse plugin_id: {}", e))?,
            url: row
                .get(4)
                .map_err(|e| format!("Failed to parse url: {}", e))?,
            output_dir: row
                .get(5)
                .map_err(|e| format!("Failed to parse output_dir: {}", e))?,
            user_config,
            http_headers,
            created_at: row
                .get::<_, i64>(8)
                .map_err(|e| format!("Failed to parse created_at: {}", e))?
                as u64,
            schedule_enabled: row
                .get::<_, i64>(9)
                .map_err(|e| format!("Failed to parse schedule_enabled: {}", e))?
                != 0,
            schedule_spec,
            schedule_planned_at: row
                .get(11)
                .map_err(|e| format!("Failed to parse schedule_planned_at: {}", e))?,
            schedule_last_run_at: row
                .get(12)
                .map_err(|e| format!("Failed to parse schedule_last_run_at: {}", e))?,
        }))
    }

    pub fn get_enabled_run_configs(&self) -> Result<Vec<RunConfig>, String> {
        let mut configs = self.get_run_configs()?;
        configs.retain(|c| c.schedule_enabled);
        Ok(configs)
    }

    pub fn set_run_config_schedule_last_run_at(
        &self,
        config_id: &str,
        last_run_at: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE run_configs SET schedule_last_run_at = ?1 WHERE id = ?2",
            params![last_run_at, config_id],
        )
        .map_err(|e| format!("Failed to update schedule_last_run_at: {}", e))?;
        Ok(())
    }

    pub fn set_run_config_schedule_planned_at(
        &self,
        config_id: &str,
        planned_at: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE run_configs SET schedule_planned_at = ?1 WHERE id = ?2",
            params![planned_at, config_id],
        )
        .map_err(|e| format!("Failed to update schedule_planned_at: {}", e))?;
        Ok(())
    }

    pub fn set_run_config_schedule_enabled(
        &self,
        config_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE run_configs SET schedule_enabled = ?1 WHERE id = ?2",
            params![if enabled { 1 } else { 0 }, config_id],
        )
        .map_err(|e| format!("Failed to update schedule_enabled: {}", e))?;
        Ok(())
    }

    pub fn add_run_config(&self, config: RunConfig) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let user_config_json = serde_json::to_string(&config.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;
        let http_headers_json = serde_json::to_string(&config.http_headers)
            .map_err(|e| format!("Failed to serialize http headers: {}", e))?;
        let schedule_spec_json = schedule_spec_to_cell(&config.schedule_spec)?;

        conn.execute(
            "INSERT INTO run_configs (
                id, name, description, plugin_id, url, output_dir, user_config, http_headers, created_at,
                schedule_enabled, schedule_spec, schedule_planned_at, schedule_last_run_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                config.id,
                config.name,
                config.description,
                config.plugin_id,
                config.url,
                config.output_dir,
                user_config_json,
                http_headers_json,
                config.created_at as i64,
                if config.schedule_enabled { 1 } else { 0 },
                schedule_spec_json,
                config.schedule_planned_at,
                config.schedule_last_run_at,
            ],
        )
        .map_err(|e| format!("Failed to add run config: {}", e))?;
        Ok(())
    }

    pub fn get_run_configs(&self) -> Result<Vec<RunConfig>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id, name, description, plugin_id, url, output_dir, user_config, http_headers, created_at,
                    schedule_enabled, schedule_spec, schedule_planned_at, schedule_last_run_at
                 FROM run_configs
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let user_config_json: Option<String> = row.get(6)?;
                let user_config = user_config_json.and_then(|s| serde_json::from_str(&s).ok());
                let http_headers_json: Option<String> = row.get(7)?;
                let http_headers = http_headers_json.and_then(|s| serde_json::from_str(&s).ok());
                let schedule_spec_raw: Option<String> = row.get(10)?;
                let schedule_spec = parse_schedule_spec_cell(schedule_spec_raw).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e,
                    )))
                })?;
                Ok(RunConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    plugin_id: row.get(3)?,
                    url: row.get(4)?,
                    output_dir: row.get(5)?,
                    user_config,
                    http_headers,
                    created_at: row.get::<_, i64>(8)? as u64,
                    schedule_enabled: row.get::<_, i64>(9)? != 0,
                    schedule_spec,
                    schedule_planned_at: row.get(11)?,
                    schedule_last_run_at: row.get(12)?,
                })
            })
            .map_err(|e| format!("Failed to query run configs: {}", e))?;

        let mut configs = Vec::new();
        for r in rows {
            configs.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(configs)
    }

    pub fn update_run_config(&self, config: RunConfig) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let user_config_json = serde_json::to_string(&config.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;
        let http_headers_json = serde_json::to_string(&config.http_headers)
            .map_err(|e| format!("Failed to serialize http headers: {}", e))?;
        let schedule_spec_json = schedule_spec_to_cell(&config.schedule_spec)?;

        conn.execute(
            "UPDATE run_configs
             SET name = ?1, description = ?2, plugin_id = ?3, url = ?4, output_dir = ?5, user_config = ?6, http_headers = ?7,
                 schedule_enabled = ?8, schedule_spec = ?9, schedule_planned_at = ?10, schedule_last_run_at = ?11
             WHERE id = ?12",
            params![
                config.name,
                config.description,
                config.plugin_id,
                config.url,
                config.output_dir,
                user_config_json,
                http_headers_json,
                if config.schedule_enabled { 1 } else { 0 },
                schedule_spec_json,
                config.schedule_planned_at,
                config.schedule_last_run_at,
                config.id,
            ],
        )
        .map_err(|e| format!("Failed to update run config: {}", e))?;
        Ok(())
    }

    pub fn delete_run_config(&self, config_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM run_configs WHERE id = ?1", params![config_id])
            .map_err(|e| format!("Failed to delete run config: {}", e))?;
        Ok(())
    }

    pub fn copy_run_config(&self, config_id: &str, new_id: &str) -> Result<RunConfig, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    name, description, plugin_id, url, output_dir, user_config, http_headers, created_at,
                    schedule_enabled, schedule_spec, schedule_planned_at, schedule_last_run_at
                 FROM run_configs
                 WHERE id = ?1",
            )
            .map_err(|e| format!("Failed to prepare copy query: {}", e))?;

        let copied = stmt.query_row(params![config_id], |row| {
            let user_config_json: Option<String> = row.get(5)?;
            let user_config = user_config_json.and_then(|s| serde_json::from_str(&s).ok());
            let http_headers_json: Option<String> = row.get(6)?;
            let http_headers = http_headers_json.and_then(|s| serde_json::from_str(&s).ok());
            let schedule_spec_raw: Option<String> = row.get(9)?;
            let schedule_spec = parse_schedule_spec_cell(schedule_spec_raw).map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e,
                )))
            })?;
            Ok(RunConfig {
                id: new_id.to_string(),
                name: row.get(0)?,
                description: row.get(1)?,
                plugin_id: row.get(2)?,
                url: row.get(3)?,
                output_dir: row.get(4)?,
                user_config,
                http_headers,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                // 复制后默认关闭定时，避免新副本立即触发
                schedule_enabled: false,
                schedule_spec,
                schedule_planned_at: None,
                schedule_last_run_at: None,
            })
        });

        let copied = copied.map_err(|e| format!("Failed to read source run config: {}", e))?;
        drop(stmt);

        let user_config_json = serde_json::to_string(&copied.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;
        let http_headers_json = serde_json::to_string(&copied.http_headers)
            .map_err(|e| format!("Failed to serialize http headers: {}", e))?;
        let schedule_spec_json = schedule_spec_to_cell(&copied.schedule_spec)?;
        conn.execute(
            "INSERT INTO run_configs (
                id, name, description, plugin_id, url, output_dir, user_config, http_headers, created_at,
                schedule_enabled, schedule_spec, schedule_planned_at, schedule_last_run_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                copied.id,
                copied.name,
                copied.description,
                copied.plugin_id,
                copied.url,
                copied.output_dir,
                user_config_json,
                http_headers_json,
                copied.created_at as i64,
                if copied.schedule_enabled { 1 } else { 0 },
                schedule_spec_json,
                copied.schedule_planned_at,
                copied.schedule_last_run_at,
            ],
        )
        .map_err(|e| format!("Failed to insert copied run config: {}", e))?;

        Ok(copied)
    }
}
