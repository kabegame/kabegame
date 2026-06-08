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
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;

ALTER TABLE image_metadata
    ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE image_metadata
    ADD COLUMN plugin_id TEXT NOT NULL DEFAULT '';

UPDATE image_metadata
   SET plugin_id = COALESCE(
       (SELECT i.plugin_id
          FROM images i
         WHERE i.metadata_id = image_metadata.id
         LIMIT 1),
       (SELECT f.plugin_id
          FROM task_failed_images f
         WHERE f.metadata_id = image_metadata.id
         LIMIT 1),
       ''
   );

CREATE INDEX idx_image_metadata_dedup
    ON image_metadata(plugin_id, version);

COMMIT;
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v016 alter image_metadata: {e}")
    })?;

    let violations = foreign_key_violation_count(conn)?;
    if violations != 0 {
        return Err(format!(
            "v016 foreign_key_check found {violations} violation(s)"
        ));
    }

    Ok(())
}