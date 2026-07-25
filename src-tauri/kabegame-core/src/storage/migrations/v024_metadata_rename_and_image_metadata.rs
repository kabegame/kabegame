use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE image_metadata RENAME TO metadata;
DROP INDEX idx_image_metadata_dedup;
CREATE INDEX idx_metadata_dedup ON metadata(plugin_id, plugin_version);
CREATE TABLE image_metadata (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    data           TEXT    NOT NULL,
    parser_version INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE images
    ADD COLUMN image_metadata_id INTEGER REFERENCES image_metadata(id);
COMMIT;
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v024 rename metadata and add image metadata: {e}")
    })
}
