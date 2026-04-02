use rusqlite::Connection;

/// v0 → v1: 将 `images.mime_type` 的媒体分类合并到 `images.type`，然后删除 `mime_type` 列。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "UPDATE images SET type = 'video'
         WHERE mime_type LIKE 'video/%'
           AND (type IS NULL OR type != 'video');
         UPDATE images SET type = 'image'
         WHERE type IS NULL;",
    )
    .map_err(|e| format!("v001: backfill type failed: {}", e))?;

    conn.execute("ALTER TABLE images DROP COLUMN mime_type", [])
        .map_err(|e| format!("v001: drop mime_type failed: {}", e))?;

    Ok(())
}
