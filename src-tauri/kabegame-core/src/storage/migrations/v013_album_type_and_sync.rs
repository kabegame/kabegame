//! albums 表增加 type / sync_folder / folder_status 三列，用于本地文件夹同步画册。
//! 已有数据全部为 type='normal'，sync_folder / folder_status 为 NULL；行为不变。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
ALTER TABLE albums ADD COLUMN type          TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE albums ADD COLUMN sync_folder   TEXT;
ALTER TABLE albums ADD COLUMN folder_status TEXT;
"#,
    )
    .map_err(|e| format!("v013 alter albums: {e}"))?;
    Ok(())
}
