use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashSet;

use super::Storage;

pub const MAX_SEARCH_TEXTS: usize = 1000;
pub const MAX_SEARCH_TEXT_CHARS: usize = 1024;

/// 片段内换行替换成空格、裁掉首尾空白、去空并保序去重。
pub(crate) fn normalize_search_terms(raw: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in raw {
        let value = value.replace(['\n', '\r'], " ");
        let value = value.trim();
        if !value.is_empty() && seen.insert(value.to_string()) {
            normalized.push(value.to_string());
        }
    }
    normalized
}

/// 校验插件传来的 `searchTexts`。缺省或 null 表示使用默认展开规则；无效条目只跳过自身。
pub fn validate_search_text_values(
    value: Option<&Value>,
) -> Result<(Option<Vec<String>>, Vec<(usize, String)>), String> {
    let values = match value {
        None | Some(Value::Null) => return Ok((None, Vec::new())),
        Some(Value::Array(values)) => values,
        Some(_) => return Err("searchTexts must be an array".to_string()),
    };

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index >= MAX_SEARCH_TEXTS {
            rejected.push((index, format!("最多允许 {MAX_SEARCH_TEXTS} 项")));
            continue;
        }
        let Some(text) = value.as_str() else {
            rejected.push((index, "必须是字符串".to_string()));
            continue;
        };
        let char_count = text.chars().count();
        if char_count > MAX_SEARCH_TEXT_CHARS {
            rejected.push((index, format!("超过 {MAX_SEARCH_TEXT_CHARS} 个字符")));
            continue;
        }
        accepted.push(text.to_string());
    }

    Ok((Some(normalize_search_terms(accepted)), rejected))
}

/// 为一批新插入的 metadata 行写搜索词：逐行规范化后，整批只用两条 SQL——补齐词典、插映射。
///
/// 只用于新行：`metadata.id` 由 AUTOINCREMENT 分配不会复用，旧映射随旧行级联删除，新行不会有
/// 残留映射，因此不先 DELETE。逐词 upsert 每行要跑上百条 SQL；集合式写入的耗时只剩 B 树本身，
/// 插映射时按 `term_id` 排序让主键 `(term_id, metadata_id)` 的写入更集中。
pub(crate) fn insert_metadata_search_terms(
    conn: &Connection,
    rows: &[(i64, &[String])],
) -> Result<(), String> {
    let pairs = rows
        .iter()
        .flat_map(|(metadata_id, terms)| {
            normalize_search_terms(terms.iter().cloned())
                .into_iter()
                .map(move |term| (*metadata_id, term))
        })
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        return Ok(());
    }
    let pairs = serde_json::to_string(&pairs)
        .map_err(|e| format!("serialize metadata search terms: {e}"))?;

    // `WHERE true` 不能省：`INSERT … SELECT` 后直接跟 `ON CONFLICT` 时 SQLite 解析有歧义。
    conn.prepare_cached(
        "INSERT INTO search_terms (text)
         SELECT value ->> 1 FROM json_each(?1) WHERE true
         ON CONFLICT(text) DO NOTHING",
    )
    .and_then(|mut stmt| stmt.execute(params![pairs]))
    .map_err(|e| format!("insert search terms: {e}"))?;
    conn.prepare_cached(
        "INSERT OR IGNORE INTO metadata_search_terms (metadata_id, term_id)
         SELECT j.value ->> 0, st.id
           FROM json_each(?1) AS j
           JOIN search_terms AS st ON st.text = j.value ->> 1
          ORDER BY st.id, 1",
    )
    .and_then(|mut stmt| stmt.execute(params![pairs]))
    .map_err(|e| format!("insert metadata search term mappings: {e}"))?;
    Ok(())
}

/// 清理没有任何 metadata 映射引用的字典词条。
pub(crate) fn gc_orphan_search_terms(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM search_terms
         WHERE NOT EXISTS (
             SELECT 1 FROM metadata_search_terms
             WHERE metadata_search_terms.term_id = search_terms.id
         )",
        [],
    )
    .map_err(|e| format!("gc orphan search terms: {e}"))
}

