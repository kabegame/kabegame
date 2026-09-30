use rusqlite::Connection;

/// 为 `run_configs` 增加 `output_album_id`：定时任务触发时把本次抓取结果直接写入指定画册。
///
/// 与 `output_dir` 并列，均为可空；旧数据保持 NULL（沿用插件/全局默认落库行为）。
/// ALTER TABLE 本身不幂等，先查 `PRAGMA table_info` 确认列不存在再执行。
pub fn up(conn: &Connection) -> Result<(), String> {
    let exists = conn
        .prepare("PRAGMA table_info(run_configs)")
        .and_then(|mut stmt| {
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for name in names {
                if name? == "output_album_id" {
                    found = true;
                    break;
                }
            }
            Ok(found)
        })
        .map_err(|e| format!("v034 inspect run_configs columns: {e}"))?;

    if exists {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE run_configs ADD COLUMN output_album_id TEXT;",
        [],
    )
    .map_err(|e| format!("v034 add run_configs.output_album_id: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_output_album_id_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE run_configs (id TEXT PRIMARY KEY);")
            .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(run_configs)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns
                .iter()
                .filter(|name| name.as_str() == "output_album_id")
                .count(),
            1,
            "{columns:?}"
        );

        conn.execute(
            "INSERT INTO run_configs (id, output_album_id) VALUES ('c', 'a')",
            [],
        )
        .unwrap();
        let value: Option<String> = conn
            .query_row(
                "SELECT output_album_id FROM run_configs WHERE id = 'c'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value.as_deref(), Some("a"));
    }
}
