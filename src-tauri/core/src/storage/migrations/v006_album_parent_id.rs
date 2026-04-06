use rusqlite::Connection;

/// v5 → v6：albums 表添加 parent_id，唯一索引从全局改为同层级（parent 范围内）。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        ALTER TABLE albums ADD COLUMN parent_id TEXT REFERENCES albums(id) ON DELETE CASCADE;
        DROP INDEX IF EXISTS idx_albums_name_ci;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name_scoped
            ON albums(COALESCE(parent_id, ''), LOWER(name));
        "#,
    )
    .map_err(|e| format!("v006: album parent_id migration failed: {}", e))
}
