//! 路径 WHERE 组合器 (`~any` / `~or` / `~not` / `~end`) 端到端。
//!
//! 用 DSL provider 搭一棵小路由树 + 真 in-memory sqlite, 验证组合器在完整
//! resolve → fold → build_sql → 执行链路上的行为: 分支旁路、游标回到组入口、
//! 嵌套、缓存门控、转义, 以及尾部不自动闭合。

#![cfg(feature = "json5")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pathql_rs::provider::{
    ClosureExecutor, EngineError, ProviderRuntime, SqlDialect, SqlExecutor,
};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};
use rusqlite::Connection;

fn local_params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    values
        .iter()
        .map(|v| match v {
            TemplateValue::Null => Value::Null,
            TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
            TemplateValue::Int(i) => Value::Integer(*i),
            TemplateValue::Real(r) => Value::Real(*r),
            TemplateValue::Text(s) => Value::Text(s.clone()),
            TemplateValue::Json(v) => Value::Text(v.to_string()),
        })
        .collect()
}

/// 路由树:
/// ```text
/// root ─ plugin ─ <name>       → where images.plugin_id = <name>
///      ├ tag ─── <name>        → LEFT JOIN image_tags + where it.tag = <name>
///      ├ liked                 → where images.liked = 1
///      └ inner ─ <name>        → INNER JOIN (用于验证组内拒绝)
/// ```
const PROVIDERS: &[&str] = &[
    r#"{
        name: "root",
        list: {
            plugin: { provider: "plugin_router" },
            tag: { provider: "tag_router" },
            liked: { provider: "liked_provider" },
            inner: { provider: "inner_router" },
            "~weird": { provider: "liked_provider" },
        },
    }"#,
    r#"{
        name: "plugin_router",
        resolve: {
            "([^/]+)": { provider: "plugin_provider", properties: { name: "${capture[1]}" } },
        },
    }"#,
    r#"{
        name: "plugin_provider",
        properties: { name: { type: "string" } },
        query: { where: "images.plugin_id = ${properties.name}" },
    }"#,
    r#"{
        name: "tag_router",
        resolve: {
            "([^/]+)": { provider: "tag_provider", properties: { name: "${capture[1]}" } },
        },
    }"#,
    r#"{
        name: "tag_provider",
        properties: { name: { type: "string" } },
        query: {
            join: [{ kind: "LEFT", table: "image_tags", as: "it", on: "it.image_id = images.id", in_need: true }],
            where: "it.tag = ${properties.name}",
        },
    }"#,
    // 过滤 provider 继续路由 (真实 DSL 里的 comb provider 就是这样), 于是挂在它
    // 身上的组仍能往下分支 —— 组入口 provider 决定分支能走到哪。
    r#"{
        name: "liked_provider",
        query: { where: "images.liked = 1" },
        list: {
            plugin: { provider: "plugin_router" },
            tag: { provider: "tag_router" },
            inner: { provider: "inner_router" },
        },
    }"#,
    r#"{
        name: "inner_router",
        resolve: {
            "([^/]+)": { provider: "inner_provider", properties: { name: "${capture[1]}" } },
        },
    }"#,
    r#"{
        name: "inner_provider",
        properties: { name: { type: "string" } },
        query: {
            join: [{ kind: "INNER", table: "image_tags", as: "bad", on: "bad.image_id = images.id" }],
            where: "bad.tag = ${properties.name}",
        },
    }"#,
];

fn fixture_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE images (id INTEGER PRIMARY KEY, plugin_id TEXT, liked INTEGER);
        CREATE TABLE image_tags (image_id INTEGER, tag TEXT);
        INSERT INTO images VALUES
            (1,'pixiv',0), (2,'pixiv',1), (3,'yande',0), (4,'danbooru',1), (5,'danbooru',0);
        INSERT INTO image_tags VALUES (1,'cat'), (3,'cat'), (5,'dog');
        ",
    )
    .unwrap();
    Arc::new(Mutex::new(conn))
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(
        SqlDialect::Sqlite,
        move |sql: &str, params: &[TemplateValue]| {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(sql).map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "prepare".into(), e.to_string())
            })?;
            let rusq = local_params_for(params);
            let cols: Vec<String> = stmt
                .column_names()
                .into_iter()
                .map(|s| s.to_string())
                .collect();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(rusq.iter()), |row| {
                    let mut obj = serde_json::Map::new();
                    for (i, name) in cols.iter().enumerate() {
                        let v = match row.get_ref_unwrap(i) {
                            rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                            rusqlite::types::ValueRef::Integer(i) => serde_json::Value::from(i),
                            rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
                            rusqlite::types::ValueRef::Text(t) => {
                                serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                        };
                        obj.insert(name.clone(), v);
                    }
                    Ok(serde_json::Value::Object(obj))
                })
                .map_err(|e| {
                    EngineError::FactoryFailed("sqlite".into(), "query".into(), e.to_string())
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "row".into(), e.to_string())
            })
        },
    ))
}

