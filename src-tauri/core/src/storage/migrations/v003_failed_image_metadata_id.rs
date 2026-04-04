use rusqlite::Connection;

/// v2 → v3：`task_failed_images` 增加 `metadata_id`，便于重试成功后关联 `image_metadata`。
pub fn up(conn: &Connection) -> Result<(), String> {
    let has_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('task_failed_images') WHERE name = 'metadata_id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_col == 0 {
        conn.execute(
            "ALTER TABLE task_failed_images ADD COLUMN metadata_id INTEGER REFERENCES image_metadata(id)",
            [],
        )
        .map_err(|e| format!("v003: add task_failed_images.metadata_id failed: {}", e))?;
    }
    Ok(())
}
