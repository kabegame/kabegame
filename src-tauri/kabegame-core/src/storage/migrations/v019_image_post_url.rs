use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE images ADD COLUMN post_url TEXT;
COMMIT;
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v019 alter images: {e}")
    })
}
