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
        .map_err(|e| format!("v035 inspect {table} columns: {e}"))
}

/// 为任务和运行配置增加逐任务下载并发上限；NULL 表示跟随全局设置。
pub fn up(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "tasks", "max_concurrent_downloads")? {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN max_concurrent_downloads INTEGER;",
            [],
        )
        .map_err(|e| format!("v035 add tasks.max_concurrent_downloads: {e}"))?;
    }

    if !has_column(conn, "run_configs", "max_concurrent_downloads")? {
        conn.execute(
            "ALTER TABLE run_configs ADD COLUMN max_concurrent_downloads INTEGER;",
            [],
        )
        .map_err(|e| format!("v035 add run_configs.max_concurrent_downloads: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_task_max_concurrent_downloads_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY);
             CREATE TABLE run_configs (id TEXT PRIMARY KEY);",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        for table in ["tasks", "run_configs"] {
            let columns: Vec<String> = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(
                columns
                    .iter()
                    .filter(|name| name.as_str() == "max_concurrent_downloads")
                    .count(),
                1,
                "{table}: {columns:?}"
            );
        }

        conn.execute(
            "INSERT INTO tasks (id, max_concurrent_downloads) VALUES ('t', 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO run_configs (id, max_concurrent_downloads) VALUES ('c', 3)",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT max_concurrent_downloads FROM tasks WHERE id = 't'",
                [],
                |row| row.get::<_, Option<u32>>(0),
            )
            .unwrap(),
            Some(2)
        );
        assert_eq!(
            conn.query_row(
                "SELECT max_concurrent_downloads FROM run_configs WHERE id = 'c'",
                [],
                |row| row.get::<_, Option<u32>>(0),
            )
            .unwrap(),
            Some(3)
        );
    }
}
