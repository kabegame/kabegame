//! 为 metadata 增加 `template`：CLI `plugin run --freeze-template` 冻结的插件描述 EJS 模板。
//!
//! 可空，NULL 表示未冻结；非空时详情面板用它覆盖插件包内模板（测试 id 未安装也能渲染）。
//! 与 `data` 一样随行按 id 不可变，metadata 迁移原样带到新行。

use rusqlite::Connection;

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut stmt| {
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            for name in names {
                if name? == column {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|e| format!("v047 inspect {table} columns: {e}"))
}

pub fn up(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "metadata", "template")? {
        conn.execute("ALTER TABLE metadata ADD COLUMN template TEXT;", [])
            .map_err(|e| format!("v047 add metadata.template: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_nullable_template_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE metadata (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 data TEXT NOT NULL,
                 plugin_version INTEGER NOT NULL DEFAULT 0,
                 plugin_id TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO metadata (data, plugin_id) VALUES ('{}', 'demo');",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(metadata)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns
                .iter()
                .filter(|name| name.as_str() == "template")
                .count(),
            1,
            "{columns:?}"
        );
        assert_eq!(
            conn.query_row("SELECT template FROM metadata", [], |row| row
                .get::<_, Option<String>>(0))
                .unwrap(),
            None
        );
    }
}
