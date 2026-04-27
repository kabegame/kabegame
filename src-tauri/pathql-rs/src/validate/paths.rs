use crate::ast::{
    DynamicListEntry, ListEntry, Namespace, PathExpr, ProviderDef, ProviderInvocation, Query,
    SimpleName,
};
use crate::validate::{ValidateError, ValidateErrorKind};

/// 校验 PathExpr 字面：必须以 `./` 开头, 且不含 `..` 段。
pub fn validate_path_exprs(
    ns: &Namespace,
    name: &SimpleName,
    def: &ProviderDef,
    errors: &mut Vec<ValidateError>,
) {
    let fqn = super::fqn(ns, name);

    if let Some(Query::Delegate(d)) = &def.query {
        check_one(&fqn, "query.delegate", &d.delegate, errors);
    }
    if let Some(list) = &def.list {
        for (key, entry) in &list.entries {
            match entry {
                ListEntry::Static(ProviderInvocation::ByDelegate(b)) => {
                    check_one(
                        &fqn,
                        &format!("list[`{}`].delegate", key),
                        &b.delegate,
                        errors,
                    );
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(b)) => {
                    check_one(
                        &fqn,
                        &format!("list[`{}`].delegate", key),
                        &b.delegate,
                        errors,
                    );
                }
                _ => {}
            }
        }
    }
    if let Some(resolve) = &def.resolve {
        for (k, inv) in resolve.0.iter() {
            if let ProviderInvocation::ByDelegate(b) = inv {
                check_one(
                    &fqn,
                    &format!("resolve[`{}`].delegate", k),
                    &b.delegate,
                    errors,
                );
            }
        }
    }
}

fn check_one(fqn: &str, field: &str, p: &PathExpr, errors: &mut Vec<ValidateError>) {
    if !is_valid_path(&p.0) {
        errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::InvalidPathExpr,
        ));
    }
}

fn is_valid_path(s: &str) -> bool {
    if !s.starts_with("./") {
        return false;
    }
    // forbid ".." segments
    !s.split('/').any(|seg| seg == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{InvokeByDelegate, List, ProviderInvocation};

    fn run_with_resolve(p: &str) -> Vec<ValidateError> {
        let mut resolve = crate::ast::Resolve::default();
        resolve.0.insert(
            "k".to_string(),
            ProviderInvocation::ByDelegate(InvokeByDelegate {
                delegate: PathExpr(p.into()),
                properties: None,
                meta: None,
            }),
        );
        let d = ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list: None,
            resolve: Some(resolve),
            note: None,
        };
        let mut errs = Vec::new();
        validate_path_exprs(&Namespace(String::new()), &SimpleName("p".into()), &d, &mut errs);
        errs
    }

    fn run_with_list_delegate(p: &str) -> Vec<ValidateError> {
        let list = List {
            entries: vec![(
                "k".into(),
                ListEntry::Static(ProviderInvocation::ByDelegate(InvokeByDelegate {
                    delegate: PathExpr(p.into()),
                    properties: None,
                    meta: None,
                })),
            )],
        };
        let d = ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list: Some(list),
            resolve: None,
            note: None,
        };
        let mut errs = Vec::new();
        validate_path_exprs(&Namespace(String::new()), &SimpleName("p".into()), &d, &mut errs);
        errs
    }

    #[test]
    fn valid_path() {
        assert!(run_with_resolve("./foo/bar").is_empty());
    }

    #[test]
    fn valid_path_with_underscore_internal() {
        assert!(run_with_resolve("./__provider").is_empty());
    }

    #[test]
    fn parent_segment_rejected() {
        let errs = run_with_resolve("./../foo");
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::InvalidPathExpr)));
    }

    #[test]
    fn no_dot_slash_prefix_rejected() {
        let errs = run_with_resolve("foo/bar");
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::InvalidPathExpr)));
    }

    #[test]
    fn absolute_path_rejected() {
        let errs = run_with_resolve("/foo");
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::InvalidPathExpr)));
    }

    #[test]
    fn list_delegate_path_validated() {
        let errs = run_with_list_delegate("/oops");
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::InvalidPathExpr)));
    }

    #[test]
    fn list_delegate_path_ok() {
        assert!(run_with_list_delegate("./x100x/1/").is_empty());
    }
}
