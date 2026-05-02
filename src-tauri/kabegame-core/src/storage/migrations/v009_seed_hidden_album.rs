use rusqlite::Connection;
use uuid::Uuid;

const HIDDEN_ALBUM_ID: &str = "00000000-0000-0000-0000-000000000000";

pub fn up(conn: &Connection) -> Result<(), String> {
    // 1) seed 隐藏画册（幂等：先 EXISTS 检查）。
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
            [HIDDEN_ALBUM_ID],
            |row| row.get(0),
        )
        .map_err(|e| format!("v009 seed check: {e}"))?;

    if !exists {
        let name = format!("hidden-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("v009 time: {e}"))?
            .as_secs() as i64;
        conn.execute(
            "INSERT INTO albums (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, NULL)",
            rusqlite::params![HIDDEN_ALBUM_ID, name, created_at],
        )
        .map_err(|e| format!("v009 seed insert: {e}"))?;
    }

    // 2) 打平 parent_id = HIDDEN 的子画册到根，重名时追加 (n)。
    let children: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name FROM albums WHERE parent_id = ?1")
            .map_err(|e| format!("v009 prepare: {e}"))?;
        let rows = stmt
            .query_map([HIDDEN_ALBUM_ID], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("v009 query: {e}"))?;
        rows.collect::<Result<Vec<(String, String)>, _>>()
            .map_err(|e| format!("v009 collect: {e}"))?
    };

    for (id, name) in children {
        let final_name = resolve_name(conn, &name)?;
        conn.execute(
            "UPDATE albums SET name = ?1, parent_id = NULL WHERE id = ?2",
            rusqlite::params![final_name, id],
        )
        .map_err(|e| format!("v009 update {id}: {e}"))?;
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
        .map_err(|e| format!("v009 name check: {e}"))?;
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
            .map_err(|e| format!("v009 name check ({n}): {e}"))?;
        if !taken {
            return Ok(candidate);
        }
        n += 1;
    }
}
