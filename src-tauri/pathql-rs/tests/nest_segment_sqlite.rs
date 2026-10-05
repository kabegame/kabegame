//! 子查询边界段 `~~` 端到端。
//!
//! 用 DSL provider 搭一棵画册小路由树 + 真 in-memory sqlite, 验证 `~~` 把此前的查询
//! 整体封成 FROM、把 provider 视角切回 schema 根: 先切页再 join 计数、隐藏口径、多层嵌套、
//! `where_clear` 跨不过边界、组内 / 程序化 schema 下报错、转义, 以及缓存与失效。

#![cfg(feature = "json5")]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use pathql_rs::compose::FromSource;
use pathql_rs::provider::{ClosureExecutor, EngineError, ProviderRuntime, SqlDialect, SqlExecutor};
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

/// 路由树（schema 表为 `albums`）:
/// ```text
/// root ─ parent ─ <id>      → where albums.parent_id = <id>（可接 p_<n> 分页 / unclear）
///      ├ p_<n>              → 按名称每页 2 个
///      ├ images             → join 成员行与图片; 按画册列举, with_count = 图片数
///      │   └ hide           → where hid_ai.image_id IS NULL（与画廊 hide 同句）
///      ├ counts             → 同样的 join + COUNT + group_by albums.id: fetch 一次出整页计数
///      │   └ hide           → 同 images/hide 的 where
///      ├ unclear            → where_clear 掉 albums.parent_id（验证清不到内层）
///      └ "~~"（字面）        → where albums.name = 'A'（验证 `\~~` 转义）
/// ```
const PROVIDERS: &[&str] = &[
    r#"{
        name: "root",
        query: {
            fields: [
                { sql: "albums.id", as: "id" },
                { sql: "albums.name", as: "name" },
                { sql: "albums.parent_id", as: "parent_id" },
            ],
        },
        list: {
            parent: { provider: "parent_router" },
            images: { provider: "images_provider" },
            unclear: { provider: "unclear_provider" },
            "~~": { provider: "literal_tilde_provider" },
        },
        resolve: {
            "p_([1-9][0-9]*)": { provider: "page_provider", properties: { page: "${capture[1]}" } },
            counts: { provider: "image_counts_provider" },
        },
    }"#,
    r#"{
        name: "image_counts_provider",
        query: {
            fields: [{ sql: "COUNT(images.id)", as: "image_count" }],
            join: [
                { kind: "INNER", table: "album_images", as: "ai", on: "ai.album_id = albums.id" },
                { kind: "INNER", table: "images", as: "images", on: "images.id = ai.image_id" },
                { kind: "LEFT", table: "album_images", as: "hid_ai", in_need: true,
                  on: "images.id = hid_ai.image_id and hid_ai.album_id = 'HID'" },
            ],
            group_by: ["albums.id"],
        },
        resolve: { hide: { provider: "images_hide_provider" } },
    }"#,
    r#"{
        name: "parent_router",
        resolve: {
            "([A-Z]+)": { provider: "parent_provider", properties: { id: "${capture[1]}" } },
        },
    }"#,
    r#"{
        name: "parent_provider",
        properties: { id: { type: "string" } },
        query: { where: "albums.parent_id = ${properties.id}" },
        list: { unclear: { provider: "unclear_provider" } },
        resolve: {
            "p_([1-9][0-9]*)": { provider: "page_provider", properties: { page: "${capture[1]}" } },
        },
    }"#,
    r#"{
        name: "page_provider",
        properties: { page: { type: "number" } },
        query: {
            order: [{ sql: "albums.name", order: "asc" }],
            offset: "(${properties.page} - 1) * 2",
            limit: 2,
        },
    }"#,
    r#"{
        name: "images_provider",
        query: {
            fields: [{ sql: "albums.id", as: "album_id" }, { sql: "images.id", as: "image_id" }],
            join: [
                { kind: "INNER", table: "album_images", as: "ai", on: "ai.album_id = albums.id" },
                { kind: "INNER", table: "images", as: "images", on: "images.id = ai.image_id" },
                { kind: "LEFT", table: "album_images", as: "hid_ai", in_need: true,
                  on: "images.id = hid_ai.image_id and hid_ai.album_id = 'HID'" },
            ],
        },
        list: {
            "${row.album_id}": {
                sql: "SELECT DISTINCT sub.album_id FROM (${composed}) AS sub",
                data_var: "row",
                provider: "album_of_provider",
                properties: { album_id: "${row.album_id}" },
            },
        },
        resolve: { hide: { provider: "images_hide_provider" } },
    }"#,
    r#"{
        name: "images_hide_provider",
        query: { where: "hid_ai.image_id IS NULL" },
        list: {
            "${row.album_id}": {
                sql: "SELECT DISTINCT sub.album_id FROM (${composed}) AS sub",
                data_var: "row",
                provider: "album_of_provider",
                properties: { album_id: "${row.album_id}" },
            },
        },
    }"#,
    r#"{
        name: "album_of_provider",
        properties: { album_id: { type: "string" } },
        query: { where: "albums.id = ${properties.album_id}" },
    }"#,
    r#"{
        name: "unclear_provider",
        query: { where_clear: ["albums.parent_id"], where: "1 = 1" },
    }"#,
    r#"{
        name: "literal_tilde_provider",
        query: { where: "albums.name = 'A'" },
    }"#,
];

