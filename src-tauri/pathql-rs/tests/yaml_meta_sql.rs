//! YAML 块标量里的多行 SQL meta 必须仍被识别为 SQL 并执行。
//!
//! 结构照搬画廊 `size/<min>-<max>`：区间 provider 在 resolve 的 meta 里用 SQL 算出上下界，
//! 路由用 delegate 取 `${computed.meta.*}` 实例化叶子。meta 若被误判成模板字符串，
//! `computed.meta.lo` 取不到，整条路径 404（回归背景：gallery_size_range_provider 迁到 YAML 后
//! `FROM` 前是换行，旧判别要求 `" from "` 两侧为空格）。

#![cfg(feature = "yaml")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pathql_rs::provider::{ClosureExecutor, EngineError, ProviderRuntime, SqlDialect};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{Loader, ProviderRegistry, Source, YamlLoader};
use rusqlite::Connection;

const RANGE_PROVIDER: &str = r#"
namespace: t
name: range_provider
resolve:
  "([0-9]+)-([0-9]+)":
    meta: |-
      SELECT
        CAST('${capture[1]}' AS INTEGER) AS lo,
        CAST('${capture[2]}' AS INTEGER) AS hi
      FROM (SELECT 1)
"#;

const ROOT: &str = r#"
namespace: t
name: root
resolve:
  ".*":
    delegate: { provider: range_provider }
    child_var: computed
    provider: range_leaf
    properties:
      lo: "${computed.meta.lo}"
      hi: "${computed.meta.hi}"
"#;

const LEAF: &str = r#"
namespace: t
name: range_leaf
properties:
  lo: { type: number, default: 0, optional: false }
  hi: { type: number, default: 0, optional: false }
query:
  where: "items.size >= ${properties.lo} AND items.size < ${properties.hi}"
"#;

fn params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    values
        .iter()
        .map(|v| match v {
            TemplateValue::Null => Value::Null,
            TemplateValue::Bool(b) => Value::Integer(*b as i64),
            TemplateValue::Int(i) => Value::Integer(*i),
            TemplateValue::Real(r) => Value::Real(*r),
            TemplateValue::Text(s) => Value::Text(s.clone()),
            TemplateValue::Json(v) => Value::Text(v.to_string()),
        })
        .collect()
}

fn runtime() -> Arc<ProviderRuntime> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, size INTEGER);
         INSERT INTO items VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6);",
    )
    .unwrap();
    let conn = Arc::new(Mutex::new(conn));
    let executor = Arc::new(ClosureExecutor::new(
        SqlDialect::Sqlite,
        move |sql: &str, params: &[TemplateValue]| {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(sql).map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "prepare".into(), format!("{e}: {sql}"))
            })?;
            let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params_for(params)), |row| {
                    let mut obj = serde_json::Map::new();
                    for (i, name) in cols.iter().enumerate() {
                        let v = match row.get_ref_unwrap(i) {
                            rusqlite::types::ValueRef::Integer(n) => serde_json::json!(n),
                            rusqlite::types::ValueRef::Text(t) => {
                                serde_json::json!(String::from_utf8_lossy(t))
                            }
                            _ => serde_json::Value::Null,
                        };
                        obj.insert(name.clone(), v);
                    }
                    Ok(serde_json::Value::Object(obj))
                })
                .map_err(|e| {
                    EngineError::FactoryFailed("sqlite".into(), "query".into(), e.to_string())
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "collect".into(), e.to_string())
            })
        },
    ));

    let mut registry = ProviderRegistry::new();
    for src in [RANGE_PROVIDER, ROOT, LEAF] {
        registry
            .register(YamlLoader.load(Source::Str(src)).unwrap())
            .unwrap();
    }
    let runtime = ProviderRuntime::with_registry(Arc::new(registry), executor, HashMap::new());
    runtime.register_schema("t", "items", "t", "root").unwrap();
    runtime
}

#[test]
fn multiline_yaml_sql_meta_feeds_delegate_properties() {
    let runtime = runtime();
    let ids: Vec<i64> = runtime
        .fetch("t://2-5")
        .unwrap()
        .iter()
        .map(|row| row["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![2, 3, 4]);
    assert_eq!(runtime.count("t://4-7").unwrap(), 3);
}
