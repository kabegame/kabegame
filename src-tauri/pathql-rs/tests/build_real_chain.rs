//! 端到端：fold 真路径链 → build_sql → sqlite 执行。
//!
//! 路径：gallery_route → gallery_paginate_router → query_page_provider。
//! Delegate 节点 (gallery_all_router, gallery_page_router) 跳过 (Phase 6 ProviderRuntime 处理)。

#![cfg(all(feature = "json5", feature = "sqlite"))]

use std::path::PathBuf;

use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::ast::{Namespace, ProviderName, Query};
use pathql_rs::compose::{fold_contrib, ProviderQuery};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

const PROVIDER_FILES: &[&str] = &[
    "root_provider.json",
    "gallery/gallery_route.json5",
    "gallery/gallery_all_router.json5",
    "gallery/gallery_paginate_router.json5",
    "gallery/gallery_page_router.json5",
    "shared/page_size_provider.json5",
    "shared/query_page_provider.json5",
    "vd/vd_root_router.json5",
    "vd/vd_zh_CN_root_router.json5",
];

fn build_full_registry() -> ProviderRegistry {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core")
        .join("src")
        .join("providers");
    let loader = Json5Loader;
    let mut registry = ProviderRegistry::new();
    for rel in PROVIDER_FILES {
        let path = dir.join(rel);
        let def = loader
            .load(Source::Path(&path))
            .unwrap_or_else(|e| panic!("load {}: {}", rel, e));
        registry
            .register(def)
            .unwrap_or_else(|e| panic!("register {}: {}", rel, e));
    }
    registry
}

fn fold_provider_query(state: &mut ProviderQuery, registry: &ProviderRegistry, name: &str) {
    let ns = Namespace("kabegame".into());
    let def = registry
        .resolve(&ns, &ProviderName(name.into()))
        .unwrap_or_else(|| panic!("provider {} not in registry", name));
    if let Some(Query::Contrib(q)) = &def.query {
        fold_contrib(state, q).unwrap_or_else(|e| panic!("fold {} failed: {}", name, e));
    }
}

fn fold_gallery_page_chain(registry: &ProviderRegistry) -> ProviderQuery {
    let mut state = ProviderQuery::new();
    fold_provider_query(&mut state, registry, "gallery_route");
    fold_provider_query(&mut state, registry, "gallery_all_router"); // delegate, skipped
    fold_provider_query(&mut state, registry, "gallery_paginate_router");
    fold_provider_query(&mut state, registry, "gallery_page_router"); // delegate, skipped
    fold_provider_query(&mut state, registry, "query_page_provider");
    state
}

#[test]
fn build_gallery_page_chain_renders_executable_sql() {
    let registry = build_full_registry();
    let state = fold_gallery_page_chain(&registry);

    let ctx = TemplateContext::default().with_properties(
        [
            ("page_size".into(), TemplateValue::Int(100)),
            ("page_num".into(), TemplateValue::Int(1)),
        ]
        .into_iter()
        .collect(),
    );

    let (sql, params) = state.build_sql(&ctx).expect("build_sql");

    // string snapshot
    assert!(sql.contains("FROM images"), "sql missing FROM images: {}", sql);
    assert!(sql.contains(" LIMIT ?"), "sql missing LIMIT ?: {}", sql);
    assert!(sql.contains(" OFFSET ("), "sql missing OFFSET (...): {}", sql);

    // 3 bind params: limit + 2 offset operands
    assert_eq!(params.len(), 3, "expected 3 params, got {:?}", params);
    assert_eq!(params[0], TemplateValue::Int(100)); // LIMIT
    assert_eq!(params[1], TemplateValue::Int(100)); // OFFSET page_size
    assert_eq!(params[2], TemplateValue::Int(1)); // OFFSET page_num

    // sqlite execute (in-memory)
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
         INSERT INTO images (title) VALUES ('a'), ('b'), ('c');",
    )
    .unwrap();

    let rusqlite_params = params_for(&params);
    let mut stmt = conn.prepare(&sql).unwrap_or_else(|e| {
        panic!("prepare failed for sql=\n{}\n: {}", sql, e);
    });
    let row_count: i64 = stmt
        .query_map(
            rusqlite::params_from_iter(rusqlite_params.iter()),
            |_| Ok(1i64),
        )
        .unwrap()
        .count() as i64;
    assert_eq!(row_count, 3, "should return all 3 inserted rows");
}

#[test]
fn build_gallery_page_chain_with_page_2_offsets_correctly() {
    let registry = build_full_registry();
    let state = fold_gallery_page_chain(&registry);

    let ctx = TemplateContext::default().with_properties(
        [
            ("page_size".into(), TemplateValue::Int(2)),
            ("page_num".into(), TemplateValue::Int(2)),
        ]
        .into_iter()
        .collect(),
    );

    let (sql, params) = state.build_sql(&ctx).unwrap();

    // sqlite execute: 5 rows, page_size=2, page_num=2 → OFFSET 2, LIMIT 2 → rows 3,4
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
         INSERT INTO images (title) VALUES ('a'), ('b'), ('c'), ('d'), ('e');",
    )
    .unwrap();

    let rusqlite_params = params_for(&params);
    let mut stmt = conn.prepare(&sql).unwrap();
    let titles: Vec<String> = stmt
        .query_map(
            rusqlite::params_from_iter(rusqlite_params.iter()),
            |r| r.get::<_, String>(1),
        )
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(titles, vec!["c".to_string(), "d".to_string()]);
}

#[test]
fn standalone_provider_query_with_join_executes() {
    use pathql_rs::ast::{JoinKind, SqlExpr};
    use pathql_rs::compose::{FieldFrag, JoinFrag, ResolvedAlias};

    let mut q = ProviderQuery::new();
    q.from = Some(SqlExpr("images".into()));
    q.fields.push(FieldFrag {
        sql: SqlExpr("images.title".into()),
        alias: None,
        in_need: false,
    });
    q.joins.push(JoinFrag {
        kind: JoinKind::Inner,
        table: SqlExpr("album_images".into()),
        alias: ResolvedAlias::Literal("ai".into()),
        on: Some(SqlExpr("ai.image_id = images.id".into())),
        in_need: false,
    });
    q.wheres
        .push(SqlExpr("ai.album_id = ${properties.aid}".into()));

    let ctx = TemplateContext::default().with_properties(
        [("aid".into(), TemplateValue::Int(1))].into_iter().collect(),
    );
    let (sql, params) = q.build_sql(&ctx).unwrap();
    assert!(sql.contains("INNER JOIN album_images AS ai ON ai.image_id = images.id"));

    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
         CREATE TABLE album_images (album_id INTEGER, image_id INTEGER);
         INSERT INTO images (title) VALUES ('first'), ('second'), ('third');
         INSERT INTO album_images (album_id, image_id) VALUES (1, 1), (1, 2), (2, 3);",
    )
    .unwrap();

    let rusqlite_params = params_for(&params);
    let mut stmt = conn.prepare(&sql).unwrap();
    let titles: Vec<String> = stmt
        .query_map(
            rusqlite::params_from_iter(rusqlite_params.iter()),
            |r| r.get::<_, String>(0),
        )
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(titles, vec!["first".to_string(), "second".to_string()]);
}
