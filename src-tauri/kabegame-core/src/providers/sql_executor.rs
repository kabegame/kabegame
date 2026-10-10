//! pathql-rs SqlExecutor 的 core 实现:
//! 包装 Storage 的 PathQL 只读连接池, 6d 起用 trait 形态 (替代旧 Arc<Fn>)。
//!
//! 读写连接已经分离：执行器只使用 query_only 读连接，看不到写连接上尚未提交的事务。
//! `dialect()` 当前硬返 Sqlite (core DB 是 Sqlite-only); 多方言切换需另写 impl。

use pathql_rs::provider::{EngineError, SqlDialect, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use serde_json::{Map, Value as JsonValue};

use crate::storage::template_bridge::template_params_for;
use crate::storage::ReaderPool;

pub struct KabegameSqlExecutor {
    readers: ReaderPool,
}

impl KabegameSqlExecutor {
    pub fn new(readers: ReaderPool) -> Self {
        Self { readers }
    }
}

impl SqlExecutor for KabegameSqlExecutor {
    fn dialect(&self) -> SqlDialect {
        SqlDialect::Sqlite
    }

    fn execute(&self, sql: &str, params: &[TemplateValue]) -> Result<Vec<JsonValue>, EngineError> {
        let conn = self.readers.get().map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("reader pool: {e}"),
            )
        })?;
        // 同一 SQL 文本（只是绑定参数不同）反复执行时复用已编译语句：
        // 例如带计数列举，每个子项的 COUNT 语句文本相同，重复编译曾占该调用约一半耗时
        let mut stmt = conn.prepare_cached(sql).map_err(|e| {
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