impl Storage {
    pub(crate) fn gc_orphan_search_terms(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        gc_orphan_search_terms(&conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE metadata (id INTEGER PRIMARY KEY);
             CREATE TABLE search_terms (
                 id INTEGER PRIMARY KEY,
                 text TEXT NOT NULL UNIQUE
             );
             CREATE TABLE metadata_search_terms (
                 metadata_id INTEGER NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
                 term_id INTEGER NOT NULL REFERENCES search_terms(id),
                 PRIMARY KEY (term_id, metadata_id)
             ) WITHOUT ROWID;
             CREATE INDEX idx_metadata_search_terms_metadata
                 ON metadata_search_terms(metadata_id);
             INSERT INTO metadata (id) VALUES (1), (2), (3);",
        )
        .unwrap();
        conn
    }

    fn terms_for(conn: &Connection, metadata_id: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT search_terms.text
                 FROM metadata_search_terms
                 JOIN search_terms ON search_terms.id = metadata_search_terms.term_id
                 WHERE metadata_search_terms.metadata_id = ?1
                 ORDER BY search_terms.id",
            )
            .unwrap();
        stmt.query_map(params![metadata_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn search_terms_normalize_newlines_trim_empty_and_deduplicate() {
        assert_eq!(
            normalize_search_terms([
                "  alpha\n beta  ".to_string(),
                "".to_string(),
                "alpha  beta".to_string(),
                "Gamma\rDelta".to_string(),
            ]),
            ["alpha  beta", "Gamma Delta"]
        );
    }

    #[test]
    fn search_terms_validate_shape_and_skip_invalid_entries() {
        assert!(validate_search_text_values(Some(&json!({"text": "x"}))).is_err());
        let mut values = vec![json!(42), json!("  kept\nterm  "), json!("x".repeat(1025))];
        values.extend((3..=MAX_SEARCH_TEXTS).map(|index| json!(format!("term-{index}"))));
        let (terms, rejected) = validate_search_text_values(Some(&Value::Array(values))).unwrap();
        let terms = terms.unwrap();
        assert_eq!(terms.first().map(String::as_str), Some("kept term"));
        assert_eq!(terms.len(), MAX_SEARCH_TEXTS - 2);
        assert_eq!(
            rejected.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            [0, 2, 1000]
        );
        assert_eq!(validate_search_text_values(None).unwrap().0, None);
        assert_eq!(
            validate_search_text_values(Some(&Value::Null)).unwrap().0,
            None
        );
        assert_eq!(
            validate_search_text_values(Some(&json!([]))).unwrap().0,
            Some(Vec::new())
        );
    }

    #[test]
    fn search_terms_insert_supports_default_provided_and_empty_lists() {
        let conn = conn();
        let default = ["default".to_string()];
        let provided = ["provided".to_string(), " provided\n".to_string()];
        insert_metadata_search_terms(&conn, &[(1, &default), (2, &provided), (3, &[])]).unwrap();
        assert_eq!(terms_for(&conn, 1), ["default"]);
        assert_eq!(terms_for(&conn, 2), ["provided"]);
        assert!(terms_for(&conn, 3).is_empty());
    }

    #[test]
    fn search_terms_insert_shares_dictionary_rows_across_metadata() {
        let conn = conn();
        let first = ["shared".to_string(), "first".to_string()];
        let second = ["second".to_string(), "shared".to_string()];
        insert_metadata_search_terms(&conn, &[(1, &first), (2, &second)]).unwrap();
        assert_eq!(terms_for(&conn, 1), ["shared", "first"]);
        assert_eq!(terms_for(&conn, 2), ["shared", "second"]);
        let dictionary: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_terms", [], |row| row.get(0))
            .unwrap();
        assert_eq!(dictionary, 3);

        // 已在词典里的词复用原 id，不新建词条。
        let third = ["first".to_string()];
        insert_metadata_search_terms(&conn, &[(3, &third)]).unwrap();
        assert_eq!(terms_for(&conn, 3), ["first"]);
        let dictionary: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_terms", [], |row| row.get(0))
            .unwrap();
        assert_eq!(dictionary, 3);
    }

    #[test]
    fn search_terms_gc_removes_only_orphan_dictionary_rows() {
        let conn = conn();
        let terms = ["kept".to_string(), "orphan".to_string()];
        insert_metadata_search_terms(&conn, &[(1, &terms)]).unwrap();
        conn.execute(
            "DELETE FROM metadata_search_terms
              WHERE term_id = (SELECT id FROM search_terms WHERE text = 'orphan')",
            [],
        )
        .unwrap();
        assert_eq!(gc_orphan_search_terms(&conn).unwrap(), 1);
        let remaining: Vec<String> = conn
            .prepare("SELECT text FROM search_terms ORDER BY text")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining, ["kept"]);
    }
}
