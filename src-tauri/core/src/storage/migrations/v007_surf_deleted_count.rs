use rusqlite::Connection;

/// v6 → v7：`surf_records` 增加 `deleted_count`（累计删除张数）。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        ALTER TABLE surf_records ADD COLUMN deleted_count INTEGER NOT NULL DEFAULT 0;
        "#,
    )
    .map_err(|e| format!("v007: surf deleted_count migration failed: {}", e))
}
