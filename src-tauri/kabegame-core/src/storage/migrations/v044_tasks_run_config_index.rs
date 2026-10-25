use rusqlite::Connection;

/// 加速按运行配置读取任务并按开始时间做游标分页。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_run_config ON tasks(run_config_id, start_time DESC);",
    )
    .map_err(|e| format!("v044 create idx_tasks_run_config: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_creates_index_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, run_config_id TEXT, start_time INTEGER);",
        )
        .unwrap();
        super::up(&conn).unwrap();
        super::up(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_run_config'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