/// P 下四个子画册 A(3 张，其中 3 号被隐藏) B(2) C(0) D(1)；HID 是隐藏画册。
fn fixture_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT);
        CREATE TABLE images (id INTEGER PRIMARY KEY);
        CREATE TABLE album_images (album_id TEXT, image_id INTEGER);
        INSERT INTO albums VALUES
            ('P','P',NULL), ('A','A','P'), ('B','B','P'), ('C','C','P'), ('D','D','P'),
            ('HID','Hidden',NULL);
        INSERT INTO images VALUES (1),(2),(3),(4),(5),(6);
        INSERT INTO album_images VALUES
            ('A',1),('A',2),('A',3),('B',4),('B',5),('D',6),('HID',3);
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
                EngineError::FactoryFailed("sqlite".into(), "prepare".into(), format!("{e}: {sql}"))
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
    rt.register_schema("t", "albums", "", "root").unwrap();
    rt
}

/// 列举并取每项计数, 按名称排序便于断言。
fn counts(rt: &ProviderRuntime, path: &str) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = rt
        .list_with_count(path)
        .unwrap_or_else(|e| panic!("list_with_count({path}) failed: {e}"))
        .into_iter()
        .map(|c| (c.name, c.total.expect("child has provider")))
        .collect();
    out.sort();
    out
}

fn names(rt: &ProviderRuntime, path: &str) -> HashSet<String> {
    rt.fetch(path)
        .unwrap_or_else(|e| panic!("fetch({path}) failed: {e}"))
        .into_iter()
        .map(|row| row["name"].as_str().unwrap().to_string())
        .collect()
}

fn owned(pairs: &[(&str, usize)]) -> Vec<(String, usize)> {
    pairs.iter().map(|(n, c)| (n.to_string(), *c)).collect()
}

// ===== 核心语义: 先切页再 join =====

#[test]
fn nest_pages_albums_before_join() {
    let rt = runtime();
    // 页本身: [A, B] / [C, D]
    assert_eq!(
        names(&rt, "t://parent/P/p_1"),
        HashSet::from(["A".into(), "B".into()])
    );
    // 边界之后 join 成员行, 计数只作用于这一页（C 没有图片, 不出现）
    assert_eq!(
        counts(&rt, "t://parent/P/p_1/~~/images"),
        owned(&[("A", 3), ("B", 2)])
    );
    assert_eq!(
        counts(&rt, "t://parent/P/p_2/~~/images"),
        owned(&[("D", 1)])
    );
}

#[test]
fn nest_hide_counts_exclude_hidden_images() {
    let rt = runtime();
    assert_eq!(
        counts(&rt, "t://parent/P/p_1/~~/images/hide"),
        owned(&[("A", 2), ("B", 2)])
    );
}

#[test]
fn nest_wraps_previous_query_as_from_aliased_by_table() {
    let rt = runtime();
    let node = rt.resolve("t://parent/P/p_1/~~/images").unwrap();
    match node.composed.from {
        Some(FromSource::Subquery {
            ref inner,
            ref alias,
        }) => {
            assert_eq!(alias, "albums");
            // 分页留在内层
            assert!(inner.limit.is_some());
            assert!(node.composed.limit.is_none());
        }
        ref other => panic!("expected subquery FROM, got {other:?}"),
    }
    let (sql, _) = node
        .composed
        .build_sql(&Default::default(), SqlDialect::Sqlite)
        .unwrap();
    // 内层物化成 CTE，外层以表名作别名引用它
    assert!(
        sql.starts_with("WITH pq_nest_1 AS MATERIALIZED (SELECT albums.id AS id, albums.name AS name, albums.parent_id AS parent_id FROM albums WHERE (albums.parent_id = ?) ORDER BY albums.name ASC LIMIT 2 OFFSET"),
        "{sql}"
    );
    assert!(
        sql.contains(") SELECT albums.*, albums.id AS album_id, images.id AS image_id FROM pq_nest_1 AS albums INNER JOIN album_images AS ai"),
        "{sql}"
    );
}

