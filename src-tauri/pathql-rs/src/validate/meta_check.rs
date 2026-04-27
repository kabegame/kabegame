use crate::ast::{
    DynamicListEntry, ListEntry, ProviderInvocation, SqlExpr,
};
use crate::template::{parse, validate_scope};
use crate::validate::{
    sql::validate_full_sql, ValidateConfig, ValidateError, ValidateErrorKind,
};

/// Meta 字段递归校验。
///
/// 字符串值的启发式：
/// - 含 SQL 关键字 (SELECT/UPDATE/...) → 走 SQL validator
/// - 含 `${...}` → 走模板 scope validator (按所在 invocation 形态确定 allowed scope)
/// - 否则当作字面无校验
pub fn validate_meta(
    registry: &crate::ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter_dsl() {
        let fqn = super::fqn(ns, name);

        // collect (location, allowed_ns, allowed_methods, meta value)
        if let Some(list) = &def.list {
            for (key, entry) in &list.entries {
                let (allowed_ns, allowed_methods, meta_opt) = match entry {
                    ListEntry::Static(inv) => {
                        let m = invocation_meta(inv);
                        (
                            vec!["properties", "capture", "composed", "_"],
                            vec!["ref"],
                            m,
                        )
                    }
                    ListEntry::Dynamic(DynamicListEntry::Sql(e)) => (
                        vec![
                            "properties",
                            "capture",
                            "composed",
                            "_",
                            e.data_var.0.as_str(),
                        ],
                        vec!["ref"],
                        e.meta.as_ref(),
                    ),
                    ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => (
                        vec![
                            "properties",
                            "capture",
                            "composed",
                            "_",
                            e.child_var.0.as_str(),
                        ],
                        vec!["ref"],
                        e.meta.as_ref(),
                    ),
                };
                let location = format!("list[`{}`]", key);
                if let Some(m) = meta_opt {
                    walk_meta(
                        m,
                        &format!("{}.meta", location),
                        &fqn,
                        cfg,
                        &allowed_ns,
                        &allowed_methods,
                        errors,
                    );
                }
            }
        }

        if let Some(resolve) = &def.resolve {
            for (k, inv) in &resolve.0 {
                let allowed_ns = vec!["properties", "capture", "composed", "_"];
                let allowed_methods = vec!["ref"];
                let location = format!("resolve[`{}`]", k);
                if let Some(m) = invocation_meta(inv) {
                    walk_meta(
                        m,
                        &format!("{}.meta", location),
                        &fqn,
                        cfg,
                        &allowed_ns,
                        &allowed_methods,
                        errors,
                    );
                }
            }
        }
    }
}

fn invocation_meta(inv: &ProviderInvocation) -> Option<&serde_json::Value> {
    match inv {
        ProviderInvocation::ByName(b) => b.meta.as_ref(),
        ProviderInvocation::ByDelegate(b) => b.meta.as_ref(),
        ProviderInvocation::Empty(b) => b.meta.as_ref(),
    }
}

