use rusqlite::Connection;

/// 用 `album_images(album_id, "order")` 取代单列 `idx_album_images_album(album_id)`。
///
/// 往画册追加成员时要先取 `MAX("order")`。单列索引只能定位到画册的全部成员，再逐条回表读
/// `order`；标签画册动辄上万成员，metadata 迁移按批挂标签时每个叶子都要付这一次。复合索引让
/// `MAX` 变成一次索引尾部查找，且以 `album_id` 为前导列，原先走单列索引的查询都能改走它。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_album_images_album_order
             ON album_images(album_id, \"order\");
         DROP INDEX IF EXISTS idx_album_images_album;",
    )
    .map_err(|e| format!("v040 album_images order index: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn storage_v040_replaces_album_index_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE album_images (
                 album_id TEXT NOT NULL,
                 image_id INTEGER NOT NULL,
                 \"order\" INTEGER,
                 PRIMARY KEY (album_id, image_id)
             );
             CREATE INDEX idx_album_images_album ON album_images(album_id);",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let names: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('album_images') ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(names
            .iter()
            .any(|name| name == "idx_album_images_album_order"));
        assert!(!names.iter().any(|name| name == "idx_album_images_album"));

        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT MAX(\"order\") FROM album_images WHERE album_id = 'a'",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("idx_album_images_album_order"), "{plan}");
    }
}
