use rusqlite::{params, Connection, Result as SqliteResult};
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub struct PluginDataStorage {
    conn: Arc<Mutex<Connection>>,
}

impl PluginDataStorage {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn get(&self, plugin_id: &str) -> SqliteResult<Option<Value>> {
        let conn = self.conn.lock().expect("plugin_data db lock");
        let mut stmt = conn.prepare("SELECT data FROM plugin_data WHERE plugin_id = ?")?;
        let mut rows = stmt.query_map(params![plugin_id], |row| row.get::<_, String>(0))?;
        let Some(result) = rows.next() else {
            return Ok(None);
        };
        let raw = result?;
        let value = serde_json::from_str::<Value>(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Some(value))
    }

    pub fn set(&self, plugin_id: &str, value: &Value) -> SqliteResult<()> {
        if !value.is_object() {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(19),
                Some("plugin_data top-level value must be a JSON object".to_string()),
            ));
        }

        let data = serde_json::to_string(value)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let conn = self.conn.lock().expect("plugin_data db lock");
        conn.execute(
            r#"
INSERT INTO plugin_data (plugin_id, data, updated_at)
VALUES (?1, ?2, strftime('%s','now') * 1000)
ON CONFLICT(plugin_id) DO UPDATE SET
    data = excluded.data,
    updated_at = excluded.updated_at
"#,
            params![plugin_id, data],
        )?;
        Ok(())
    }

    pub fn delete(&self, plugin_id: &str) -> SqliteResult<()> {
        let conn = self.conn.lock().expect("plugin_data db lock");
        conn.execute(
            "DELETE FROM plugin_data WHERE plugin_id = ?",
            params![plugin_id],
        )?;
        Ok(())
    }
}
