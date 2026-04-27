use crate::ast::{Namespace, ProviderDef, SimpleName};
use crate::validate::{ValidateError, ValidateErrorKind};

/// 校验 namespace / name 字符模式。
///
/// - `name`：`^[A-Za-z_][A-Za-z0-9_]*$`（兼容 `vd_zh_CN_root_router` 等 i18n 路由名）
/// - `namespace`：dot-separated 段，每段同 name 规则；空串 (root namespace) 合法
pub fn validate_names(
    ns: &Namespace,
    name: &SimpleName,
    _def: &ProviderDef,
    errors: &mut Vec<ValidateError>,
) {
    let fqn = super::fqn(ns, name);

    if !is_valid_simple_name(&name.0) {
        errors.push(ValidateError::new(
            &fqn,
            "name",
            ValidateErrorKind::InvalidName(name.0.clone()),
        ));
    }
    if !is_valid_namespace(&ns.0) {
        errors.push(ValidateError::new(
            &fqn,
            "namespace",
            ValidateErrorKind::InvalidNamespace(ns.0.clone()),
        ));
    }
}

pub(crate) fn is_valid_simple_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        None => return false,
        Some(c) if !is_ident_start(c) => return false,
        Some(_) => {}
    }
    chars.all(is_ident_cont)
}

pub(crate) fn is_valid_namespace(s: &str) -> bool {
    if s.is_empty() {
        return true; // root namespace
    }
    s.split('.').all(is_valid_simple_name)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_cont(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName(name.into()),
            properties: None,
            query: None,
            list: None,
            resolve: None,
            note: None,
        }
    }

    fn run(ns: &str, name: &str) -> Vec<ValidateError> {
        let mut errors = Vec::new();
        validate_names(
            &Namespace(ns.into()),
            &SimpleName(name.into()),
            &def(name),
            &mut errors,
        );
        errors
    }

    #[test]
    fn valid_simple_name() {
        assert!(run("k", "foo_bar").is_empty());
    }

    #[test]
    fn valid_name_with_caps() {
        // matches real data: vd_zh_CN_root_router
        assert!(run("kabegame", "vd_zh_CN_root_router").is_empty());
    }

    #[test]
    fn bad_starts_with_digit() {
        let errs = run("k", "1foo");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidName(_)
        ));
    }

    #[test]
    fn bad_name_with_hyphen() {
        let errs = run("k", "foo-bar");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidName(_)
        ));
    }

    #[test]
    fn bad_empty_name() {
        let errs = run("k", "");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidName(_)
        ));
    }

    #[test]
    fn valid_namespace_simple() {
        assert!(run("kabegame", "n").is_empty());
    }

    #[test]
    fn valid_namespace_dotted() {
        assert!(run("kabegame.plugin.x", "n").is_empty());
    }

    #[test]
    fn valid_namespace_root_empty() {
        assert!(run("", "n").is_empty());
    }

    #[test]
    fn bad_namespace_dotstart() {
        let errs = run(".kabegame", "n");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidNamespace(_)
        ));
    }

    #[test]
    fn bad_namespace_double_dot() {
        let errs = run("kabegame..plugin", "n");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidNamespace(_)
        ));
    }

    #[test]
    fn bad_namespace_segment_with_hyphen() {
        let errs = run("kabegame.bad-seg", "n");
        assert!(matches!(
            errs[0].kind,
            ValidateErrorKind::InvalidNamespace(_)
        ));
    }
}
