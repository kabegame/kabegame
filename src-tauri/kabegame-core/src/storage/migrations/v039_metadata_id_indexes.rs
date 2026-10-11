use rusqlite::Connection;

/// 为 `images.metadata_id` 与 `task_failed_images.metadata_id` 建索引。
///
/// metadata 行按 id 不可变：迁移写回内容变化时插入新行（或合并到已有相同内容行），再把这两张表的引用改指向
/// 新 id 并删除旧行。每处理一行都要按 `metadata_id` 找图片、改指向，没有索引时各是一次全表扫描。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_images_metadata_id ON images(metadata_id);
         CREATE INDEX IF NOT EXISTS idx_task_failed_images_metadata_id
             ON task_failed_images(metadata_id);",
    )
    .map_err(|e| format!("v039 create metadata id indexes: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn storage_v039_creates_metadata_id_indexes_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, metadata_id INTEGER);
             CREATE TABLE task_failed_images (id INTEGER PRIMARY KEY, metadata_id INTEGER);",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        for (table, index) in [
            ("images", "idx_images_metadata_id"),
            ("task_failed_images", "idx_task_failed_images_metadata_id"),
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM pragma_index_list(?1) WHERE name = ?2
                     )",
                    (table, index),
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing index {index}");
        }
    }
}
