use rusqlite::Connection;

/// 为 `albums.ancestor_path` 建立单列索引，供「子树」前缀区间查询使用。
///
/// `ancestor_path` 形如 `/根/…/自身/`（非空、以 `/` 结尾），画册 A 的子树（含自身）就是
/// `ancestor_path` 以 A 的路径为前缀的那些行，可以写成一段连续区间：
/// `tree.ancestor_path >= a.ancestor_path AND tree.ancestor_path < <a 去掉末尾 '/'> || '0'`
/// （`/` 的下一个字符是 `0`）。此前用 `instr(tree.ancestor_path, '/' || a.id || '/') > 0`
/// 或 `substr(...) = ...`，走不了索引，只能逐行扫 `albums`。
/// 1.3 万画册、12 万成员行下，画册页一页 10 个的子树图片计数从 0.35s 降到约 0.02s。
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_albums_ancestor_path ON albums(ancestor_path);",
    )
    .map_err(|e| format!("v033 create idx_albums_ancestor_path: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn up_creates_ancestor_path_index_used_by_subtree_range() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE albums (id TEXT PRIMARY KEY, ancestor_path TEXT NOT NULL DEFAULT '');
             INSERT INTO albums VALUES
                 ('a', '/a/'), ('b', '/a/b/'), ('c', '/a/b/c/'), ('a0', '/a0/'), ('d', '/d/');",
        )
        .unwrap();

        super::up(&conn).unwrap();
        super::up(&conn).unwrap();

        let range = "SELECT tree.id FROM albums AS a JOIN albums AS tree \
                     ON tree.ancestor_path >= a.ancestor_path \
                     AND tree.ancestor_path < substr(a.ancestor_path, 1, length(a.ancestor_path) - 1) || '0' \
                     WHERE a.id = 'a' ORDER BY tree.id";
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {range}"))
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|d| d.contains("idx_albums_ancestor_path")),
            "{plan:?}"
        );

        // 子树含自身；前缀相同但不是后代的 `/a0/` 不在区间内
        let ids: Vec<String> = conn
            .prepare(range)
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }
}
