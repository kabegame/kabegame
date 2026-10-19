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
        .map_err(|e| format!("v043 inspect {table} columns: {e}"))
}

/// 为任务和运行配置增加任务级 dry-run 冻结参数。
pub fn up(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "tasks", "is_dry_run")? {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN is_dry_run INTEGER NOT NULL DEFAULT 0;",
            [],
        )
        .map_err(|e| format!("v043 add tasks.is_dry_run: {e}"))?;
    }

    if !has_column(conn, "run_configs", "is_dry_run")? {
        conn.execute(
            "ALTER TABLE run_configs ADD COLUMN is_dry_run INTEGER NOT NULL DEFAULT 0;",
            [],
        )
        .map_err(|e| format!("v043 add run_configs.is_dry_run: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_task_dry_run_and_is_idempotent() {
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
                    .filter(|name| name.as_str() == "is_dry_run")
                    .count(),
                1,
                "{table}: {columns:?}"
            );

            conn.execute(&format!("INSERT INTO {table} (id) VALUES ('default')"), [])
                .unwrap();
            assert_eq!(
                conn.query_row(
                    &format!("SELECT is_dry_run FROM {table} WHERE id = 'default'"),
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap(),
                false
            );
        }
    }
}
