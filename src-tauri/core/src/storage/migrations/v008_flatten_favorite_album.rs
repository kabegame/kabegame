use rusqlite::Connection;

const FAVORITE_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000001";

pub fn up(conn: &Connection) -> Result<(), String> {
    let children: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name FROM albums WHERE parent_id = ?1")
            .map_err(|e| format!("v008 prepare: {e}"))?;
        let rows = stmt
            .query_map([FAVORITE_ALBUM_ID], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("v008 query: {e}"))?;
        rows.collect::<Result<Vec<(String, String)>, _>>()
            .map_err(|e| format!("v008 collect: {e}"))?
    };

    for (id, name) in children {
        let final_name = resolve_name(conn, &name)?;
        conn.execute(
            "UPDATE albums SET name = ?1, parent_id = NULL WHERE id = ?2",
            rusqlite::params![final_name, id],
        )
        .map_err(|e| format!("v008 update {id}: {e}"))?;
    }
    Ok(())
}

fn resolve_name(conn: &Connection, name: &str) -> Result<String, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM albums WHERE parent_id IS NULL AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(|e| format!("v008 name check: {e}"))?;
    if !exists {
        return Ok(name.to_string());
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{name} ({n})");
        let taken: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE parent_id IS NULL AND name = ?1)",
                [&candidate],
                |row| row.get(0),
            )
            .map_err(|e| format!("v008 name check ({n}): {e}"))?;
        if !taken {
            return Ok(candidate);
        }
        n += 1;
    }
}
