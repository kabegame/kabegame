use crate::ast::{DynamicListEntry, ListEntry, Namespace, ProviderDef, SimpleName};
use crate::validate::{ValidateError, ValidateErrorKind};
use std::collections::HashMap;

/// 校验 codegen alias：格式为 snake_case，且同一 provider 内不可重复。
pub fn validate_aliases(
    ns: &Namespace,
    name: &SimpleName,
    def: &ProviderDef,
    errors: &mut Vec<ValidateError>,
) {
    let fqn = super::fqn(ns, name);
    let mut aliases = Vec::new();

    if let Some(resolve) = &def.resolve {
        let mut entries: Vec<_> = resolve.0.iter().collect();
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (pattern, entry) in entries {
            if let Some(alias) = &entry.alias {
                aliases.push((alias, format!("resolve[`{}`].alias", pattern)));
            }
        }
    }

    if let Some(list) = &def.list {
        for (key, entry) in &list.entries {
            let alias = match entry {
                ListEntry::Dynamic(DynamicListEntry::Sql(entry)) => entry.alias.as_ref(),
                ListEntry::Dynamic(DynamicListEntry::Delegate(entry)) => entry.alias.as_ref(),
                ListEntry::Static(_) => None,
            };
            if let Some(alias) = alias {
                aliases.push((alias, format!("list[`{}`].alias", key)));
            }
        }
    }

    let mut seen = HashMap::new();
    for (alias, field) in aliases {
        if !is_valid_alias(alias) {
            errors.push(ValidateError::new(
                &fqn,
                &field,
                ValidateErrorKind::InvalidAlias(alias.clone()),
            ));
        }
        if seen.insert(alias.clone(), field.clone()).is_some() {
            errors.push(ValidateError::new(
                &fqn,
                field,
                ValidateErrorKind::DuplicateAlias(alias.clone()),
            ));
        }
    }
}

fn is_valid_alias(alias: &str) -> bool {
    let mut chars = alias.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::ProviderDef;
    use crate::validate::{validate, ValidateConfig};
    use crate::ProviderRegistry;

    fn run(raw: &str) -> Vec<ValidateError> {
        let def: ProviderDef = serde_json::from_str(raw).unwrap();
        let mut registry = ProviderRegistry::new();
        registry.register(def).unwrap();
        match validate(&registry, &ValidateConfig::with_default_reserved()) {
            Ok(()) => Vec::new(),
            Err(errors) => errors,
        }
    }

    #[test]
    fn legal_aliases_across_all_dynamic_entry_kinds() {
        let errors = run(r#"{
                "name": "root",
                "resolve": { "x": { "provider": "target", "alias": "page_size" } },
                "list": {
                    "${row.id}": { "sql": "select 1", "data_var": "row", "alias": "plugin" },
                    "${child.name}": {
                        "delegate": { "provider": "children" },
                        "child_var": "child",
                        "alias": "album_entry_2"
                    }
                }
            }"#);
        assert!(errors.is_empty());
    }

    #[test]
    fn invalid_alias_formats_are_rejected() {
        for alias in ["Page_size", "1page", "pageSize"] {
            let raw = format!(
                r#"{{"name":"root","resolve":{{"x":{{"provider":"target","alias":"{}"}}}}}}"#,
                alias
            );
            let errors = run(&raw);
            assert!(errors
                .iter()
                .any(|error| matches!(error.kind, ValidateErrorKind::InvalidAlias(_))));
        }
    }

    #[test]
    fn duplicate_alias_across_resolve_and_dynamic_list_is_rejected() {
        let errors = run(r#"{
                "name": "root",
                "resolve": { "x": { "provider": "target", "alias": "entry" } },
                "list": {
                    "${row.id}": { "sql": "select 1", "data_var": "row", "alias": "entry" }
                }
            }"#);
        assert!(errors
            .iter()
            .any(|error| matches!(error.kind, ValidateErrorKind::DuplicateAlias(_))));
    }

    #[test]
    fn missing_alias_remains_valid() {
        let errors = run(r#"{
                "name": "root",
                "resolve": { "x": { "provider": "target" } },
                "list": {
                    "${row.id}": { "sql": "select 1", "data_var": "row" }
                }
            }"#);
        assert!(errors.is_empty());
    }
}
