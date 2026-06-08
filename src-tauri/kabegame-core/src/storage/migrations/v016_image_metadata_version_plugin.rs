use rusqlite::Connection;

fn foreign_key_violation_count(conn: &Connection) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| format!("v016 prepare foreign_key_check: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("v016 run foreign_key_check: {e}"))?;
    let mut count = 0usize;
    while rows
        .next()
        .map_err(|e| format!("v016 read foreign_key_check: {e}"))?
        .is_some()
    {
        count += 1;
    }
    Ok(count)
}

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys=OFF;")
        .map_err(|e| format!("v016 disable foreign_keys: {e}"))?;

    let result = conn.execute_batch(
        r#"
DROP TABLE IF EXISTS image_metadata_new;

CREATE TABLE image_metadata_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    data         TEXT    NOT NULL,
    content_hash TEXT    NOT NULL,
    version      INTEGER NOT NULL DEFAULT 0,
    plugin_id    TEXT    NOT NULL DEFAULT ''
);

INSERT INTO image_metadata_new (id, data, content_hash, version, plugin_id)
SELECT id,
       data,
       content_hash,
       0,
       COALESCE(
           (SELECT i.plugin_id FROM images i WHERE i.metadata_id = image_metadata.id LIMIT 1),
           (SELECT f.plugin_id FROM task_failed_images f WHERE f.metadata_id = image_metadata.id LIMIT 1),
           ''
       )
  FROM image_metadata;

DROP TABLE image_metadata;
ALTER TABLE image_metadata_new RENAME TO image_metadata;

CREATE UNIQUE INDEX idx_image_metadata_dedup
    ON image_metadata(plugin_id, version, content_hash);
"#,
    );

    if let Err(e) = result {
        let _ = conn.execute_batch("PRAGMA foreign_keys=ON;");
        return Err(format!("v016 rebuild image_metadata: {e}"));
    }

    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("v016 restore foreign_keys: {e}"))?;

    let violations = foreign_key_violation_count(conn)?;
    if violations != 0 {
        return Err(format!(
            "v016 foreign_key_check found {violations} violation(s)"
        ));
    }

    Ok(())
}
