use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE albums ADD COLUMN ancestor_path TEXT NOT NULL DEFAULT '';
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v028 add albums.ancestor_path: {e}")
    })?;

    let result = (|| -> Result<(usize, usize), String> {
        // 与 albums::rebuild_album_ancestor_paths 同构，此处内联以保持迁移自包含。
        conn.execute(
            r#"
WITH RECURSIVE tree(id, path) AS (
    SELECT id, '/' || id || '/' FROM albums WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, tree.path || a.id || '/'
      FROM albums a JOIN tree ON a.parent_id = tree.id
)
UPDATE albums SET ancestor_path = tree.path
  FROM tree WHERE albums.id = tree.id
"#,
            [],
        )
        .map_err(|e| format!("v028 backfill ancestor_path: {e}"))?;

        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM albums", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| format!("v028 count albums: {e}"))? as usize;
        let orphan: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM albums WHERE ancestor_path = ''",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("v028 count orphan: {e}"))? as usize;

        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("v028 commit: {e}"))?;
        Ok((total, orphan))
    })();

    match result {
        Ok((total, orphan)) => {
            println!("[v028] backfilled {} album ancestor paths", total - orphan);
            if orphan > 0 {
                eprintln!(
                    "[v028] {orphan} albums unreachable from any root (cycle?) — ancestor_path left empty"
                );
            }
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn run_pending_adds_and_backfills_album_ancestor_path() {
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
    folder_status TEXT
);
INSERT INTO albums (id, name, created_at, parent_id) VALUES
    ('a', 'a', 1, NULL),
    ('b', 'b', 2, 'a'),
    ('c', 'c', 3, 'b');
PRAGMA user_version = 27;
"#,
        )
        .unwrap();

        crate::storage::migrations::run_pending(&conn).unwrap();

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let root_path: String = conn
            .query_row(
                "SELECT ancestor_path FROM albums WHERE id = 'a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let leaf_path: String = conn
            .query_row(
                "SELECT ancestor_path FROM albums WHERE id = 'c'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(version, 28);
        assert_eq!(root_path, "/a/");
        assert_eq!(leaf_path, "/a/b/c/");
    }
}
