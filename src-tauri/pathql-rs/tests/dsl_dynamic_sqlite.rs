//! Phase 6c S0d: 真实 sqlite + DSL 动态 list 端到端。
//!
//! 验证: DslProvider 通过注入的 SqlExecutor 跑动态 SQL list 项, 行 → 子节点;
//! `resolve` 走动态反查命中。Delegate 动态项委托另一路径并枚举。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pathql_rs::ast::ProviderDef;
use pathql_rs::provider::{
    ChildEntry, ClosureExecutor, DslProvider, EngineError, Provider, ProviderContext,
    ProviderRuntime, SqlDialect, SqlExecutor,
};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::ProviderRegistry;
use rusqlite::Connection;

/// 6d: pathql-rs 不再附 driver 桥; 集成测试本地内联 TemplateValue → rusqlite::Value 转换。
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

fn fixture_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE plugins (id TEXT PRIMARY KEY, label TEXT);
        INSERT INTO plugins VALUES ('p1','Plugin One'),('p2','Plugin Two'),('p3','Plugin Three');
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
            let rusq_params = local_params_for(params);
            let col_names: Vec<String> = stmt
                .column_names()
                .into_iter()
                .map(|s| s.to_string())
                .collect();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                    let mut obj = serde_json::Map::new();
                    for (i, name) in col_names.iter().enumerate() {
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
                EngineError::FactoryFailed("sqlite".into(), "collect".into(), e.to_string())
            })
        },
    ))
}

fn empty_registry() -> Arc<ProviderRegistry> {
    Arc::new(ProviderRegistry::new())
}

/// 6d: 测试 nopop executor (供 ExecutorMissing 已删除后的"未注入"场景占位)。
fn no_op_executor() -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(SqlDialect::Sqlite, |_sql, _params| {
        Ok(Vec::new())
    }))
}

#[test]
fn dynamic_sql_list_enumerates_rows() {
    let conn = fixture_db();
    let executor = make_executor(conn);

    let def_json = r#"{
        "namespace": "test",
        "name": "plugin_list",
        "list": {
            "${row.id}": {
                "sql": "SELECT id, label FROM plugins ORDER BY id",
                "data_var": "row",
                "meta": {"label": "${row.label}"}
            }
        }
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let runtime = ProviderRuntime::new(empty_registry(), root, executor, Default::default());

    let children = runtime.list("/").unwrap();
    let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["p1", "p2", "p3"]);

    let labels: Vec<String> = children
        .iter()
        .map(|c| {
            c.meta
                .as_ref()
                .and_then(|m| m.get("label"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(labels, vec!["Plugin One", "Plugin Two", "Plugin Three"]);
}

// 6d: ExecutorMissing 删除 — executor 改为 ProviderRuntime::new 的必填参数,
// 该 case 已不可能在编译期发生 (构造 runtime 时就要传 executor)。
// 此原 test (dynamic_sql_executor_missing_returns_error) 整个删除。

#[test]
fn dynamic_resolve_reverse_lookup_finds_match() {
    let conn = fixture_db();
    let executor = make_executor(conn);

    // No `provider` field on the dynamic entry → resolve returns Some(None) (matched but no concrete provider)
    // To assert reverse-lookup correctness with non-None, register a leaf provider and reference by name.
    let mut reg = ProviderRegistry::new();

    // Register a "pinger" provider that materializes given any properties.
    use pathql_rs::ast::{Namespace, SimpleName};
    struct Pinger;
    impl Provider for Pinger {
        fn list(
            &self,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(Vec::new())
        }
        fn resolve(
            &self,
            _: &str,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Option<Arc<dyn Provider>> {
            None
        }
    }
    reg.register_provider(
        Namespace("test".into()),
        SimpleName("pinger".into()),
        |_| Ok(Arc::new(Pinger) as Arc<dyn Provider>),
    )
    .unwrap();

    let def_json = r#"{
        "namespace": "test",
        "name": "plugin_list",
        "list": {
            "${row.id}": {
                "sql": "SELECT id FROM plugins ORDER BY id",
                "data_var": "row",
                "provider": "pinger"
            }
        }
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let runtime = ProviderRuntime::new(Arc::new(reg), root, executor, Default::default());

    // Reverse-lookup for /p2 should hit the dynamic SQL entry's row id=p2 → pinger provider.
    let resolved = runtime.resolve("/p2").unwrap();
    let _ = resolved.provider;

    // Non-matching name should produce PathNotFound.
    let err = runtime.resolve("/notfound").unwrap_err();
    assert!(matches!(err, EngineError::PathNotFound(_)));
}

#[test]
fn dynamic_delegate_list_enumerates_target_children() {
    let conn = fixture_db();
    let executor = make_executor(conn);

    // Inner provider whose list returns 2 static children
    struct Source;
    impl Provider for Source {
        fn list(
            &self,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(vec![
                ChildEntry {
                    name: "alpha".into(),
                    provider: None,
                    meta: Some(serde_json::json!({"label":"A"})),
                },
                ChildEntry {
                    name: "beta".into(),
                    provider: None,
                    meta: Some(serde_json::json!({"label":"B"})),
                },
            ])
        }
        fn resolve(
            &self,
            name: &str,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Option<Arc<dyn Provider>> {
            if name == "alpha" || name == "beta" {
                Some(Arc::new(Self) as Arc<dyn Provider>)
            } else {
                None
            }
        }
    }

    // DSL provider whose list has a dynamic delegate entry pointing at /src
    let def_json = r#"{
        "namespace": "test",
        "name": "facade",
        "list": {
            "x-${out.name}": {
                "delegate": {"provider": "src_inner"},
                "child_var": "out",
                "meta": {"upstream": "${out.meta.label}"}
            }
        }
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();

    // Composite root: /src is Source, /facade is the DSL provider above
    struct Root {
        src: Arc<dyn Provider>,
        facade: Arc<dyn Provider>,
    }
    impl Provider for Root {
        fn list(
            &self,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(vec![
                ChildEntry {
                    name: "src".into(),
                    provider: Some(self.src.clone()),
                    meta: None,
                },
                ChildEntry {
                    name: "facade".into(),
                    provider: Some(self.facade.clone()),
                    meta: None,
                },
            ])
        }
        fn resolve(
            &self,
            name: &str,
            _: &pathql_rs::compose::ProviderQuery,
            _: &ProviderContext,
        ) -> Option<Arc<dyn Provider>> {
            match name {
                "src" => Some(self.src.clone()),
                "facade" => Some(self.facade.clone()),
                _ => None,
            }
        }
    }

    // 6e: delegate 是 ProviderCall, 通过 namespace=test 解析 src_inner provider name。
    use pathql_rs::ast::{Namespace, SimpleName};
    let src: Arc<dyn Provider> = Arc::new(Source);
    let mut reg = ProviderRegistry::new();
    let src_for_factory = src.clone();
    reg.register_provider(
        Namespace("test".into()),
        SimpleName("src_inner".into()),
        move |_| Ok(src_for_factory.clone()),
    )
    .unwrap();
    let facade: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let root: Arc<dyn Provider> = Arc::new(Root { src, facade });
    let runtime = ProviderRuntime::new(Arc::new(reg), root, executor, Default::default());

    let children = runtime.list("/facade").unwrap();
    let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["x-alpha", "x-beta"]);

    let upstream: Vec<String> = children
        .iter()
        .map(|c| {
            c.meta
                .as_ref()
                .and_then(|m| m.get("upstream"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(upstream, vec!["A", "B"]);
}
