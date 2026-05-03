use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS plugin_data (
    plugin_id  TEXT    PRIMARY KEY,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
"#,
    )
    .map_err(|e| format!("v010 plugin_data: {e}"))?;
    Ok(())
}