fn runtime() -> Arc<ProviderRuntime> {
    let mut registry = ProviderRegistry::new();
    for src in PROVIDERS {
        registry
            .register(Json5Loader {}.load(Source::Str(src)).unwrap())
            .unwrap();
    }
    let rt = ProviderRuntime::with_registry(
        Arc::new(registry),
        make_executor(fixture_db()),
        HashMap::new(),
    );
    rt.register_schema("t", "images", "", "root").unwrap();
    rt
}

/// 取 id 列表, 升序, 便于稳定断言。
fn ids(rt: &ProviderRuntime, path: &str) -> Vec<i64> {
    let mut out: Vec<i64> = rt
        .fetch(path)
        .unwrap_or_else(|e| panic!("fetch({path}) failed: {e}"))
        .into_iter()
        .map(|row| row.get("id").and_then(|v| v.as_i64()).unwrap())
        .collect();
    out.sort_unstable();
    out
}

fn sql_of(rt: &ProviderRuntime, path: &str) -> String {
    rt.resolve(path).unwrap().composed.wheres[..]
        .iter()
        .map(|w| w.0.clone())
        .collect::<Vec<_>>()
        .join(" AND ")
}

// ===== 基线: 不带组合器 =====

#[test]
fn plain_path_still_ands() {
    let rt = runtime();
    assert_eq!(ids(&rt, "t://plugin/pixiv"), vec![1, 2]);
    assert_eq!(ids(&rt, "t://liked"), vec![2, 4]);
}

// ===== ~any =====

#[test]
fn any_group_ors_two_branches() {
    let rt = runtime();
    // pixiv(1,2) OR liked(2,4)
    assert_eq!(
        ids(&rt, "t://~any/plugin/pixiv/~or/liked/~end"),
        vec![1, 2, 4]
    );
}

#[test]
fn any_group_ors_three_branches() {
    let rt = runtime();
    assert_eq!(
        ids(
            &rt,
            "t://~any/plugin/pixiv/~or/plugin/yande/~or/liked/~end"
        ),
        vec![1, 2, 3, 4]
    );
}

#[test]
fn any_group_ands_with_outer_predicate() {
    let rt = runtime();
    // liked=1 AND (pixiv OR danbooru) → 2, 4
    assert_eq!(
        ids(&rt, "t://liked/~any/plugin/pixiv/~or/plugin/danbooru/~end"),
        vec![2, 4]
    );
}

#[test]
fn predicate_after_group_ands_with_it() {
    let rt = runtime();
    // (pixiv OR yande) AND liked=1 → 2
    assert_eq!(
        ids(&rt, "t://~any/plugin/pixiv/~or/plugin/yande/~end/liked"),
        vec![2]
    );
}

#[test]
fn single_branch_any_degenerates_to_plain_filter() {
    let rt = runtime();
    assert_eq!(ids(&rt, "t://~any/plugin/pixiv/~end"), vec![1, 2]);
}

// ===== ~not =====

#[test]
fn not_group_negates() {
    let rt = runtime();
    // NOT pixiv → 3,4,5
    assert_eq!(ids(&rt, "t://~not/plugin/pixiv/~end"), vec![3, 4, 5]);
}

#[test]
fn not_group_composes_with_outer_predicate() {
    let rt = runtime();
    // liked=1 AND NOT pixiv → 4
    assert_eq!(ids(&rt, "t://liked/~not/plugin/pixiv/~end"), vec![4]);
}

// ===== 嵌套 =====

