//! 壁纸色盘与按颜色排序的存储：`images.palette` 列、色桶表 `color_buckets`、
//! 关系表 `image_color_distances`（图片 × 色桶 → 距离）。
//!
//! 关系表的不变量是「每张图对每个色桶恒有一行」，按色桶排序才能 INNER JOIN 而不丢行。
//! 本迁移同步给全部存量图铺一行 65536（= 没有色盘，排在最后）；真实色盘与距离由回填作业
//! `image_palette`（[`super::backfills::image_palette`]）在后台分批补算。
//!
//! 各步幂等：列存在则跳过、建表建索引 `IF NOT EXISTS`、种子与铺行 `INSERT OR IGNORE`
//! （重跑不会覆盖已经算出来的距离）。

use rusqlite::{Connection, Transaction, TransactionBehavior};

/// 存量图 × 全部色桶各铺一行 65536（`media::palette::NO_PALETTE_DISTANCE`，单测里核对）。按主键 `(image_id, bucket_rgb)` 的顺序插入：
/// `WITHOUT ROWID` 表顺序追加最快，此时还没有二级索引。
const FILL_SQL: &str =
    "INSERT OR IGNORE INTO image_color_distances (image_id, bucket_rgb, distance)
     SELECT i.id, b.rgb, 65536
       FROM images AS i CROSS JOIN color_buckets AS b
      ORDER BY i.id, b.rgb";