fn walk_meta(
    v: &serde_json::Value,
    field_path: &str,
    fqn: &str,
    cfg: &ValidateConfig,
    allowed_ns: &[&str],
    allowed_methods: &[&str],
    errors: &mut Vec<ValidateError>,
) {
    match v {
        serde_json::Value::String(s) => {
            if looks_like_sql(s) {
                validate_full_sql(fqn, field_path, &SqlExpr(s.clone()), cfg, errors);
            } else if s.contains("${") {
                match parse(s) {
                    Ok(ast) => {
                        if let Err(e) = validate_scope(&ast, allowed_ns, allowed_methods) {
                            errors.push(ValidateError::new(
                                fqn,
                                field_path,
                                ValidateErrorKind::TemplateScope(e),
                            ));
                        }
                    }
                    Err(e) => {
                        errors.push(ValidateError::new(
                            fqn,
                            field_path,
                            ValidateErrorKind::TemplateParse(e),
                        ));
                    }
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (k, child) in map {
                walk_meta(
                    child,
                    &format!("{}.{}", field_path, k),
                    fqn,
                    cfg,
                    allowed_ns,
                    allowed_methods,
                    errors,
                );
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, child) in arr.iter().enumerate() {
                walk_meta(
                    child,
                    &format!("{}[{}]", field_path, i),
                    fqn,
                    cfg,
                    allowed_ns,
                    allowed_methods,
                    errors,
                );
            }
        }
        _ => {}
    }
}

fn looks_like_sql(s: &str) -> bool {
    let upper = s.to_uppercase();
    let trimmed = upper.trim_start();
    // strict heuristic: must START with a SQL verb
    for prefix in &["SELECT ", "INSERT ", "UPDATE ", "DELETE ", "WITH ", "DROP ", "CREATE ", "ALTER ", "TRUNCATE "] {
        if trimmed.starts_with(prefix) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        InvokeByName, List, ListEntry, Namespace, ProviderDef, ProviderInvocation, ProviderName,
        Resolve, SimpleName,
    };
    use crate::ProviderRegistry;
    use serde_json::json;

    fn def_with_static_meta(meta: serde_json::Value) -> ProviderDef {
        let list = List {
            entries: vec![(
                "k".into(),
                ListEntry::Static(ProviderInvocation::ByName(InvokeByName {
                    provider: ProviderName("p".into()),
                    properties: None,
                    meta: Some(meta),
                })),
            )],
        };
        ProviderDef {
            schema: None,
            namespace: Some(Namespace("k".into())),
            name: SimpleName("provider".into()),
            properties: None,
            query: None,
            list: Some(list),
            resolve: None,
            note: None,
        }
    }

    fn run_static(meta: serde_json::Value) -> Vec<ValidateError> {
        let mut reg = ProviderRegistry::new();
        reg.register(def_with_static_meta(meta)).unwrap();
        let mut errs = Vec::new();
        let cfg = ValidateConfig::with_default_reserved();
        validate_meta(&reg, &cfg, &mut errs);
        errs
    }

    #[test]
    fn meta_sql_string_clean() {
        let errs = run_static(json!("SELECT * FROM albums WHERE id = ${capture[1]}"));
        assert!(errs.is_empty());
    }

    #[test]
    fn meta_template_only_clean() {
        let errs = run_static(json!("${properties.id}"));
        assert!(errs.is_empty());
    }

    #[test]
    fn meta_object_recurse() {
        let errs = run_static(json!({"id": "${properties.id}", "k": "v"}));
        assert!(errs.is_empty());
    }

    #[test]
    fn meta_array_recurse() {
        let errs = run_static(json!(["${capture[1]}", "literal"]));
        assert!(errs.is_empty());
    }

    #[test]
    fn meta_scalar_skip() {
        let errs = run_static(json!({"count": 42, "ok": true}));
        assert!(errs.is_empty());
    }

    #[test]
    fn meta_bad_sql_rejected() {
        let errs = run_static(json!("DROP TABLE images"));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlDdlNotAllowed(_))));
    }

    #[test]
    fn meta_bad_scope_rejected() {
        let errs = run_static(json!("${unknown_ns.x}"));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::TemplateScope(_))));
    }

    #[test]
    fn meta_bad_template_parse() {
        let errs = run_static(json!("${unclosed"));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::TemplateParse(_))));
    }

    #[test]
    fn meta_resolve_with_capture() {
        // resolve invocation meta uses capture as allowed scope
        let mut resolve = Resolve::default();
        resolve.0.insert(
            "x([0-9]+)x".into(),
            ProviderInvocation::ByName(InvokeByName {
                provider: ProviderName("p".into()),
                properties: None,
                meta: Some(json!({"page": "${capture[1]}"})),
            }),
        );
        let d = ProviderDef {
            schema: None,
            namespace: Some(Namespace("k".into())),
            name: SimpleName("provider".into()),
            properties: None,
            query: None,
            list: None,
            resolve: Some(resolve),
            note: None,
        };
        let mut reg = ProviderRegistry::new();
        reg.register(d).unwrap();
        let mut errs = Vec::new();
        let cfg = ValidateConfig::with_default_reserved();
        validate_meta(&reg, &cfg, &mut errs);
        assert!(errs.is_empty());
    }
}
