//! 插件私有数据 `plugin_data`：每个插件一行、一个 JSON object。
//!
//! 顶层的 [`PRIVATE_KEY`] 是宿主保留的私有区，放插件脚本与界面都不该看到的东西（例如 `wpe-import` 的
//! Steam refresh token）。对外的 [`PluginDataStorage::get`] 一律剥掉它，[`PluginDataStorage::set`] 写入时
//! 保留库里原有的私有区，脚本整份覆盖也动不到它；只有 [`PluginDataStorage::get_private`] /
//! [`PluginDataStorage::update_private`] 能读写。对外出口（Tauri / web 调度的 `get_plugin_data`、
//! V8 与 WebView 插件的 `pluginData` / `setPluginData`、插件详情 EJS 的 `__bridge.getPluginData`）都经过这里。

use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};

/// 宿主保留的私有区顶层键。
pub const PRIVATE_KEY: &str = "__private";

pub struct PluginDataStorage {
    conn: Arc<Mutex<Connection>>,
}

fn read_row(conn: &Connection, plugin_id: &str) -> SqliteResult<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT data FROM plugin_data WHERE plugin_id = ?",
            params![plugin_id],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        serde_json::from_str::<Value>(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    })
    .transpose()
}

fn write_row(conn: &Connection, plugin_id: &str, value: &Value) -> SqliteResult<()> {
    let data =
        serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
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

fn not_object_error() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(19),
        Some("plugin_data top-level value must be a JSON object".to_string()),
    )
}

impl PluginDataStorage {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// 插件可见的数据：去掉宿主私有区。
    pub fn get(&self, plugin_id: &str) -> SqliteResult<Option<Value>> {
        let conn = self.conn.lock().expect("plugin_data db lock");
        Ok(read_row(&conn, plugin_id)?.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.remove(PRIVATE_KEY);
            }
            value
        }))
    }

    /// 覆盖插件可见的数据；库里原有的私有区原样保留，传入值里的私有区被忽略。读改写在同一把锁里完成。
    pub fn set(&self, plugin_id: &str, value: &Value) -> SqliteResult<()> {
        let Some(object) = value.as_object() else {
            return Err(not_object_error());
        };
        let conn = self.conn.lock().expect("plugin_data db lock");
        let mut next = object.clone();
        next.remove(PRIVATE_KEY);
        if let Some(private) = read_row(&conn, plugin_id)?
            .and_then(|mut existing| existing.as_object_mut()?.remove(PRIVATE_KEY))
        {
            next.insert(PRIVATE_KEY.to_string(), private);
        }
        write_row(&conn, plugin_id, &Value::Object(next))
    }

    /// 宿主私有区（只给 Rust 内部用）。没有时为空 object。
    pub fn get_private(&self, plugin_id: &str) -> SqliteResult<Map<String, Value>> {
        let conn = self.conn.lock().expect("plugin_data db lock");
        Ok(read_row(&conn, plugin_id)?
            .and_then(|mut value| value.as_object_mut()?.remove(PRIVATE_KEY))
            .and_then(|private| match private {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default())
    }

    /// 在同一把锁里读改写宿主私有区，插件可见的部分不动。
    pub fn update_private<T>(
        &self,
        plugin_id: &str,
        update: impl FnOnce(&mut Map<String, Value>) -> T,
    ) -> SqliteResult<T> {
        let conn = self.conn.lock().expect("plugin_data db lock");
        let mut row = match read_row(&conn, plugin_id)? {
            Some(Value::Object(map)) => map,
            Some(_) => return Err(not_object_error()),
            None => Map::new(),
        };
        let mut private = match row.remove(PRIVATE_KEY) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let result = update(&mut private);
        if !private.is_empty() {
            row.insert(PRIVATE_KEY.to_string(), Value::Object(private));
        }
        write_row(&conn, plugin_id, &Value::Object(row))?;
        Ok(result)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn storage() -> PluginDataStorage {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE plugin_data (
                plugin_id  TEXT    PRIMARY KEY,
                data       TEXT    NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );",
        )
        .unwrap();
        PluginDataStorage::new(Arc::new(Mutex::new(conn)))
    }

    #[test]
    fn private_area_is_hidden_from_public_reads() {
        let store = storage();
        store
            .update_private("p", |private| {
                private.insert("token".into(), json!("secret"));
            })
            .unwrap();
        store.set("p", &json!({ "a": 1 })).unwrap();
        assert_eq!(store.get("p").unwrap(), Some(json!({ "a": 1 })));
        assert_eq!(store.get_private("p").unwrap().get("token"), Some(&json!("secret")));
    }

    #[test]
    fn public_write_cannot_replace_or_drop_private_area() {
        let store = storage();
        store
            .update_private("p", |private| {
                private.insert("token".into(), json!("secret"));
            })
            .unwrap();
        // 脚本整份覆盖、甚至带上同名私有键，都不改私有区
        store
            .set("p", &json!({ "b": 2, PRIVATE_KEY: { "token": "evil" } }))
            .unwrap();
        store.set("p", &json!({})).unwrap();
        assert_eq!(store.get("p").unwrap(), Some(json!({})));
        assert_eq!(store.get_private("p").unwrap().get("token"), Some(&json!("secret")));
    }

    #[test]
    fn private_update_keeps_public_data_and_clears_when_empty() {
        let store = storage();
        store.set("p", &json!({ "a": 1 })).unwrap();
        store
            .update_private("p", |private| {
                private.insert("k".into(), json!(true));
            })
            .unwrap();
        store.update_private("p", |private| private.clear()).unwrap();
        assert_eq!(store.get("p").unwrap(), Some(json!({ "a": 1 })));
        assert!(store.get_private("p").unwrap().is_empty());
    }

    #[test]
    fn non_object_public_write_is_rejected() {
        assert!(storage().set("p", &json!([1, 2])).is_err());
    }
}
