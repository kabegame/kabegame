use crate::storage::metadata_search_text::native_search_text_from_json_str;
use rusqlite::{params, Connection};

/// 按「只收值、不收键名」重算全部 `image_metadata.search_text`。
///
/// 原生元数据由内置解析器生成，结构键（format / groups / id / subtitle / entries / tag / value）
/// 每行都有：之前的展开规则把它们一并收进 search_text，搜这些词会命中全部图片。数据量很小
/// （prod 2.5 万行 / 约 3MB），一次性在事务里重写；值未变的行跳过，重复执行是 no-op。
pub fn up(conn: &Connection) -> Result<(), String> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, data, search_text FROM image_metadata")
            .map_err(|e| format!("v038 prepare image_metadata: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("v038 query image_metadata: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v038 collect image_metadata: {e}"))?;
        rows
    };

    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| format!("v038 begin: {e}"))?;
    let result = (|| {
        let mut update = conn
            .prepare_cached("UPDATE image_metadata SET search_text = ?1 WHERE id = ?2")
            .map_err(|e| format!("v038 prepare update: {e}"))?;
        let mut updated = 0usize;
        for (id, data, current) in &rows {
            let search_text = native_search_text_from_json_str(data);
            if &search_text != current {
                update
                    .execute(params![search_text, id])
                    .map_err(|e| format!("v038 update image_metadata id={id}: {e}"))?;
                updated += 1;
            }
        }
        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("v038 commit: {e}"))?;
        Ok(updated)
    })();

    match result {
        Ok(updated) => {
            println!(
                "[v038] rewrote {updated}/{} image_metadata search_text",
                rows.len()
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

    #[test]
    fn v038_rewrites_native_search_text_without_keys_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"CREATE TABLE image_metadata (
                   id INTEGER PRIMARY KEY,
                   data TEXT NOT NULL,
                   search_text TEXT NOT NULL DEFAULT '',
                   parser_version INTEGER NOT NULL DEFAULT 0
               );
               INSERT INTO image_metadata (id, data, search_text) VALUES
                   (1, '{"format":"jpeg","partial":false,"groups":[]}', 'format
jpeg
partial
groups'),
                   (2, '{"format":"png","partial":false,"groups":[{"id":"ihdr","subtitle":"IHDR","entries":[{"tag":"Width","value":"2500"}]}]}', ''),
                   (3, '{invalid', 'stale');"#,
        )
        .unwrap();

        super::up(&conn).unwrap();
        let texts: Vec<String> = conn
            .prepare("SELECT search_text FROM image_metadata ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(texts, ["jpeg", "png\nihdr\nIHDR\nWidth\n2500", ""]);

        super::up(&conn).unwrap();
        let again: String = conn
            .query_row(
                "SELECT search_text FROM image_metadata WHERE id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(again, texts[1]);
    }
}
