//! pathql-rs SqlExecutor 的 core 实现:
//! 包装 Storage 的 PathQL 只读连接池, 6d 起用 trait 形态 (替代旧 Arc<Fn>)。
//!
//! 读写连接已经分离：执行器只使用 query_only 读连接，看不到写连接上尚未提交的事务。
//! `dialect()` 当前硬返 Sqlite (core DB 是 Sqlite-only); 多方言切换需另写 impl。

use std::cell::RefCell;

use pathql_rs::provider::{EngineError, SqlDialect, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use r2d2::PooledConnection;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::storage::template_bridge::template_params_for;
use crate::storage::ReaderPool;

thread_local! {
    static PINNED: RefCell<Option<PooledConnection<SqliteConnectionManager>>> = const { RefCell::new(None) };
}

/// 在当前线程钉住只读连接；嵌套调用沿用外层事务的 WAL 读快照。
pub(crate) fn with_read_snapshot<T>(
    readers: &ReaderPool,
    f: impl FnOnce() -> T,
) -> Result<T, String> {
    if PINNED.with(|pinned| pinned.borrow().is_some()) {
        return Ok(f());
    }
    let conn = readers.get().map_err(|e| format!("reader pool: {e}"))?;
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("begin read snapshot: {e}"))?;
    PINNED.with(|pinned| *pinned.borrow_mut() = Some(conn));

    struct SnapshotGuard;
    impl Drop for SnapshotGuard {
        fn drop(&mut self) {
            if let Some(conn) = PINNED.with(|pinned| pinned.borrow_mut().take()) {
                // 只读事务没有待提交写入；正常返回与 panic 都要释放快照。
                if conn.execute_batch("COMMIT").is_err() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
            }
        }
    }
    let _guard = SnapshotGuard;
    Ok(f())
}

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
        PINNED.with(|pinned| {
            let pinned = pinned.borrow();
            if let Some(conn) = pinned.as_ref() {
                return run_sql(conn, sql, params);
            }
            let conn = self.readers.get().map_err(|e| {
                EngineError::FactoryFailed(
                    "core".into(),
                    "sql_executor".into(),
                    format!("reader pool: {e}"),
                )
            })?;
            run_sql(&conn, sql, params)
        })
    }
}

fn run_sql(
    conn: &Connection,
    sql: &str,
    params: &[TemplateValue],
) -> Result<Vec<JsonValue>, EngineError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::open_reader_pool;

    #[test]
    fn read_snapshot_pins_connection_and_nested_queries() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("read-snapshot.db");
        let mut writer = Connection::open(&db_path).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE items (value INTEGER);")
            .unwrap();
        let readers = open_reader_pool(&db_path).unwrap();
        let executor = KabegameSqlExecutor::new(readers.clone());
        let count = || {
            executor
                .execute("SELECT COUNT(*) AS total FROM items", &[])
                .unwrap()[0]["total"]
                .as_i64()
                .unwrap()
        };

        with_read_snapshot(&readers, || {
            assert_eq!(count(), 0);
            let tx = writer.transaction().unwrap();
            tx.execute("INSERT INTO items VALUES (42)", []).unwrap();
            tx.commit().unwrap();
            assert_eq!(count(), 0);
            with_read_snapshot(&readers, || assert_eq!(count(), 0)).unwrap();
            assert_eq!(count(), 0);
        })
        .unwrap();
        assert_eq!(count(), 1);

        // panic 也要归还连接、结束事务，之后的新快照仍可读取新提交。
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_read_snapshot(&readers, || {
                assert_eq!(count(), 1);
                panic!("测试快照清理");
            })
            .unwrap();
        }));
        assert!(result.is_err());
        writer.execute("INSERT INTO items VALUES (7)", []).unwrap();
        with_read_snapshot(&readers, || assert_eq!(count(), 2)).unwrap();
    }
}
