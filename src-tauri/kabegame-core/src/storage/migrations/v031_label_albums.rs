use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
ALTER TABLE albums ADD COLUMN label_key TEXT;
ALTER TABLE albums ADD COLUMN label_path TEXT;
CREATE UNIQUE INDEX idx_albums_label_key
    ON albums(COALESCE(parent_id, ''), LOWER(label_key)) WHERE type IN ('label', 'label_dir');
CREATE INDEX idx_albums_label_path
    ON albums(LOWER(label_path)) WHERE type IN ('label', 'label_dir');
ALTER TABLE task_failed_images ADD COLUMN labels TEXT;
"#,
    )
    .map_err(|e| format!("v031 label_albums: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_migrates_v030_schema() {
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
    ancestor_path TEXT    NOT NULL DEFAULT '',
    sync_mode     TEXT    NOT NULL DEFAULT 'none'
);
CREATE TABLE task_failed_images (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT    NOT NULL,
    plugin_id         TEXT    NOT NULL,
    url               TEXT    NOT NULL,
    "order"           INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    last_error        TEXT,
    last_attempted_at INTEGER,
    metadata_id       INTEGER,
    display_name      TEXT,
    header_snapshot   TEXT
);
"#,
        )
        .unwrap();

        super::up(&conn).unwrap();

        conn.execute(
            "INSERT INTO albums (id, name, created_at, type, label_key, label_path) VALUES ('label', 'Label', 1, 'label', 'key', 'root/key')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO albums (id, name, created_at, type, label_key, label_path) VALUES ('dir', 'Dir', 2, 'label_dir', 'KEY', 'KEY')",
                [],
            )
            .is_err());
        conn.execute(
            "INSERT INTO task_failed_images (task_id, plugin_id, url, \"order\", created_at, labels) VALUES ('task', 'plugin', 'https://example.com/a.jpg', 1, 1, '[]')",
            [],
        )
        .unwrap();

        let album: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT label_key, label_path FROM albums WHERE id = 'label'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let labels: Option<String> = conn
            .query_row(
                "SELECT labels FROM task_failed_images WHERE task_id = 'task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            album,
            (Some("key".to_string()), Some("root/key".to_string()))
        );
        assert_eq!(labels.as_deref(), Some("[]"));
    }
}
