use crate::ast::{
    DynamicListEntry, ListEntry, Namespace, ProviderDef, SimpleName,
};
use crate::template::{parse, Segment, VarRef};
use crate::validate::{ValidateConfig, ValidateError, ValidateErrorKind};

/// 校验 List 的 dynamic entries:
/// - key / properties values 中 `${X.Y}` / `${X[N]}` 的 X 必须等于 child_var (delegate) 或 data_var (sql)
/// - dynamic SQL entry 不能含 `${data_var.provider}` 形态（运行期不支持）
/// - child_var / data_var 不能是 reserved identifier
pub fn validate_dynamic(
    ns: &Namespace,
    name: &SimpleName,
    def: &ProviderDef,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    let Some(list) = &def.list else {
        return;
    };
    let fqn = super::fqn(ns, name);

    for (key, entry) in &list.entries {
        let ListEntry::Dynamic(dyn_entry) = entry else {
            continue;
        };
        match dyn_entry {
            DynamicListEntry::Sql(e) => {
                check_reserved(&fqn, key, "data_var", &e.data_var.0, cfg, errors);
                check_template_var_prefix(
                    &fqn,
                    key,
                    "data_var",
                    &e.data_var.0,
                    key,
                    &format!("list[`{}`].key", key),
                    errors,
                );
                check_template_var_prefix(
                    &fqn,
                    key,
                    "data_var",
                    &e.data_var.0,
                    &e.sql.0,
                    &format!("list[`{}`].sql", key),
                    errors,
                );
                check_no_provider_ref(
                    &fqn,
                    &format!("list[`{}`].sql", key),
                    &e.sql.0,
                    &e.data_var.0,
                    errors,
                );
                if let Some(props) = &e.properties {
                    for (pk, pv) in props {
                        let s = template_value_as_str(pv);
                        check_template_var_prefix(
                            &fqn,
                            key,
                            "data_var",
                            &e.data_var.0,
                            &s,
                            &format!("list[`{}`].properties.{}", key, pk),
                            errors,
                        );
                        check_no_provider_ref(
                            &fqn,
                            &format!("list[`{}`].properties.{}", key, pk),
                            &s,
                            &e.data_var.0,
                            errors,
                        );
                    }
                }
            }
            DynamicListEntry::Delegate(e) => {
                check_reserved(&fqn, key, "child_var", &e.child_var.0, cfg, errors);
                check_template_var_prefix(
                    &fqn,
                    key,
                    "child_var",
                    &e.child_var.0,
                    key,
                    &format!("list[`{}`].key", key),
                    errors,
                );
                if let Some(props) = &e.properties {
                    for (pk, pv) in props {
                        let s = template_value_as_str(pv);
                        check_template_var_prefix(
                            &fqn,
                            key,
                            "child_var",
                            &e.child_var.0,
                            &s,
                            &format!("list[`{}`].properties.{}", key, pk),
                            errors,
                        );
                    }
                }
            }
        }
    }
}

fn template_value_as_str(v: &crate::ast::TemplateValue) -> String {
    match v {
        crate::ast::TemplateValue::String(s) => s.clone(),
        crate::ast::TemplateValue::Number(n) => n.to_string(),
        crate::ast::TemplateValue::Boolean(b) => b.to_string(),
    }
}

/// `${X.Y...}` 中, 当 X 不是 reserved namespace (properties/capture/composed/out/_/ref/<binding>)
/// 也不等于 expected_binding 时, 报 DynamicVarMismatch.
///
/// 允许的 namespace: properties, capture, composed, ref(method), out, _, expected_binding
fn check_template_var_prefix(
    fqn: &str,
    _key: &str,
    var_kind: &'static str,
    expected_binding: &str,
    text: &str,
    field_path: &str,
    errors: &mut Vec<ValidateError>,
) {
    let Ok(ast) = parse(text) else {
        return;
    };
    for seg in ast.segments {
        let Segment::Var(v) = seg else { continue };
        let prefix = match &v {
            VarRef::Method { .. } => continue, // method calls aren't bindings
            VarRef::Bare { ns } => ns,
            VarRef::Path { ns, .. } => ns,
            VarRef::Index { ns, .. } => ns,
        };
        if is_reserved_template_ns(prefix) || prefix == expected_binding {
            continue;
        }
        // also accept references that look like other bindings? No — only the expected one.
        errors.push(ValidateError::new(
            fqn,
            field_path,
            ValidateErrorKind::DynamicVarMismatch(
                prefix.clone(),
                var_kind,
                expected_binding.to_string(),
            ),
        ));
    }
}

/// 引擎自身永远在作用域内的 namespace (与用户 binding 无关)。
fn is_reserved_template_ns(ns: &str) -> bool {
    matches!(ns, "properties" | "capture" | "composed" | "_")
}

fn check_no_provider_ref(
    fqn: &str,
    field_path: &str,
    text: &str,
    data_var: &str,
    errors: &mut Vec<ValidateError>,
) {
    let Ok(ast) = parse(text) else {
        return;
    };
    for seg in ast.segments {
        let Segment::Var(VarRef::Path { ns, path }) = seg else {
            continue;
        };
        if ns == data_var && path.first().map(|s| s.as_str()) == Some("provider") {
            errors.push(ValidateError::new(
                fqn,
                field_path,
                ValidateErrorKind::DynamicSqlProviderRef,
            ));
        }
    }
}

