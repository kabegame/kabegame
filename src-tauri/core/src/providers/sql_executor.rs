//! pathql-rs SqlExecutor 的 core 实现:
//! 包装 Storage 共享的 rusqlite Connection, 6d 起用 trait 形态 (替代旧 Arc<Fn>)。
//!
//! 调用约定: 关闭 Storage 全局锁后再调用 `execute()` — 内部只 lock 本结构持有的
//! `Arc<Mutex<Connection>>` 副本, 不回 Storage::global() 路径, 避免重入死锁。
//! `dialect()` 当前硬返 Sqlite (core DB 是 Sqlite-only); 多方言切换需另写 impl。

use std::sync::{Arc, Mutex};

use pathql_rs::provider::{EngineError, SqlDialect, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::storage::template_bridge::template_params_for;

pub struct KabegameSqlExecutor {
    db: Arc<Mutex<Connection>>,
}

impl KabegameSqlExecutor {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self { db }
    }
}

impl SqlExecutor for KabegameSqlExecutor {
    fn dialect(&self) -> SqlDialect {
        SqlDialect::Sqlite
    }

    fn execute(
        &self,
        sql: &str,
        params: &[TemplateValue],
    ) -> Result<Vec<JsonValue>, EngineError> {
        let conn = self.db.lock().map_err(|e| {
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
        let rusq_params = template_params_for(params);
        let col_names: Vec<String> = stmt
            .column_names()
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                let mut obj = Map::with_capacity(col_names.len());
                for (i, name) in col_names.iter().enumerate() {
                    let v = match row.get_ref_unwrap(i) {
                        rusqlite::types::ValueRef::Null => JsonValue::Null,
                        rusqlite::types::ValueRef::Integer(n) => JsonValue::from(n),
                        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
                            .map(JsonValue::Number)
                            .unwrap_or(JsonValue::Null),
                        rusqlite::types::ValueRef::Text(t) => {
                            JsonValue::String(String::from_utf8_lossy(t).into_owned())
                        }
                        rusqlite::types::ValueRef::Blob(_) => JsonValue::Null,
                    };
                    obj.insert(name.clone(), v);
                }
                Ok(JsonValue::Object(obj))
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
    }
}
