//! 给 `album_images` 补上指向 `albums` / `images` 的外键。
//!
//! 此前成员表没有外键，写入口不校验画册与图片是否存在：传入不存在的画册 id 或空图片 id 也会落库，
//! 还会按不存在的 id 拼出路径广播成员事件。SQLite 不能给已有表追加外键，只能重建；重建时只搬
//! 两端都存在的成员行，悬空的成员行（画册已删、图片已删或 image_id 根本不是图片 id）一并清掉。
//! 两条外键都是 `ON DELETE CASCADE`，删画册 / 删图片的显式成员删除继续保留，外键只是兜底。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM album_images AS ai
              WHERE NOT EXISTS (SELECT 1 FROM albums WHERE albums.id = ai.album_id)
                 OR NOT EXISTS (SELECT 1 FROM images WHERE images.id = ai.image_id)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("v046 count orphan album_images: {e}"))?;
    if orphans > 0 {
        tracing::info!("v046: 清理 {orphans} 条悬空画册成员");
    }

    conn.execute_batch(
        r#"
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE album_images_new (
    album_id TEXT    NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    "order"  INTEGER,
    PRIMARY KEY (album_id, image_id)
);

-- 只搬两端都存在的行：画册已删、图片已删、image_id 不是图片 id 的脏数据在这里丢弃
INSERT INTO album_images_new (album_id, image_id, "order")
SELECT ai.album_id, ai.image_id, ai."order"
  FROM album_images AS ai
 WHERE EXISTS (SELECT 1 FROM albums WHERE albums.id = ai.album_id)
   AND EXISTS (SELECT 1 FROM images WHERE images.id = ai.image_id);

DROP TABLE album_images;
ALTER TABLE album_images_new RENAME TO album_images;

CREATE INDEX idx_album_images_album_order ON album_images(album_id, "order");
CREATE INDEX idx_album_images_image ON album_images(image_id);

COMMIT;

PRAGMA foreign_keys = ON;
"#,
    )
    .map_err(|e| format!("v046 album_images foreign keys: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, local_path TEXT NOT NULL);
            CREATE TABLE album_images (
                album_id TEXT    NOT NULL,
                image_id INTEGER NOT NULL,
                "order"  INTEGER,
                PRIMARY KEY (album_id, image_id)
            );
            CREATE INDEX idx_album_images_album_order ON album_images(album_id, "order");
            CREATE INDEX idx_album_images_image ON album_images(image_id);
            INSERT INTO albums VALUES ('a', 'A'), ('b', 'B');
            INSERT INTO images (id, local_path) VALUES (1, '/1'), (2, '/2');
            INSERT INTO album_images VALUES
              ('a', 1, 10), ('a', 2, 20), ('b', 2, NULL),
              ('gone', 1, 1),            -- 画册不存在
              ('a', 99, 2),              -- 图片不存在
              ('a', '', 3),              -- image_id 不是图片 id
              ('a 8623', '', 4);         -- 实际出现过的误传参数
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn storage_v046_drops_orphans_and_enforces_foreign_keys() {
        let conn = legacy_db();
        super::up(&conn).unwrap();

        let rows: Vec<(String, i64, Option<i64>)> = conn
            .prepare("SELECT album_id, image_id, \"order\" FROM album_images ORDER BY album_id, image_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("a".to_string(), 1, Some(10)),
                ("a".to_string(), 2, Some(20)),
                ("b".to_string(), 2, None),
            ]
        );
        let violations: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check('album_images')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(violations, 0);

        // 外键生效：不存在的画册 / 图片插不进去，删父行级联清掉成员
        assert!(conn
            .execute("INSERT INTO album_images VALUES ('gone', 1, 1)", [])
            .is_err());
        assert!(conn
            .execute("INSERT INTO album_images VALUES ('a', '', 1)", [])
            .is_err());
        conn.execute("DELETE FROM images WHERE id = 2", []).unwrap();
        conn.execute("DELETE FROM albums WHERE id = 'a'", [])
            .unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM album_images", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);

        let indexes: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'album_images' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            indexes,
            ["idx_album_images_album_order", "idx_album_images_image"]
        );
    }
}
