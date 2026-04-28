//! pathql-rs SqlExecutor 注入: 把 rusqlite Connection 包装成 dialect-agnostic 的
//! `Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>`。
//!
//! 调用约定: 关闭 Storage 全局锁后再调用 — 闭包内只 lock 本闭包持有的
//! `Arc<Mutex<Connection>>` 副本, 不再回到 Storage::global() 路径, 避免重入死锁。

use std::sync::{Arc, Mutex};

use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{EngineError, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use rusqlite::Connection;

/// 把现有的 `Storage::db` 副本 (`Arc<Mutex<Connection>>`) 包装成 SqlExecutor。
pub fn make_sql_executor(db: Arc<Mutex<Connection>>) -> SqlExecutor {
    Arc::new(move |sql: &str, params: &[TemplateValue]| {
        let conn = db.lock().map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("storage mutex poisoned: {e}"),
            )
        })?;
        let mut stmt = conn.prepare(sql).map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("prepare failed: {e}"),
            )
        })?;
        let rusq_params = params_for(params);
        let col_names: Vec<String> = stmt
            .column_names()
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                let mut obj = serde_json::Map::with_capacity(col_names.len());
                for (i, name) in col_names.iter().enumerate() {
                    let v = match row.get_ref_unwrap(i) {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => serde_json::Value::from(n),
                        rusqlite::types::ValueRef::Real(f) => {
                            serde_json::Number::from_f64(f)
                                .map(serde_json::Value::Number)
                                .unwrap_or(serde_json::Value::Null)
                        }
                        rusqlite::types::ValueRef::Text(t) => serde_json::Value::String(
                            String::from_utf8_lossy(t).into_owned(),
                        ),
                        rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                    };
                    obj.insert(name.clone(), v);
                }
                Ok(serde_json::Value::Object(obj))
            })
            .map_err(|e| {
                EngineError::FactoryFailed(
                    "core".into(),
                    "sql_executor".into(),
                    format!("query_map failed: {e}"),
                )
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("collect rows failed: {e}"),
            )
        })
    })
}
