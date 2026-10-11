//! 全局前缀表与透传 resolve 的 sqlite 端到端覆盖。

#![cfg(feature = "json5")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pathql_rs::provider::{ClosureExecutor, EngineError, ProviderRuntime, SqlDialect, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{Json5Loader, Loader, ProviderDef, ProviderRegistry, Source};
use rusqlite::Connection;

fn local_params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    values
        .iter()
        .map(|value| match value {
            TemplateValue::Null => rusqlite::types::Value::Null,
            TemplateValue::Bool(value) => rusqlite::types::Value::Integer(i64::from(*value)),
            TemplateValue::Int(value) => rusqlite::types::Value::Integer(*value),
            TemplateValue::Real(value) => rusqlite::types::Value::Real(*value),
            TemplateValue::Text(value) => rusqlite::types::Value::Text(value.clone()),
            TemplateValue::Json(value) => rusqlite::types::Value::Text(value.to_string()),
        })
        .collect()
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(
        SqlDialect::Sqlite,
        move |sql, params| {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(sql).map_err(|error| {
                EngineError::FactoryFailed("sqlite".into(), "prepare".into(), error.to_string())
            })?;
            let columns: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|name| name.to_string())
                .collect();
            let params = local_params_for(params);
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    let mut object = serde_json::Map::new();
                    for (index, column) in columns.iter().enumerate() {
                        let value = match row.get_ref_unwrap(index) {
                            rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                            rusqlite::types::ValueRef::Integer(value) => value.into(),
                            rusqlite::types::ValueRef::Real(value) => value.into(),
                            rusqlite::types::ValueRef::Text(value) => {
                                String::from_utf8_lossy(value).into_owned().into()
                            }
                            rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                        };
                        object.insert(column.clone(), value);
                    }
                    Ok(serde_json::Value::Object(object))
                })
                .map_err(|error| {
                    EngineError::FactoryFailed("sqlite".into(), "query".into(), error.to_string())
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                EngineError::FactoryFailed("sqlite".into(), "collect".into(), error.to_string())
            })
        },
    ))
}

fn def(source: &str) -> ProviderDef {
    Json5Loader.load(Source::Str(source)).unwrap()
}

fn runtime_with_global(register_global: bool) -> Arc<ProviderRuntime> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT);
         INSERT INTO items VALUES (1, 'root'), (2, 'global'), (3, 'fallback');",
    )
    .unwrap();

    let mut registry = ProviderRegistry::new();
    for provider in [
        def(r#"{
            name: "root",
            query: { fields: ["items.id", "items.kind"], order: [{ sql: "items.id", order: "asc" }] },
            list: {
                "${row.id}": {
                    sql: "SELECT id FROM (${composed}) AS rows",
                    data_var: "row",
                    provider: "leaf"
                }
            },
            resolve: {
                next: { provider: "next" },
                plain: { provider: "fallback" },
                _g_miss: { provider: "fallback" },
                ".*": { provider: "wildcard" }
            }
        }"#),
        def(r#"{ name: "global", query: { where: "items.kind = 'global'" } }"#),
        def(r#"{ name: "fallback", query: { where: "items.kind = 'fallback'" } }"#),
        def(r#"{ name: "wildcard", query: { where: "items.kind = 'root'" } }"#),
        def(r#"{ name: "next", query: { where: "items.id > 1" } }"#),
        def(r#"{ name: "clear_order", query: { order: { all: "clear" } } }"#),
        def(r#"{ name: "leaf" }"#),
        def(r#"{
            name: "global_table",
            resolve: {
                _g_hit: { provider: "global" },
                _g_clear: { provider: "clear_order", passthrough: true },
                plain: { provider: "global" }
            }
        }"#),
    ] {
        registry.register(provider).unwrap();
    }

    let runtime = ProviderRuntime::with_registry(
        Arc::new(registry),
        make_executor(Arc::new(Mutex::new(conn))),
        HashMap::new(),
    );
    runtime.register_schema("t", "items", "", "root").unwrap();
    if register_global {
        runtime
            .register_global_table("_g_", "", "global_table")
            .unwrap();
    }
    runtime
}

fn runtime() -> Arc<ProviderRuntime> {
    runtime_with_global(true)
}

fn ids(runtime: &ProviderRuntime, path: &str) -> Vec<i64> {
    runtime
        .fetch(path)
        .unwrap()
        .into_iter()
        .map(|row| row["id"].as_i64().unwrap())
        .collect()
}

#[test]
fn prefix_hit_precedes_local_wildcard_and_misses_fall_back() {
    let runtime = runtime();
    assert_eq!(ids(&runtime, "t://_g_hit"), vec![2]);
    assert_eq!(ids(&runtime, "t://_g_miss"), vec![3]);
    assert_eq!(ids(&runtime, "t://plain"), vec![3]);
}

#[test]
fn passthrough_keeps_current_provider_and_only_changes_composed_query() {
    let runtime = runtime();
    let before: Vec<_> = runtime
        .list("t://")
        .unwrap()
        .into_iter()
        .map(|child| child.name)
        .collect();
    let after: Vec<_> = runtime
        .list("t://_g_clear")
        .unwrap()
        .into_iter()
        .map(|child| child.name)
        .collect();
    assert_eq!(before, after);

    let resolved = runtime.resolve("t://_g_clear").unwrap();
    let (sql, _) = resolved
        .composed
        .build_sql(&Default::default(), SqlDialect::Sqlite)
        .unwrap();
    assert!(!sql.contains(" ORDER BY "), "{sql}");
    assert_eq!(ids(&runtime, "t://_g_clear/next"), vec![2, 3]);
}

#[test]
fn global_table_participates_in_cache_invalidation() {
    let runtime = runtime();
    runtime.resolve("t://_g_hit").unwrap();
    runtime.resolve("t://_g_miss").unwrap();
    assert!(runtime.is_path_cached("t://_g_hit"));
    assert!(runtime.is_path_cached("t://_g_miss"));

    runtime
        .register_global_table("_g_", "", "global_table")
        .unwrap();
    assert!(!runtime.is_path_cached("t://_g_hit"));
    assert!(!runtime.is_path_cached("t://_g_miss"));
}

#[test]
fn first_global_table_registration_invalidates_existing_fallback_cache() {
    let runtime = runtime_with_global(false);
    assert_eq!(ids(&runtime, "t://_g_hit"), vec![1]);
    assert!(runtime.is_path_cached("t://_g_hit"));

    runtime
        .register_global_table("_g_", "", "global_table")
        .unwrap();
    assert!(!runtime.is_path_cached("t://_g_hit"));
    assert_eq!(ids(&runtime, "t://_g_hit"), vec![2]);
}
