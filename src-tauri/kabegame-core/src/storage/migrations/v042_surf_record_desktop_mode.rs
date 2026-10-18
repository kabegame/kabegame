//! 为畅游记录增加 `desktop_mode`：安卓畅游按站点记住是否用桌面版网站打开。
//!
//! 只存布尔值，不存 UA 串：桌面 UA 由当前系统 WebView 默认 UA 派生（见
//! `plugin::v8::android_desktop_user_agent`），WebView 升级后不会留下旧 Chrome 版本。

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
        .map_err(|e| format!("v042 inspect {table} columns: {e}"))
}

pub fn up(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "surf_records", "desktop_mode")? {
        conn.execute(
            "ALTER TABLE surf_records ADD COLUMN desktop_mode INTEGER NOT NULL DEFAULT 0;",
            [],
        )
        .map_err(|e| format!("v042 add surf_records.desktop_mode: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_desktop_mode_default_false_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE surf_records (id TEXT PRIMARY KEY);
             INSERT INTO surf_records (id) VALUES ('surf-1');",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(surf_records)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns
                .iter()
                .filter(|name| name.as_str() == "desktop_mode")
                .count(),
            1,
            "{columns:?}"
        );
        assert_eq!(
            conn.query_row(
                "SELECT desktop_mode FROM surf_records WHERE id = 'surf-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }
}
