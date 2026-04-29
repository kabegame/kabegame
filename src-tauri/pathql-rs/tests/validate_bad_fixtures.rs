//! 反样本：每条构造一份触发特定 ValidateErrorKind 的 ProviderDef,
//! register 到独立 registry, 跑 validate, 断言对应 kind 出现。

#![cfg(feature = "validate")]

use pathql_rs::ast::*;
use pathql_rs::validate::{validate, ValidateConfig, ValidateError, ValidateErrorKind};
use pathql_rs::ProviderRegistry;
use std::collections::HashMap;

fn base_def(name: &str) -> ProviderDef {
    ProviderDef {
        schema: None,
        namespace: Some(Namespace("k".into())),
        name: SimpleName(name.into()),
        properties: None,
        query: None,
        list: None,
        resolve: None,
        note: None,
    }
}

fn run_one(d: ProviderDef) -> Vec<ValidateError> {
    let mut r = ProviderRegistry::new();
    r.register(d).unwrap();
    let cfg = ValidateConfig::with_default_reserved();
    match validate(&r, &cfg) {
        Ok(()) => Vec::new(),
        Err(e) => e,
    }
}

fn run_one_strict_cross(d: ProviderDef) -> Vec<ValidateError> {
    let mut r = ProviderRegistry::new();
    r.register(d).unwrap();
    let cfg = ValidateConfig::with_default_reserved().with_cross_refs(true);
    match validate(&r, &cfg) {
        Ok(()) => Vec::new(),
        Err(e) => e,
    }
}

fn assert_kind<F: Fn(&ValidateErrorKind) -> bool>(
    errs: &[ValidateError],
    pred: F,
    label: &str,
) {
    assert!(
        errs.iter().any(|e| pred(&e.kind)),
        "expected {} among errors:\n{}",
        label,
        errs.iter()
            .map(|e| format!("  {}", e))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn bad_name_caps_or_invalid() {
    let mut d = base_def("BAD-NAME");
    d.namespace = Some(Namespace("k".into()));
    let errs = run_one(d);
    assert_kind(&errs, |k| matches!(k, ValidateErrorKind::InvalidName(_)), "InvalidName");
}

#[test]
fn bad_namespace() {
    let mut d = base_def("p");
    d.namespace = Some(Namespace(".bad".into()));
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::InvalidNamespace(_)),
        "InvalidNamespace",
    );
}

#[test]
fn undefined_ref_in_where() {
    let q = ContribQuery {
        from: Some(SqlExpr("images".into())),
        where_: Some(SqlExpr("${ref:nope} > 0".into())),
        ..Default::default()
    };
    let mut d = base_def("p");
    d.query = Some(Query::Contrib(q));
    let errs = run_one(d);
    assert_kind(&errs, |k| matches!(k, ValidateErrorKind::UndefinedRef(_)), "UndefinedRef");
}

#[test]
fn ref_alias_with_in_need() {
    let q = ContribQuery {
        join: Some(vec![Join {
            kind: None,
            table: SqlExpr("t".into()),
            alias: AliasName("${ref:t}".into()),
            on: None,
            in_need: Some(true),
        }]),
        ..Default::default()
    };
    let mut d = base_def("p");
    d.query = Some(Query::Contrib(q));
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::RefAliasWithInNeed),
        "RefAliasWithInNeed",
    );
}

#[test]
fn from_contains_join_keyword() {
    let q = ContribQuery {
        from: Some(SqlExpr("images JOIN album_images ai ON ai.image_id = images.id".into())),
        ..Default::default()
    };
    let mut d = base_def("p");
    d.query = Some(Query::Contrib(q));
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::FromContainsJoin),
        "FromContainsJoin",
    );
}

