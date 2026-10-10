use crate::storage::search_terms::normalize_search_terms;
use rusqlite::{params, Connection};
use std::collections::HashMap;

fn metadata_has_search_text(conn: &Connection) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(metadata)")
        .map_err(|e| format!("v037 inspect metadata columns: {e}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("v037 query metadata columns: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("v037 collect metadata columns: {e}"))?;
    Ok(columns.iter().any(|column| column == "search_text"))
}

fn backfill(conn: &Connection) -> Result<(usize, usize), String> {
    let rows = {
        let mut stmt = conn
            .prepare("SELECT id, search_text FROM metadata ORDER BY id")
            .map_err(|e| format!("v037 prepare metadata backfill: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("v037 query metadata backfill: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v037 collect metadata backfill: {e}"))?;
        rows
    };

    let mut term_ids = HashMap::<String, i64>::new();
    let mut mapping_count = 0usize;
    let mut upsert_term = conn
        .prepare_cached(
            "INSERT INTO search_terms (text) VALUES (?1)
             ON CONFLICT(text) DO UPDATE SET text = excluded.text
             RETURNING id",
        )
        .map_err(|e| format!("v037 prepare search term upsert: {e}"))?;
    let mut insert_mapping = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO metadata_search_terms (metadata_id, term_id)
             VALUES (?1, ?2)",
        )
        .map_err(|e| format!("v037 prepare metadata search term mapping: {e}"))?;

    for (metadata_id, search_text) in &rows {
        let terms = normalize_search_terms(search_text.split('\n').map(str::to_string));
        for term in terms {
            let term_id = match term_ids.get(&term) {
                Some(id) => *id,
                None => {
                    let id = upsert_term
                        .query_row(params![term], |row| row.get::<_, i64>(0))
                        .map_err(|e| format!("v037 upsert search term: {e}"))?;
                    term_ids.insert(term, id);
                    id
                }
            };
            mapping_count += insert_mapping
                .execute(params![metadata_id, term_id])
                .map_err(|e| format!("v037 insert metadata search term mapping: {e}"))?;
        }
    }
    Ok((rows.len(), mapping_count))
}

pub fn up(conn: &Connection) -> Result<(), String> {
    let has_search_text = metadata_has_search_text(conn)?;
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS search_terms (
    id   INTEGER PRIMARY KEY,
    text TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS metadata_search_terms (
    metadata_id INTEGER NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
    term_id     INTEGER NOT NULL REFERENCES search_terms(id),
    PRIMARY KEY (term_id, metadata_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_metadata_search_terms_metadata
    ON metadata_search_terms(metadata_id);
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v037 create metadata search term tables: {e}")
    })?;

    let result = (|| {
        let counts = if has_search_text {
            let counts = backfill(conn)?;
            conn.execute_batch("ALTER TABLE metadata DROP COLUMN search_text;")
                .map_err(|e| format!("v037 drop metadata.search_text: {e}"))?;
            counts
        } else {
            (0, 0)
        };
        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("v037 commit metadata search terms: {e}"))?;
        Ok(counts)
    })();

    match result {
        Ok((metadata_count, mapping_count)) => {
            println!(
                "[v037] backfilled {metadata_count} metadata rows and {mapping_count} mappings"
            );
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

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE metadata (
                 id INTEGER PRIMARY KEY,
                 data TEXT NOT NULL,
                 search_text TEXT NOT NULL DEFAULT '',
                 plugin_version INTEGER NOT NULL DEFAULT 0,
                 plugin_id TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO metadata (id, data, search_text) VALUES
                 (1, '{}', 'alpha\nbeta\nalpha\n'),
                 (2, '{}', 'beta\ngamma');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn v037_backfills_split_terms_drops_column_and_is_idempotent() {
        let conn = conn();
        super::up(&conn).unwrap();

        let terms: Vec<String> = conn
            .prepare("SELECT text FROM search_terms ORDER BY text")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(terms, ["alpha", "beta", "gamma"]);
        let mapping_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM metadata_search_terms", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mapping_count, 4);
        assert!(!super::metadata_has_search_text(&conn).unwrap());

        super::up(&conn).unwrap();
        let mapping_count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM metadata_search_terms", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mapping_count_after, mapping_count);
    }

    #[test]
    fn v037_metadata_delete_cascades_mappings() {
        let conn = conn();
        super::up(&conn).unwrap();
        conn.execute("DELETE FROM metadata WHERE id = 1", [])
            .unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM metadata_search_terms WHERE metadata_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
