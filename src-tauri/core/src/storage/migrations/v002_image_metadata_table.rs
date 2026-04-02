use rusqlite::{params, Connection};

use crate::storage::images::{insert_or_get_image_metadata_id, parse_image_metadata_json};

/// v1 → v2：拆出 `image_metadata` 表，按 content_hash 去重；`images.metadata` 迁入后清空。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS image_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE
        );"#,
    )
    .map_err(|e| format!("v002: create image_metadata failed: {}", e))?;

    let has_metadata_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('images') WHERE name = 'metadata_id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_metadata_id == 0 {
        conn.execute(
            "ALTER TABLE images ADD COLUMN metadata_id INTEGER REFERENCES image_metadata(id)",
            [],
        )
        .map_err(|e| format!("v002: add images.metadata_id failed: {}", e))?;
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, metadata FROM images WHERE metadata IS NOT NULL AND TRIM(metadata) != ''",
        )
        .map_err(|e| format!("v002: prepare select failed: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("v002: query metadata rows failed: {}", e))?;

    let mut update_stmt = conn
        .prepare("UPDATE images SET metadata_id = ?1, metadata = NULL WHERE id = ?2")
        .map_err(|e| format!("v002: prepare update failed: {}", e))?;

    for r in rows {
        let (id, meta_str) = r.map_err(|e| format!("v002: read row: {}", e))?;

        if parse_image_metadata_json(Some(meta_str.clone())).is_none() {
            continue;
        }

        let mid = insert_or_get_image_metadata_id(conn, &meta_str)
            .map_err(|e| format!("v002: insert metadata row: {}", e))?;

        update_stmt
            .execute(params![mid, id])
            .map_err(|e| format!("v002: update image {}: {}", id, e))?;
    }

    Ok(())
}