fn check_reserved(
    fqn: &str,
    _key: &str,
    var_kind: &'static str,
    binding: &str,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    if cfg.reserved_idents.contains(binding) {
        errors.push(ValidateError::new(
            fqn,
            format!("list[*].{}", var_kind),
            ValidateErrorKind::ReservedIdent(binding.to_string()),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        DynamicDelegateEntry, DynamicSqlEntry, Identifier, List, PathExpr, ProviderName, SqlExpr,
    };
    use std::collections::HashMap;

    fn def_with_list(list: List) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list: Some(list),
            resolve: None,
            note: None,
        }
    }

    fn run(list: List) -> Vec<ValidateError> {
        let cfg = ValidateConfig::with_default_reserved();
        let mut errs = Vec::new();
        let d = def_with_list(list);
        validate_dynamic(
            &Namespace(String::new()),
            &SimpleName("p".into()),
            &d,
            &cfg,
            &mut errs,
        );
        errs
    }

    #[test]
    fn var_match_data_var() {
        let list = List {
            entries: vec![(
                "${row.id}".into(),
                ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                    sql: SqlExpr("SELECT id FROM x".into()),
                    data_var: Identifier("row".into()),
                    provider: None,
                    properties: None,
                    meta: None,
                })),
            )],
        };
        assert!(run(list).is_empty());
    }

    #[test]
    fn var_mismatch_when_prefix_neither_reserved_nor_binding() {
        let list = List {
            entries: vec![(
                "${other.id}".into(),
                ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                    sql: SqlExpr("SELECT id".into()),
                    data_var: Identifier("row".into()),
                    provider: None,
                    properties: None,
                    meta: None,
                })),
            )],
        };
        let errs = run(list);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::DynamicVarMismatch(_, _, _))));
    }

    #[test]
    fn var_match_via_binding_name() {
        // `out` is the binding (data_var) — `${out.id}` resolves to that binding
        let list = List {
            entries: vec![(
                "${out.id}".into(),
                ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                    sql: SqlExpr("SELECT id".into()),
                    data_var: Identifier("out".into()),
                    provider: None,
                    properties: None,
                    meta: None,
                })),
            )],
        };
        assert!(run(list).is_empty());
    }

    #[test]
    fn delegate_var_match() {
        let mut props = HashMap::new();
        props.insert(
            "k".to_string(),
            crate::ast::TemplateValue::String("${out.meta.x}".into()),
        );
        let list = List {
            entries: vec![(
                "${out.name}".into(),
                ListEntry::Dynamic(DynamicListEntry::Delegate(DynamicDelegateEntry {
                    delegate: PathExpr("./x".into()),
                    child_var: Identifier("out".into()),
                    provider: None,
                    properties: Some(props),
                    meta: None,
                })),
            )],
        };
        assert!(run(list).is_empty());
    }

    #[test]
    fn sql_provider_ref_rejected() {
        let mut props = HashMap::new();
        props.insert(
            "k".to_string(),
            crate::ast::TemplateValue::String("${row.provider}".into()),
        );
        let list = List {
            entries: vec![(
                "${row.id}".into(),
                ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                    sql: SqlExpr("SELECT id".into()),
                    data_var: Identifier("row".into()),
                    provider: Some(ProviderName("foo".into())),
                    properties: Some(props),
                    meta: None,
                })),
            )],
        };
        let errs = run(list);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::DynamicSqlProviderRef)));
    }

    #[test]
    fn reserved_data_var_rejected() {
        let list = List {
            entries: vec![(
                "${composed.x}".into(),
                ListEntry::Dynamic(DynamicListEntry::Sql(DynamicSqlEntry {
                    sql: SqlExpr("SELECT 1".into()),
                    data_var: Identifier("ref".into()), // reserved
                    provider: None,
                    properties: None,
                    meta: None,
                })),
            )],
        };
        let errs = run(list);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::ReservedIdent(_))));
    }

    #[test]
    fn reserved_child_var_rejected() {
        let list = List {
            entries: vec![(
                "${out.name}".into(),
                ListEntry::Dynamic(DynamicListEntry::Delegate(DynamicDelegateEntry {
                    delegate: PathExpr("./x".into()),
                    child_var: Identifier("properties".into()), // reserved
                    provider: None,
                    properties: None,
                    meta: None,
                })),
            )],
        };
        let errs = run(list);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::ReservedIdent(_))));
    }

    #[test]
    fn properties_ns_allowed_in_dynamic() {
        let mut props = HashMap::new();
        props.insert(
            "k".into(),
            crate::ast::TemplateValue::String("${properties.page_size}".into()),
        );
        let list = List {
            entries: vec![(
                "${out.meta.page_num}".into(),
                ListEntry::Dynamic(DynamicListEntry::Delegate(DynamicDelegateEntry {
                    delegate: PathExpr("./__provider".into()),
                    child_var: Identifier("out".into()),
                    provider: None,
                    properties: Some(props),
                    meta: None,
                })),
            )],
        };
        assert!(run(list).is_empty());
    }
}