pub fn up(conn: &Connection) -> Result<(), String> {
    // 整个迁移一个事务，中途失败不留半截；一开始就拿写锁，免得先读后写时再升级
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| format!("v052 begin: {e}"))?;

    // 1. images.palette：色盘 JSON 文本，NULL = 没有色盘
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_xinfo('images') WHERE name = 'palette')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("v052 inspect images columns: {e}"))?;
    if !exists {
        tx.execute_batch("ALTER TABLE images ADD COLUMN palette TEXT;")
            .map_err(|e| format!("v052 add images.palette: {e}"))?;
    }

    // 2. 色桶表与关系表
    tx.execute_batch(super::COLOR_TABLES_DDL)
        .map_err(|e| format!("v052 create color tables: {e}"))?;

    // 3. 基本色桶
    super::seed_builtin_color_buckets(&tx).map_err(|e| format!("v052 {e}"))?;

    // 4. 存量图铺满 65536
    tx.execute(FILL_SQL, [])
        .map_err(|e| format!("v052 fill image_color_distances: {e}"))?;

    // 5. 排序索引放在铺行之后建
    tx.execute_batch(super::COLOR_DISTANCE_INDEX_DDL)
        .map_err(|e| format!("v052 create idx_image_color_distances_bucket: {e}"))?;

    tx.commit().map_err(|e| format!("v052 commit: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::BUILTIN_COLOR_BUCKETS;
    use crate::media::palette::NO_PALETTE_DISTANCE;
    use rusqlite::{params, Connection};

    /// v051 时的最小形态：只有本迁移用到的 `images.id`。
    fn old_db(image_count: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE images (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 local_path TEXT NOT NULL
             );",
        )
        .unwrap();
        for index in 0..image_count {
            conn.execute(
                "INSERT INTO images (local_path) VALUES (?1)",
                [format!("/lib/{index}.png")],
            )
            .unwrap();
        }
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn plan(conn: &Connection, sql: &str, bucket: Option<i64>) -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let args: Vec<i64> = bucket.into_iter().collect();
        let lines = stmt
            .query_map(rusqlite::params_from_iter(args), |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        lines
    }

    #[test]
    fn up_adds_column_tables_seed_and_index_and_is_idempotent() {
        let conn = old_db(0);
        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let (column_type, not_null): (String, i64) = conn
            .query_row(
                "SELECT type, \"notnull\" FROM pragma_table_xinfo('images') WHERE name = 'palette'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((column_type.as_str(), not_null), ("TEXT", 0));
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM pragma_table_xinfo('images') WHERE name = 'palette'"
            ),
            1,
            "重复执行不会加第二列"
        );

        // 12 个基本色桶：键、rgb、显示顺序与常量逐项一致
        let buckets: Vec<(String, i64, i64)> = conn
            .prepare("SELECT key, rgb, position FROM color_buckets ORDER BY position")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let expected: Vec<(String, i64, i64)> = BUILTIN_COLOR_BUCKETS
            .iter()
            .enumerate()
            .map(|(position, (key, rgb))| (key.to_string(), i64::from(*rgb), position as i64))
            .collect();
        assert_eq!(buckets.len(), 12);
        assert_eq!(buckets, expected);

        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'index' AND name = 'idx_image_color_distances_bucket'
                    AND tbl_name = 'image_color_distances'"
            ),
            1
        );
    }

    #[test]
    fn existing_images_get_one_row_per_bucket_at_the_sentinel() {
        const IMAGES: i64 = 7;
        let conn = old_db(IMAGES);
        super::up(&conn).unwrap();

        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            12 * IMAGES
        );
        let (min, max): (i64, i64) = conn
            .query_row(
                "SELECT MIN(distance), MAX(distance) FROM image_color_distances",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((min, max), (65536, 65536));
        assert_eq!(i64::from(NO_PALETTE_DISTANCE), 65536, "迁移里写死的值");
        // 每张图恰好 12 个不同的色桶
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM (
                     SELECT image_id FROM image_color_distances
                      GROUP BY image_id HAVING COUNT(DISTINCT bucket_rgb) = 12
                 )"
            ),
            IMAGES
        );
        assert_eq!(
            count(&conn, "SELECT palette IS NULL FROM images LIMIT 1"),
            1
        );

        // 重跑不覆盖已经算出来的距离，也不多出行
        conn.execute(
            "UPDATE image_color_distances SET distance = 7 WHERE image_id = 1 AND bucket_rgb = 0",
            [],
        )
        .unwrap();
        super::up(&conn).unwrap();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            12 * IMAGES
        );
        assert_eq!(
            count(
                &conn,
                "SELECT distance FROM image_color_distances WHERE image_id = 1 AND bucket_rgb = 0"
            ),
            7
        );
    }

    #[test]
    fn deleting_an_image_or_bucket_cascades_to_distance_rows() {
        let conn = old_db(3);
        super::up(&conn).unwrap();

        conn.execute("DELETE FROM images WHERE id = 2", []).unwrap();
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM image_color_distances WHERE image_id = 2"
            ),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            12 * 2
        );

        conn.execute("DELETE FROM color_buckets WHERE key = 'gray'", [])
            .unwrap();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            11 * 2
        );

        // 关系行不能指向不存在的图片或色桶
        assert!(conn
            .execute(
                "INSERT INTO image_color_distances (image_id, bucket_rgb, distance) VALUES (99, 0, 1)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO image_color_distances (image_id, bucket_rgb, distance) VALUES (1, 123, 1)",
                [],
            )
            .is_err());
    }

    /// 按色桶排序：等值取一片，片内 `(distance, image_id)` 就是索引顺序，不需要临时排序。
    #[test]
    fn sort_by_bucket_reads_the_index_without_a_temp_sort() {
        let conn = old_db(200);
        super::up(&conn).unwrap();
        conn.execute(
            "UPDATE image_color_distances SET distance = (image_id * 37 + bucket_rgb) % 257",
            [],
        )
        .unwrap();
        conn.execute_batch("ANALYZE;").unwrap();

        const SORT_SQL: &str = "SELECT image_id FROM image_color_distances
              WHERE bucket_rgb = ?1 ORDER BY distance, image_id LIMIT 10";
        let lines = plan(&conn, SORT_SQL, Some(0xff0000));
        assert!(
            lines
                .iter()
                .any(|line| line.contains("idx_image_color_distances_bucket")),
            "{lines:?}"
        );
        assert!(
            !lines.iter().any(|line| line.contains("TEMP B-TREE")),
            "{lines:?}"
        );

        // 结果确实按 (distance, image_id) 升序
        let rows: Vec<(i64, i64)> = conn
            .prepare(
                "SELECT distance, image_id FROM image_color_distances
                  WHERE bucket_rgb = ?1 ORDER BY distance, image_id LIMIT 10",
            )
            .unwrap()
            .query_map(params![0xff0000], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut sorted = rows.clone();
        sorted.sort();
        assert_eq!(rows.len(), 10);
        assert_eq!(rows, sorted);
    }

    /// 走真实的迁移入口：v051 的库升到 v052，铺行并登记回填作业 `image_palette`（分母是存量图数）。
    #[test]
    fn run_pending_upgrades_a_v051_database_and_enqueues_the_backfill() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::storage::migrations::init::create_all_tables(&conn);
        // 退回 v051 的形态
        conn.execute_batch(
            "DROP TABLE image_color_distances;
             DROP TABLE color_buckets;
             ALTER TABLE images DROP COLUMN palette;
             PRAGMA user_version = 51;",
        )
        .unwrap();
        for index in 0..4 {
            conn.execute(
                "INSERT INTO images (local_path, crawled_at, type) VALUES (?1, 1, 'image/png')",
                [format!("/lib/{index}.png")],
            )
            .unwrap();
        }

        // 不读 KABEGAME_BACKFILL_SYNC_THROUGH：作业只登记、不在这里排干
        crate::storage::migrations::run_pending_with(
            &conn,
            crate::storage::migrations::MIGRATIONS,
            crate::storage::migrations::backfill::registry(),
            None,
            &mut |_| {},
        )
        .unwrap();

        assert_eq!(
            crate::storage::migrations::current_version(&conn),
            crate::storage::migrations::LATEST_VERSION
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM image_color_distances"),
            48
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM image_color_distances WHERE distance <> 65536"
            ),
            0
        );
        let (introduced_at, total, done): (i64, i64, i64) = conn
            .query_row(
                "SELECT introduced_at, total, done FROM backfill_jobs WHERE id = 'image_palette'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((introduced_at, total, done), (52, 4, 0));
    }

    /// 铺行语句在真实 schema（images 上有十来个索引）下按主键顺序产出，不先排一遍 12N 行。
    #[test]
    fn fill_statement_does_not_sort_on_the_real_schema() {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::migrations::init::create_all_tables(&conn);
        let assert_no_sort = |when: &str| {
            let lines = plan(&conn, super::FILL_SQL, None);
            assert!(
                !lines.iter().any(|line| line.contains("TEMP B-TREE")),
                "{when}: {lines:?}"
            );
        };
        assert_no_sort("空库、没有统计");

        // 真实升级时库里有主程序每次启动写的统计
        for index in 0..500 {
            conn.execute(
                "INSERT INTO images (local_path, crawled_at, type) VALUES (?1, ?2, ?3)",
                params![
                    format!("/lib/{index}"),
                    index,
                    if index % 7 == 0 {
                        "video/mp4"
                    } else {
                        "image/jpg"
                    }
                ],
            )
            .unwrap();
        }
        conn.execute_batch("ANALYZE;").unwrap();
        assert_no_sort("有统计");
    }
}
