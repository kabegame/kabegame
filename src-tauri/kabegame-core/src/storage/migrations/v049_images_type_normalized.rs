//! `images.type` 一次性规范化 + 普通索引。
//!
//! 不变量：type 非空，等于 lower(trim(type))，形如「主类/子类」且两段都非空（如 `image/jpg`、`x-wpe/web`）。
//! 本迁移只修正历史残留（v023 之后预期 0 行）；之后由 Rust 写入口保证（`normalize_stored_media_type`），
//! 数据库不放触发器或约束。规则自包含，不读运行时格式表（同 v023），所以不做别名归并（`image/jpeg` 本身合规，保持原样）。
//!
//! 索引注意：type 只有十几种取值，本库不跑 ANALYZE。按 type 过滤再 `ORDER BY … LIMIT` 的查询若写成可走索引的形态，
//! 规划器会选本索引再整体排序（实测 6.4 万行 15 ms，对比沿排序索引 1 ms）。见 `cocs/provider-dsl/RULES.md`。

use rusqlite::Connection;

/// 把列 `type` 规范成合规值；与 `normalize_stored_media_type` 对格式表外输入的兜底规则相同（有测试比对）。
pub(crate) const NORMALIZED_TYPE_SQL: &str = "CASE
    WHEN lower(trim(COALESCE(type, ''))) IN ('', 'image') THEN 'image/jpg'
    WHEN lower(trim(type)) = 'video' THEN 'video/mp4'
    WHEN instr(lower(trim(type)), '/') = 0 THEN 'image/' || lower(trim(type))
    WHEN instr(lower(trim(type)), '/') = 1 OR substr(lower(trim(type)), -1) = '/' THEN 'image/jpg'
    ELSE lower(trim(type))
  END";

/// `type` 不满足不变量。
const VIOLATES_SQL: &str =
    "type IS NULL OR type <> lower(trim(type)) OR instr(type, '/') <= 1 OR substr(type, -1) = '/'";

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("v049 begin: {e}"))?;
    let result = (|| {
        // 先建索引：建索引本来就要读一遍表，冷启动的 IO 只付这一次，下面的修正扫描就落在缓存里
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_type ON images(type);")
            .map_err(|e| format!("v049 create index: {e}"))?;
        let fixed = conn
            .execute(
                &format!("UPDATE images SET type = {NORMALIZED_TYPE_SQL} WHERE {VIOLATES_SQL}"),
                [],
            )
            .map_err(|e| format!("v049 normalize images.type: {e}"))?;
        if fixed > 0 {
            tracing::info!("v049: 修正 {fixed} 行 images.type");
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK");
            format!("v049 commit: {e}")
        }),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_v049_normalizes_residuals_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE images (id INTEGER PRIMARY KEY, type TEXT)")
            .unwrap();
        let cases = [
            (None, "image/jpg"),
            (Some(""), "image/jpg"),
            (Some(" IMAGE "), "image/jpg"),
            (Some("Video"), "video/mp4"),
            (Some("gif"), "image/gif"),
            (Some("/webp"), "image/jpg"),
            (Some("image/"), "image/jpg"),
            (Some("/"), "image/jpg"),
            (Some("image/jpg"), "image/jpg"),
            (Some("image/jpeg"), "image/jpeg"),
            (Some("x-wpe/web"), "x-wpe/web"),
            (Some("text/plain"), "text/plain"),
            (Some(" CUSTOM/FORMAT "), "custom/format"),
        ];
        for (input, _) in cases {
            conn.execute("INSERT INTO images(type) VALUES (?1)", [input])
                .unwrap();
        }
        up(&conn).unwrap();
        let values: Vec<String> = conn
            .prepare("SELECT type FROM images ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(values, cases.map(|(_, expected)| expected));
        assert!(values
            .iter()
            .all(|value| crate::media::image_type::is_stored_media_type(value)));
        let changes = conn.total_changes();
        up(&conn).unwrap();
        assert_eq!(conn.total_changes(), changes, "第二次不应再修正任何行");
        let indexes: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_images_type'",
            [], |row| row.get(0)).unwrap();
        assert_eq!(indexes, 1);
    }

    #[test]
    fn storage_v049_index_supports_equality_and_preserves_pagination_plan() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE images (id INTEGER PRIMARY KEY, type TEXT, crawled_at INTEGER);
            CREATE INDEX idx_crawled_at ON images(crawled_at DESC);
            WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
            INSERT INTO images SELECT n, CASE WHEN n = 1 THEN 'x-wpe/web' ELSE 'image/jpg' END, n FROM seq;").unwrap();
        up(&conn).unwrap();
        let plan = |sql: &str, kind: &str| -> Vec<String> {
            conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map([kind], |row| row.get(3))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let equality = plan("SELECT * FROM images WHERE type = ?1", "x-wpe/web");
        assert!(
            equality.iter().any(|line| line.contains("idx_images_type")),
            "{equality:?}"
        );
        for kind in ["image", "video"] {
            let page = plan(
                "SELECT * FROM images WHERE CASE ?1 WHEN 'video' THEN type GLOB 'video/*'
                ELSE NOT (type GLOB 'video/*') END ORDER BY crawled_at DESC LIMIT 100",
                kind,
            );
            assert!(
                page.iter().any(|line| line.contains("idx_crawled_at")),
                "{page:?}"
            );
            assert!(
                !page
                    .iter()
                    .any(|line| line.contains("TEMP B-TREE") || line.contains("idx_images_type")),
                "{page:?}"
            );
        }
    }
}
