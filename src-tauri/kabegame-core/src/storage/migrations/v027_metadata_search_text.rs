use crate::storage::metadata_search_text::search_text_from_json_str;
use rusqlite::{params, Connection};

fn backfill_metadata(conn: &Connection) -> Result<usize, String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, data FROM metadata")
            .map_err(|e| format!("v027 prepare metadata backfill: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("v027 query metadata backfill: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v027 collect metadata backfill: {e}"))?;
        rows
    };

    for (id, data) in &rows {
        conn.execute(
            "UPDATE metadata SET search_text = ?1 WHERE id = ?2",
            params![search_text_from_json_str(data), id],
        )
        .map_err(|e| format!("v027 update metadata id={id}: {e}"))?;
    }
    Ok(rows.len())
}

fn backfill_image_metadata(conn: &Connection) -> Result<usize, String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, data FROM image_metadata")
            .map_err(|e| format!("v027 prepare image_metadata backfill: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("v027 query image_metadata backfill: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v027 collect image_metadata backfill: {e}"))?;
        rows
    };

    for (id, data) in &rows {
        conn.execute(
            "UPDATE image_metadata SET search_text = ?1 WHERE id = ?2",
            params![search_text_from_json_str(data), id],
        )
        .map_err(|e| format!("v027 update image_metadata id={id}: {e}"))?;
    }
    Ok(rows.len())
}

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE metadata ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE image_metadata ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
"#,
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v027 add metadata search_text columns: {e}")
    })?;

    let result = (|| {
        let metadata_count = backfill_metadata(conn)?;
        let image_metadata_count = backfill_image_metadata(conn)?;
        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("v027 commit metadata search_text: {e}"))?;
        Ok((metadata_count, image_metadata_count))
    })();

    match result {
        Ok((metadata_count, image_metadata_count)) => {
            println!("[v027] backfilled {metadata_count} metadata rows");
            println!("[v027] backfilled {image_metadata_count} image_metadata rows");
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
    fn run_pending_adds_and_backfills_both_search_text_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE metadata (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    plugin_version INTEGER,
    plugin_id TEXT
);
CREATE TABLE image_metadata (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    parser_version INTEGER
);
INSERT INTO metadata (id, data) VALUES (1, '{"author":{"name":"Ada"}}');
INSERT INTO image_metadata (id, data) VALUES (1, '{"camera":"Canon"}');
PRAGMA user_version = 26;
"#,
        )
        .unwrap();

        crate::storage::migrations::run_pending(&conn).unwrap();

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let metadata_search: String = conn
            .query_row("SELECT search_text FROM metadata WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let image_metadata_search: String = conn
            .query_row(
                "SELECT search_text FROM image_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(version, 27);
        assert_eq!(metadata_search, "author\nname\nAda");
        assert_eq!(image_metadata_search, "camera\nCanon");
    }
}
