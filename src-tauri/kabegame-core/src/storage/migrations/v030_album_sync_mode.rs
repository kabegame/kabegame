use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "ALTER TABLE albums ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'none';",
        [],
    )
    .map_err(|e| format!("v030 add albums.sync_mode: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_album_sync_mode_without_backfill() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE albums (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    parent_id     TEXT    REFERENCES albums(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL DEFAULT 'normal',
    sync_folder   TEXT,
    folder_status TEXT,
    ancestor_path TEXT    NOT NULL DEFAULT ''
);
INSERT INTO albums (id, name, created_at, type, sync_folder, ancestor_path)
VALUES ('local', 'local', 1, 'local_folder', '/library', '/local/');
"#,
        )
        .unwrap();

        super::up(&conn).unwrap();

        let sync_mode: String = conn
            .query_row(
                "SELECT sync_mode FROM albums WHERE id = 'local'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(sync_mode, "none");
    }
}
