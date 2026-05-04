//! Backfill width/height for existing mp4/mov rows whose columns are NULL.
//! Missing, corrupted, and Android content:// files are skipped without
//! failing the migration.

use rusqlite::{params, Connection};

pub fn up(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, local_path FROM images
             WHERE (width IS NULL OR height IS NULL)
               AND (lower(local_path) LIKE '%.mp4'
                    OR lower(local_path) LIKE '%.mov')",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    if rows.is_empty() {
        return Ok(());
    }

    conn.execute_batch("BEGIN")
        .map_err(|e| format!("begin: {e}"))?;
    let mut updated = 0usize;
    for (id, path) in &rows {
        if path.starts_with("content://") {
            eprintln!("[v012] skip id={id} (content:// handled by live path)");
            continue;
        }
        match crate::media_dimensions::resolve_video_dimensions_sync(path) {
            Some((w, h)) => {
                if let Err(e) = conn.execute(
                    "UPDATE images SET width = ?1, height = ?2 WHERE id = ?3",
                    params![w as i64, h as i64, id],
                ) {
                    eprintln!("[v012] update id={id} failed: {e}");
                } else {
                    updated += 1;
                }
            }
            None => eprintln!("[v012] skip id={id} path={path} (unreadable/unparseable)"),
        }
    }
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("commit: {e}"))?;
    println!(
        "[v012] backfilled {}/{} video dimensions",
        updated,
        rows.len()
    );
    Ok(())
}