#[test]
fn nested_not_inside_any() {
    let rt = runtime();
    // liked OR NOT(pixiv) → 2,4 ∪ 3,4,5
    assert_eq!(
        ids(&rt, "t://~any/liked/~or/~not/plugin/pixiv/~end/~end"),
        vec![2, 3, 4, 5]
    );
}

#[test]
fn nested_any_inside_not_is_nor() {
    let rt = runtime();
    // NOT(pixiv OR yande) → danbooru: 4,5
    assert_eq!(
        ids(
            &rt,
            "t://~not/~any/plugin/pixiv/~or/plugin/yande/~end/~end"
        ),
        vec![4, 5]
    );
}

// ===== 分支旁路语义 =====

#[test]
fn cursor_returns_to_group_entry_after_end() {
    let rt = runtime();
    // `~end` 之后仍能从 root 继续走 `liked` —— 游标没有停在分支末端的 plugin_provider。
    let node = rt
        .resolve("t://~any/plugin/pixiv/~or/plugin/yande/~end/liked")
        .unwrap();
    assert!(node.provider.is_some());
    assert!(node.open_groups.is_empty());
}

#[test]
fn branches_do_not_leak_predicates_into_each_other() {
    let rt = runtime();
    let sql = sql_of(&rt, "t://~any/plugin/pixiv/~or/plugin/yande/~end");
    // 恰好一条合成谓词, 两支各出现一次。
    assert_eq!(sql.matches("images.plugin_id").count(), 2);
    assert!(sql.contains(") OR ("), "expected an OR between branches: {sql}");
}

#[test]
fn branch_routes_from_the_group_entry_provider() {
    let rt = runtime();
    // 组挂在 liked_provider 上, 分支就只能走 liked_provider 提供的子节点。
    // 它不列 `liked`, 所以这条分支段解析不到 —— 分支不是从 root 重新起跳。
    let err = rt
        .resolve("t://liked/~any/plugin/pixiv/~or/liked/~end")
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::PathNotFound(p) if p.ends_with("/liked")),
        "got {err:?}"
    );
}

#[test]
fn left_join_from_branch_survives_into_outer_query() {
    let rt = runtime();
    // tag 分支带 LEFT JOIN image_tags; JOIN 必须留在外层查询里, 否则谓词引用不到 it。
    // cat(1,3) OR liked(2,4)
    assert_eq!(ids(&rt, "t://~any/tag/cat/~or/liked/~end"), vec![1, 2, 3, 4]);
}

#[test]
fn left_join_shared_across_two_branches_via_in_need() {
    let rt = runtime();
    // 两支都要 image_tags; in_need 让第二支复用第一支的别名而不是别名冲突。
    assert_eq!(ids(&rt, "t://~any/tag/cat/~or/tag/dog/~end"), vec![1, 3, 5]);
}

// ===== 组内约束 =====

#[test]
fn inner_join_inside_group_rejected() {
    let rt = runtime();
    let err = rt.fetch("t://~any/inner/cat/~or/liked/~end").unwrap_err();
    match err {
        EngineError::WhereGroup(_, msg) => {
            assert!(msg.contains("non-LEFT"), "unexpected message: {msg}")
        }
        other => panic!("expected WhereGroup, got {other:?}"),
    }
}

// ===== 尾部不自动闭合 =====

#[test]
fn unclosed_group_resolves_but_refuses_to_run() {
    let rt = runtime();
    // resolve 成功 (便于 UI 逐段浏览构建分支)…
    let node = rt.resolve("t://~any/plugin/pixiv").unwrap();
    assert_eq!(node.open_groups, vec!["~any"]);

    // …但执行入口拒绝, 绝不静默补 `~end`。
    for path in ["t://~any/plugin/pixiv", "t://~any/plugin/pixiv/~or/liked"] {
        let err = rt.fetch(path).unwrap_err();
        assert!(
            matches!(&err, EngineError::WhereGroup(_, msg) if msg.contains("unclosed")),
            "fetch({path}) should refuse, got {err:?}"
        );
        let err = rt.count(path).unwrap_err();
        assert!(matches!(err, EngineError::WhereGroup(_, _)));
    }
}

#[test]
fn unclosed_nested_groups_report_all_markers() {
    let rt = runtime();
    let node = rt.resolve("t://~any/~not/plugin/pixiv").unwrap();
    assert_eq!(node.open_groups, vec!["~any", "~not"]);
}

