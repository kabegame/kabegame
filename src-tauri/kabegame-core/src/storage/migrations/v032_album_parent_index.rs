use rusqlite::Connection;

/// 为 `albums.parent_id` 建立单列索引。
///
/// 此前唯一以 `parent_id` 开头的索引 `idx_albums_name_scoped` 建在表达式
/// `COALESCE(parent_id, '')` 上，`WHERE parent_id = ?` 用不上它，只能全表扫描。
/// 画册树按目录列举子画册、给每个子画册数子画册时每行都要扫一遍 `albums`：
/// 1.3 万个画册（大量标签）下，给 4675 个子项计数约 1.8s，加索引后降到毫秒级。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_albums_parent ON albums(parent_id);")
        .map_err(|e| format!("v032 create idx_albums_parent: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_creates_parent_index_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE albums (id TEXT PRIMARY KEY, parent_id TEXT);")
            .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM albums WHERE parent_id = 'x'",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("idx_albums_parent"), "{plan}");
    }
}
