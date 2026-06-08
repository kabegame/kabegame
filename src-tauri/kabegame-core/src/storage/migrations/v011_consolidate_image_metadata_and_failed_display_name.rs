use rusqlite::Connection;
use sha2::{Digest, Sha256};

fn metadata_content_hash_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for &b in digest.as_slice() {
        s.push(char::from(HEX[(b >> 4) as usize]));
        s.push(char::from(HEX[(b & 0xf) as usize]));
    }
    s
}

fn insert_or_get_v011_image_metadata_id(conn: &Connection, data_json: &str) -> Result<i64, String> {
    let hash = metadata_content_hash_hex(data_json.as_bytes());
    conn.execute(
        "INSERT OR IGNORE INTO image_metadata (data, content_hash) VALUES (?1, ?2)",
        rusqlite::params![data_json, hash],
    )
    .map_err(|e| format!("v011 insert image_metadata: {e}"))?;
    conn.query_row(
        "SELECT id FROM image_metadata WHERE content_hash = ?1",
        rusqlite::params![hash],
        |r| r.get(0),
    )
    .map_err(|e| format!("v011 select image_metadata id: {e}"))
}

pub fn up(conn: &Connection) -> Result<(), String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, metadata FROM images
                 WHERE metadata IS NOT NULL
                   AND TRIM(metadata) <> ''
                   AND metadata_id IS NULL",
            )
            .map_err(|e| format!("v011 prepare select legacy metadata: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("v011 query legacy metadata: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v011 collect legacy metadata: {e}"))?;
        rows
    };

    for (image_id, metadata_json) in rows {
        let metadata_id = insert_or_get_v011_image_metadata_id(conn, &metadata_json)?;
        conn.execute(
            "UPDATE images SET metadata_id = ?1, metadata = NULL WHERE id = ?2",
            rusqlite::params![metadata_id, image_id],
        )
        .map_err(|e| format!("v011 update images.metadata_id: {e}"))?;
    }

    conn.execute_batch("ALTER TABLE images DROP COLUMN metadata;")
        .map_err(|e| format!("v011 drop images.metadata: {e}"))?;

    conn.execute_batch("ALTER TABLE task_failed_images ADD COLUMN display_name TEXT;")
        .map_err(|e| format!("v011 add task_failed_images.display_name: {e}"))?;

    conn.execute_batch(
        "DELETE FROM image_metadata
         WHERE id NOT IN (SELECT metadata_id FROM images WHERE metadata_id IS NOT NULL)
           AND id NOT IN (SELECT metadata_id FROM task_failed_images WHERE metadata_id IS NOT NULL);",
    )
    .map_err(|e| format!("v011 gc orphan image_metadata: {e}"))?;

    Ok(())
}