#[test]
fn list_still_works_inside_an_open_group() {
    let rt = runtime();
    // 组内浏览: 从组入口(root)列子节点, 供 UI 挑下一个分支段。
    let children = rt.list("t://~any").unwrap();
    let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"plugin"));
    assert!(names.contains(&"liked"));
}

// ===== 语法错误 =====

#[test]
fn stray_end_rejected() {
    let rt = runtime();
    let err = rt.resolve("t://liked/~end").unwrap_err();
    assert!(
        matches!(&err, EngineError::WhereGroup(_, msg) if msg.contains("without a matching")),
        "got {err:?}"
    );
}

#[test]
fn stray_or_rejected() {
    let rt = runtime();
    let err = rt.resolve("t://liked/~or/plugin/pixiv").unwrap_err();
    assert!(
        matches!(&err, EngineError::WhereGroup(_, msg) if msg.contains("without an enclosing")),
        "got {err:?}"
    );
}

#[test]
fn or_directly_inside_not_rejected() {
    let rt = runtime();
    let err = rt
        .resolve("t://~not/plugin/pixiv/~or/liked/~end")
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::WhereGroup(_, msg) if msg.contains("not allowed inside")),
        "got {err:?}"
    );
}

// ===== 转义 =====

#[test]
fn escaped_tilde_routes_to_literal_segment() {
    let rt = runtime();
    // 字面名为 `~weird` 的节点用 `\~weird` 访问。
    assert_eq!(ids(&rt, r"t://\~weird"), vec![2, 4]);
}

#[test]
fn escape_helper_covers_literals_that_look_like_markers() {
    use pathql_rs::provider::escape_path_segment;
    // 宿主拿数据(画册名等)拼段时的收口: 前导 `~` 用反斜线转义。
    assert_eq!(escape_path_segment("~any"), r"\~any");
    assert_eq!(escape_path_segment("~weird"), r"\~weird");
    assert_eq!(escape_path_segment("pixiv"), "pixiv");

    let rt = runtime();
    assert_eq!(
        ids(&rt, &format!("t://{}", escape_path_segment("~weird"))),
        vec![2, 4]
    );
}

#[test]
fn bare_unknown_tilde_segment_is_rejected() {
    let rt = runtime();
    let err = rt.resolve("t://~weird").unwrap_err();
    match err {
        EngineError::ReservedPathSegment(path, msg) => {
            assert_eq!(path, "t://~weird");
            assert!(msg.contains(r"\~"), "unexpected message: {msg}");
        }
        other => panic!("expected ReservedPathSegment, got {other:?}"),
    }
}

// ===== 缓存门控 =====

#[test]
fn only_depth_zero_prefixes_are_cached() {
    let rt = runtime();
    rt.clear_cache();
    ids(&rt, "t://~any/plugin/pixiv/~or/liked/~end");

    // 组内前缀 (`/~any/plugin` 等) 一律不进缓存 —— 它们的 composed 只在当前
    // 分支基线下成立。只有闭合处的完整路径落缓存。
    let cached_inside = ["t://~any", "t://~any/plugin", "t://~any/plugin/pixiv"]
        .iter()
        .filter(|p| rt.is_path_cached(p))
        .count();
    assert_eq!(cached_inside, 0, "no in-group prefix may be cached");
}

#[test]
fn repeated_group_path_is_stable() {
    let rt = runtime();
    let first = ids(&rt, "t://~any/plugin/pixiv/~or/liked/~end");
    let second = ids(&rt, "t://~any/plugin/pixiv/~or/liked/~end");
    assert_eq!(first, second);
    // 缓存命中后也不能漏掉组谓词。
    assert_eq!(second, vec![1, 2, 4]);
}

#[test]
fn cached_plain_prefix_does_not_bleed_into_group_branches() {
    let rt = runtime();
    // 先把 `t://liked` 暖进缓存, 再走以它为前缀的组路径。
    assert_eq!(ids(&rt, "t://liked"), vec![2, 4]);
    assert_eq!(
        ids(&rt, "t://liked/~any/plugin/pixiv/~or/plugin/danbooru/~end"),
        vec![2, 4]
    );
}
