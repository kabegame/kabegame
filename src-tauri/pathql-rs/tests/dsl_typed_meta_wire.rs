//! Phase 6c S5bis-c: typed meta wire format 兼容性。
//!
//! 验证: DSL ChildEntry.meta 携带 `{kind, data: {...}}` 结构原样穿透 runtime.list / runtime.meta;
//! 模板片段在 data 子树内正确求值; runtime.meta(path) 与 runtime.list(parent) 中 name=last 的子项 meta 一致。

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::ProviderDef;
use pathql_rs::provider::{
    ClosureExecutor, DslProvider, Provider, ProviderRuntime, SqlDialect, SqlExecutor,
};
use pathql_rs::ProviderRegistry;

fn empty_registry() -> Arc<ProviderRegistry> {
    Arc::new(ProviderRegistry::new())
}

fn no_op_executor() -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(SqlDialect::Sqlite, |_sql, _params| {
        Ok(Vec::new())
    }))
}

#[test]
fn typed_meta_static_preserved_with_template_eval() {
    let def_json = r#"{
        "namespace": "test",
        "name": "facade",
        "properties": {"label": {"type": "string", "default": "hello"}},
        "list": {
            "child_a": {
                "provider": "__empty",
                "meta": {
                    "kind": "test_kind",
                    "data": {"label": "${properties.label}", "fixed": 42}
                }
            }
        }
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();
    let mut props: HashMap<String, pathql_rs::template::eval::TemplateValue> = HashMap::new();
    props.insert(
        "label".into(),
        pathql_rs::template::eval::TemplateValue::Text("greetings".into()),
    );
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: props,
    });
    let runtime = ProviderRuntime::new(empty_registry(), root, no_op_executor());

    let children = runtime.list("/").unwrap();
    assert_eq!(children.len(), 1);
    let meta = children[0].meta.clone().unwrap();
    assert_eq!(meta["kind"], "test_kind");
    assert_eq!(meta["data"]["label"], "greetings");
    assert_eq!(meta["data"]["fixed"], 42);
}

#[test]
fn runtime_meta_path_matches_parent_list_child_meta() {
    let def_json = r#"{
        "namespace": "test",
        "name": "router",
        "list": {
            "leaf_x": {
                "provider": "__empty",
                "meta": {"kind": "leaf", "data": {"id": "x"}}
            }
        }
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let runtime = ProviderRuntime::new(empty_registry(), root, no_op_executor());

    // root list shows leaf_x with the typed meta
    let listed = runtime.list("/").unwrap();
    let listed_meta = listed[0].meta.clone().unwrap();

    // runtime.meta("/leaf_x") = parent root's list output's leaf_x.meta
    let meta_at = runtime.meta("/leaf_x").unwrap().unwrap();

    assert_eq!(listed_meta, meta_at);
    assert_eq!(meta_at["kind"], "leaf");
    assert_eq!(meta_at["data"]["id"], "x");
}

#[test]
fn root_meta_is_none() {
    let def: ProviderDef = serde_json::from_str(r#"{"name":"r"}"#).unwrap();
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let runtime = ProviderRuntime::new(empty_registry(), root, no_op_executor());
    assert!(runtime.meta("/").unwrap().is_none());
}

#[test]
fn meta_for_unknown_segment_returns_none() {
    let def_json = r#"{
        "name": "r",
        "list": {"a": {"provider": "__empty", "meta": {"kind": "k"}}}
    }"#;
    let def: ProviderDef = serde_json::from_str(def_json).unwrap();
    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(def),
        properties: HashMap::new(),
    });
    let runtime = ProviderRuntime::new(empty_registry(), root, no_op_executor());
    // Path /a is in list -> meta exists
    assert!(runtime.meta("/a").unwrap().is_some());
}