#[test]
fn dynamic_var_mismatch() {
    let list = List {
        entries: vec![(
            "${other.id}".into(),
            ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                sql: SqlExpr("SELECT id FROM tbl".into()),
                data_var: Identifier("row".into()),
                provider: None,
                properties: None,
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::DynamicVarMismatch(_, _, _)),
        "DynamicVarMismatch",
    );
}

#[test]
fn dynamic_sql_provider_ref_rejected() {
    let mut props = HashMap::new();
    props.insert(
        "x".into(),
        TemplateValue::String("${row.provider}".into()),
    );
    let list = List {
        entries: vec![(
            "${row.id}".into(),
            ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                sql: SqlExpr("SELECT 1".into()),
                data_var: Identifier("row".into()),
                provider: None,
                properties: Some(props),
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::DynamicSqlProviderRef),
        "DynamicSqlProviderRef",
    );
}

#[test]
fn reserved_data_var() {
    let list = List {
        entries: vec![(
            "${composed.x}".into(),
            ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                sql: SqlExpr("SELECT 1".into()),
                data_var: Identifier("ref".into()),
                provider: None,
                properties: None,
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::ReservedIdent(_)),
        "ReservedIdent",
    );
}

#[test]
fn delegate_self_cycle_detected() {
    // 6e: delegate 是 ProviderCall; 自指环 A→A
    let mut d = base_def("loopy");
    d.query = Some(Query::Delegate(DelegateQuery {
        delegate: ProviderCall {
            provider: ProviderName("loopy".into()),
            properties: None,
        },
    }));
    let mut r = ProviderRegistry::new();
    r.register(d).unwrap();
    let cfg = ValidateConfig::with_default_reserved().with_cross_refs(true);
    let errs = match validate(&r, &cfg) {
        Ok(()) => Vec::new(),
        Err(es) => es,
    };
    assert!(errs
        .iter()
        .any(|e| matches!(e.kind, ValidateErrorKind::DelegateCycle(_))));
}

#[test]
fn delegate_two_node_cycle_detected() {
    // 6e: A.delegate→B, B.delegate→A
    let mut a = base_def("a");
    a.query = Some(Query::Delegate(DelegateQuery {
        delegate: ProviderCall {
            provider: ProviderName("b".into()),
            properties: None,
        },
    }));
    let mut b = base_def("b");
    b.query = Some(Query::Delegate(DelegateQuery {
        delegate: ProviderCall {
            provider: ProviderName("a".into()),
            properties: None,
        },
    }));
    let mut r = ProviderRegistry::new();
    r.register(a).unwrap();
    r.register(b).unwrap();
    let cfg = ValidateConfig::with_default_reserved().with_cross_refs(true);
    let errs = match validate(&r, &cfg) {
        Ok(()) => Vec::new(),
        Err(es) => es,
    };
    assert!(errs
        .iter()
        .any(|e| matches!(e.kind, ValidateErrorKind::DelegateCycle(_))));
}

#[test]
fn multi_stmt_in_dynamic_sql() {
    let list = List {
        entries: vec![(
            "${row.id}".into(),
            ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                sql: SqlExpr("SELECT 1; SELECT 2".into()),
                data_var: Identifier("row".into()),
                provider: None,
                properties: None,
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::SqlMultipleStatements),
        "SqlMultipleStatements",
    );
}

#[test]
fn ddl_in_dynamic_sql() {
    let list = List {
        entries: vec![(
            "${row.id}".into(),
            ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                sql: SqlExpr("DROP TABLE images".into()),
                data_var: Identifier("row".into()),
                provider: None,
                properties: None,
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::SqlDdlNotAllowed(_)),
        "SqlDdlNotAllowed",
    );
}

#[test]
fn invalid_regex_in_resolve() {
    let mut resolve = Resolve::default();
    resolve.0.insert(
        "[bad".into(),
        ProviderInvocation::ByName(InvokeByName {
            provider: ProviderName("p2".into()),
            properties: None,
            meta: None,
        }),
    );
    let mut d = base_def("p");
    d.resolve = Some(resolve);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::RegexCompileError { .. }),
        "RegexCompileError",
    );
}

// 7b: regex_matches_static_list_key + regex_pair_overlap_in_resolve 测试整个删除。
//      碰撞检测被去掉, 因为 `.*` 转发模式 + ${properties.X} instance-static key 都是
//      合法重叠, 运行期解析顺序保证作者意图。

#[test]
fn capture_index_out_of_bounds() {
    let mut props = HashMap::new();
    props.insert(
        "x".into(),
        TemplateValue::String("${capture[5]}".into()),
    );
    let mut resolve = Resolve::default();
    resolve.0.insert(
        "^([a-z]+)$".into(),
        ProviderInvocation::ByName(InvokeByName {
            provider: ProviderName("p2".into()),
            properties: Some(props),
            meta: None,
        }),
    );
    let mut d = base_def("p");
    d.resolve = Some(resolve);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::CaptureIndexOutOfBounds { .. }),
        "CaptureIndexOutOfBounds",
    );
}

#[test]
fn unresolved_provider_ref_when_strict() {
    let list = List {
        entries: vec![(
            "k".into(),
            ListEntry::Static(ProviderInvocation::ByName(InvokeByName {
                provider: ProviderName("nonexistent_provider".into()),
                properties: None,
                meta: None,
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one_strict_cross(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::UnresolvedProviderRef(_, _)),
        "UnresolvedProviderRef",
    );
}

#[test]
fn meta_ddl_string_rejected() {
    let list = List {
        entries: vec![(
            "k".into(),
            ListEntry::Static(ProviderInvocation::ByName(InvokeByName {
                provider: ProviderName("p2".into()),
                properties: None,
                meta: Some(serde_json::json!("DROP TABLE images")),
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::SqlDdlNotAllowed(_)),
        "SqlDdlNotAllowed (in meta)",
    );
}

#[test]
fn meta_template_bad_scope_rejected() {
    let list = List {
        entries: vec![(
            "k".into(),
            ListEntry::Static(ProviderInvocation::ByName(InvokeByName {
                provider: ProviderName("p2".into()),
                properties: None,
                meta: Some(serde_json::json!("${unknown_ns.x}")),
            })),
        )],
    };
    let mut d = base_def("p");
    d.list = Some(list);
    let errs = run_one(d);
    assert_kind(
        &errs,
        |k| matches!(k, ValidateErrorKind::TemplateScope(_)),
        "TemplateScope",
    );
}
