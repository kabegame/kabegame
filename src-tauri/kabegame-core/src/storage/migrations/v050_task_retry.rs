use rusqlite::Connection;

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut stmt| {
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            for name in names {
                if name? == column {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|e| format!("v050 inspect {table} columns: {e}"))
}

fn add_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    if has_column(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {ddl};"),
        [],
    )
    .map(|_| ())
    .map_err(|e| format!("v050 add {table}.{column}: {e}"))
}

/// 任务级失败重试：任务记配置次数、第几次与重试链原始任务 id，运行配置记配置次数。
///
/// `retry_root_id` 不能以 `id` 为列默认值，先加可空列再把历史任务回填为自身 id；
/// 之后所有写入入口都显式写值，读取侧再用 `COALESCE(retry_root_id, id)` 兜底。
pub fn up(conn: &Connection) -> Result<(), String> {
    add_column(conn, "tasks", "retry_count", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "tasks", "retry_attempt", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "tasks", "retry_root_id", "TEXT")?;
    add_column(
        conn,
        "run_configs",
        "retry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "UPDATE tasks SET retry_root_id = id WHERE retry_root_id IS NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_retry_root ON tasks(retry_root_id, retry_attempt);",
    )
    .map_err(|e| format!("v050 backfill retry_root_id / create idx_tasks_retry_root: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn up_adds_columns_backfills_root_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY);
             CREATE TABLE run_configs (id TEXT PRIMARY KEY);
             INSERT INTO tasks (id) VALUES ('old-1'), ('old-2');",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let task_columns = columns(&conn, "tasks");
        for column in ["retry_count", "retry_attempt", "retry_root_id"] {
            assert_eq!(
                task_columns.iter().filter(|c| c.as_str() == column).count(),
                1,
                "{task_columns:?}"
            );
        }
        let config_columns = columns(&conn, "run_configs");
        assert_eq!(
            config_columns
                .iter()
                .filter(|c| c.as_str() == "retry_count")
                .count(),
            1
        );

        let rows: Vec<(String, String, u32, u32)> = conn
            .prepare("SELECT id, retry_root_id, retry_count, retry_attempt FROM tasks ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("old-1".to_string(), "old-1".to_string(), 0, 0),
                ("old-2".to_string(), "old-2".to_string(), 0, 0),
            ]
        );
    }

    #[test]
    fn retry_chain_query_uses_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, start_time INTEGER);
             CREATE TABLE run_configs (id TEXT PRIMARY KEY);",
        )
        .unwrap();
        super::up(&conn).unwrap();

        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE retry_root_id = ?1
                 ORDER BY retry_attempt DESC, id DESC",
            )
            .unwrap()
            .query_map(["root"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let plan = plan.join("\n");
        assert!(plan.contains("idx_tasks_retry_root"), "{plan}");
    }
}