#[test]
fn fields_accumulated_before_nest_survive_the_next_boundary() {
    let rt = runtime();
    let rows = rt.fetch("t://parent/P/p_1/~~/images/~~").unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let obj = row.as_object().unwrap();
        for key in ["id", "name", "parent_id", "album_id", "image_id"] {
            assert!(obj.contains_key(key), "missing `{key}` in {obj:?}");
        }
    }
}

#[test]
fn nest_boundary_is_materialized_once_in_sqlite_plan() {
    // 派生表会被当 co-routine 放进内层循环、每行外层重跑一遍分页；CTE 物化后只算一次
    let rt = runtime();
    let node = rt.resolve("t://parent/P/p_1/~~/images/hide").unwrap();
    let (sql, values) = node
        .composed
        .build_sql(&Default::default(), SqlDialect::Sqlite)
        .unwrap();
    let conn = fixture_db();
    let conn = conn.lock().unwrap();
    let params = local_params_for(&values);
    let plan: Vec<String> = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            r.get::<_, String>(3)
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        plan.iter().any(|d| d == "MATERIALIZE pq_nest_1"),
        "{plan:?}"
    );
    assert!(
        !plan.iter().any(|d| d.starts_with("CO-ROUTINE")),
        "{plan:?}"
    );

    // `${composed}` 内联与 COUNT 包装都会把整条 WITH 语句放进括号里，SQLite 须接受
    let wrapped: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM (({sql})) AS sub"),
            rusqlite::params_from_iter(params.iter()),
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(wrapped, 4); // A 的 1、2 号 + B 的 4、5 号（3 号隐藏）
}

#[test]
fn nest_supports_multiple_levels_and_leading_position() {
    let rt = runtime();
    // L1 = P 的全部子画册, L2 = 其中第 2 页 [C, D], L3 = 成员行
    assert_eq!(
        counts(&rt, "t://parent/P/~~/p_2/~~/images"),
        owned(&[("D", 1)])
    );
    // 开头就封边界也合法: 等价于包一层的全表
    assert_eq!(names(&rt, "t://~~").len(), 6);
}

#[test]
fn where_clear_cannot_reach_across_nest() {
    let rt = runtime();
    // 同层清得掉: 回到全表
    assert_eq!(names(&rt, "t://parent/P/unclear").len(), 6);
    // 跨边界清不到: 内层已冻结, 仍只有 P 的子画册
    assert_eq!(
        names(&rt, "t://parent/P/~~/unclear"),
        HashSet::from(["A".into(), "B".into(), "C".into(), "D".into()])
    );
}

// ===== 错误与转义 =====

#[test]
fn nest_inside_where_group_rejected() {
    let rt = runtime();
    let err = rt.resolve("t://~any/parent/P/~~/~end").unwrap_err();
    assert!(
        matches!(&err, EngineError::WhereGroup(path, msg) if path.ends_with("/~~") && msg.contains("`~~`")),
        "{err}"
    );
}

#[test]
fn nest_under_programmatic_schema_rejected() {
    let rt = runtime();
    rt.register_programmatic_schema("prog", "", "root").unwrap();
    let err = rt.resolve("prog://parent/P/~~").unwrap_err();
    assert!(
        matches!(&err, EngineError::SubqueryUnsupported(path, scheme) if path == "prog://parent/P/~~" && scheme == "prog"),
        "{err}"
    );
}

#[test]
fn nest_marker_is_exact_and_escapable() {
    let rt = runtime();
    assert!(matches!(
        rt.resolve("t://parent/P/~~x"),
        Err(EngineError::ReservedPathSegment(_, _))
    ));
    // 转义后是普通字面段, 路由到名为 `~~` 的静态项
    assert_eq!(names(&rt, r"t://\~~"), HashSet::from(["A".into()]));
}

