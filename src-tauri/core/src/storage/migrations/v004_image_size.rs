use rusqlite::Connection;

/// v3 → v4：`images` 增加 `size` 列，存储图片的磁盘大小（字节）。
pub fn up(conn: &Connection) -> Result<(), String> {
    let has_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('images') WHERE name = 'size'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_col == 0 {
        conn.execute("ALTER TABLE images ADD COLUMN size INTEGER", [])
            .map_err(|e| format!("v004: add images.size failed: {}", e))?;
    }
    Ok(())
}
