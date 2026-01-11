use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::storage::Storage;

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
    pub created_at: u64,
}

impl Storage {
    pub fn add_run_config(&self, config: RunConfig) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let user_config_json = serde_json::to_string(&config.user_config)
            .map_err(|e| format!("Failed to serialize user config: {}", e))?;

        conn.execute(
            "INSERT INTO run_configs (id, name, description, plugin_id, url, output_dir, user_config, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                config.id,
                config.name,
                config.description,
                config.plugin_id,
                config.url,
                config.output_dir,
                user_config_json,
                config.created_at as i64,
            ],
        )
        .map_err(|e| format!("Failed to add run config: {}", e))?;
        Ok(())
    }

    pub fn get_run_configs(&self) -> Result<Vec<RunConfig>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, name, description, plugin_id, url, output_dir, user_config, created_at FROM run_configs ORDER BY created_at DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let user_config_json: Option<String> = row.get(6)?;
                let user_config = user_config_json
                    .and_then(|s| serde_json::from_str(&s).ok());
                Ok(RunConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    plugin_id: row.get(3)?,
                    url: row.get(4)?,
                    output_dir: row.get(5)?,
                    user_config,
                    created_at: row.get::<_, i64>(7)? as u64,
                })
            })
            .map_err(|e| format!("Failed to query run configs: {}", e))?;

        let mut configs = Vec::new();
        for r in rows {
            configs.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(configs)
    }

    pub fn delete_run_config(&self, config_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM run_configs WHERE id = ?1", params![config_id])
            .map_err(|e| format!("Failed to delete run config: {}", e))?;
        Ok(())
    }
}