#[test]
fn duplicate_ref_alias_is_a_resolve_error_across_nest() {
    let source = r#"{
        name: "duplicate_ref_root",
        query: {
            join: [
                { table: "album_images", as: "${ref:t1}" },
                { table: "images", as: "${ref:t1}" },
            ],
        },
    }"#;
    let mut registry = ProviderRegistry::new();
    registry
        .register(Json5Loader {}.load(Source::Str(source)).unwrap())
        .unwrap();
    let rt = ProviderRuntime::with_registry(
        Arc::new(registry),
        make_executor(fixture_db()),
        HashMap::new(),
    );
    rt.register_schema("fold-error", "albums", "", "duplicate_ref_root")
        .unwrap();

    let err = rt.resolve("fold-error://~~").unwrap_err();
    assert!(
        matches!(err, EngineError::Fold(pathql_rs::compose::FoldError::AliasCollision(alias)) if alias == "_a0")
    );
}

// ===== 缓存、列举与 meta =====

#[test]
fn nest_boundary_is_cached_and_invalidated_across_levels() {
    let rt = runtime();
    rt.resolve("t://parent/P/p_1/~~/images").unwrap();
    assert!(rt.is_path_cached("t://parent/P/p_1/~~"));
    assert!(rt.is_path_cached("t://parent/P/p_1/~~/images"));
    // 从缓存续跑结果不变
    assert_eq!(
        counts(&rt, "t://parent/P/p_1/~~/images"),
        owned(&[("A", 3), ("B", 2)])
    );

    // 边界**之前**用到的 provider 变更, 边界之后的缓存也要失效
    assert!(rt.unregister_provider("", "parent_provider"));
    assert!(!rt.is_path_cached("t://parent/P/p_1/~~"));
    assert!(!rt.is_path_cached("t://parent/P/p_1/~~/images"));
}

#[test]
fn nest_node_lists_like_root_and_serves_meta() {
    let rt = runtime();
    let under_nest: HashSet<String> = rt
        .list("t://parent/P/~~")
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    let at_root: HashSet<String> = rt
        .list("t://")
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(under_nest, at_root);
    // `…/~~/images` 的 meta 取自父路径 `…/~~` 的列举项, 静态项无 meta
    assert_eq!(rt.meta("t://parent/P/~~/images").unwrap(), None);
}

// ===== group_by: 边界之后按外层行分组, 一次 fetch 出整页计数 =====

fn image_counts(rt: &ProviderRuntime, path: &str) -> Vec<(String, i64)> {
    let mut out: Vec<(String, i64)> = rt
        .fetch(path)
        .unwrap_or_else(|e| panic!("fetch({path}) failed: {e}"))
        .into_iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap().to_string(),
                row["image_count"].as_i64().unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn group_by_after_nest_counts_whole_page_in_one_fetch() {
    let rt = runtime();
    // 与 list_with_count 的逐项计数一致, 但只发一条 SQL; C 没有图片不出行
    assert_eq!(
        image_counts(&rt, "t://parent/P/p_1/~~/counts"),
        vec![("A".into(), 3), ("B".into(), 2)]
    );
    assert_eq!(
        image_counts(&rt, "t://parent/P/p_2/~~/counts"),
        vec![("D".into(), 1)]
    );
    assert_eq!(
        image_counts(&rt, "t://parent/P/p_1/~~/counts/hide"),
        vec![("A".into(), 2), ("B".into(), 2)]
    );
    // count = 分组数（有图片的画册数）
    assert_eq!(rt.count("t://parent/P/p_1/~~/counts").unwrap(), 2);

    let node = rt.resolve("t://parent/P/p_1/~~/counts/hide").unwrap();
    let (sql, _) = node
        .composed
        .build_sql(&Default::default(), SqlDialect::Sqlite)
        .unwrap();
    assert!(
        sql.ends_with("WHERE (hid_ai.image_id IS NULL) GROUP BY albums.id"),
        "{sql}"
    );
}

#[test]
fn group_by_does_not_cross_nest_boundary() {
    // 新一层从空查询开始: 内层的 group_by 留在 CTE 里, 外层不继承
    let rt = runtime();
    let node = rt.resolve("t://counts/~~").unwrap();
    assert!(node.composed.group_by.is_empty());
    match &node.composed.from {
        Some(FromSource::Subquery { inner, .. }) => {
            assert_eq!(inner.group_by.len(), 1);
        }
        other => panic!("expected subquery FROM, got {other:?}"),
    }
    // 外层是根的行结构, 行数 = 内层分组数（有图片的 A、B、D、HID）
    assert_eq!(rt.count("t://counts/~~").unwrap(), 4);
}
