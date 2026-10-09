use rusqlite::Connection;

/// `images.aspect_ratio`：宽高比数值的 VIRTUAL 生成列 + 索引，由 SQLite 随 width/height 自动维护。
///
/// 宽高比筛选、分桶列举、按宽高比排序此前各自从 width/height 现算（整数交叉乘法或
/// `CAST(width AS REAL) / NULLIF(height, 0)`），排序每次都要全量计算再排。改为统一读这一列：
/// 宽高任一缺失或 <= 0 时为 NULL（归入 `other` 桶）。IEEE 除法正确舍入，`w/h` 与 `16.0/9`
/// 这类边界常量对同一有理数得到同一个 double，桶边界与原整数比较逐行一致（100 万行实测）。
///
/// 只能是 VIRTUAL：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 STORED，后者要重建整张 images 表。
/// 值落在索引里，排序直接按索引顺序读（100 万行一页从约 550ms 到 1ms 以内）；逐行过滤时
/// VIRTUAL 现算的开销与 STORED 只差约 20ms / 100 万行，不值得重建。
pub fn up(conn: &Connection) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_xinfo('images') WHERE name = 'aspect_ratio')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("v036 inspect images columns: {e}"))?;
    if !exists {
        conn.execute_batch(
            "ALTER TABLE images ADD COLUMN aspect_ratio REAL GENERATED ALWAYS AS (
                CASE WHEN width > 0 AND height > 0 THEN CAST(width AS REAL) / height END
            ) VIRTUAL;",
        )
        .map_err(|e| format!("v036 add images.aspect_ratio: {e}"))?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_images_aspect_ratio ON images(aspect_ratio);",
    )
    .map_err(|e| format!("v036 create idx_images_aspect_ratio: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_adds_generated_aspect_ratio_with_index_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE images (id INTEGER PRIMARY KEY, width INTEGER, height INTEGER);
             INSERT INTO images VALUES (1, 1920, 1080), (2, NULL, 100), (3, 0, 100), (4, 100, 0);",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let ratios: Vec<Option<f64>> = conn
            .prepare("SELECT aspect_ratio FROM images ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ratios, vec![Some(16.0 / 9.0), None, None, None]);

        // 写入后自动维护，无需应用参与；16:9 与边界常量严格相等
        conn.execute("UPDATE images SET width = 4, height = 3 WHERE id = 2", [])
            .unwrap();
        let (r2, at_16_9): (f64, bool) = conn
            .query_row(
                "SELECT (SELECT aspect_ratio FROM images WHERE id = 2), \
                        (SELECT aspect_ratio = 16.0 / 9 FROM images WHERE id = 1)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(r2, 4.0 / 3.0);
        assert!(at_16_9);

        let plan: Vec<String> = conn
            .prepare("EXPLAIN QUERY PLAN SELECT id FROM images ORDER BY aspect_ratio, id LIMIT 10")
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|d| d.contains("idx_images_aspect_ratio")),
            "{plan:?}"
        );
    }
}
