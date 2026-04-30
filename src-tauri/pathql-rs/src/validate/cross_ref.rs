#![allow(unused_imports)]

use crate::ast::{
    DelegateProviderField, DynamicListEntry, ListEntry, Namespace, ProviderDef, ProviderInvocation,
    ProviderName, Query, SimpleName,
};
use crate::validate::{ValidateConfig, ValidateError, ValidateErrorKind};

pub fn validate_cross_refs(
    registry: &crate::ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    if !cfg.enforce_cross_refs {
        return;
    }
    for ((ns, name), def) in registry.iter_dsl() {
        let fqn = super::fqn(ns, name);
        for (field, refer) in collect_refs(def) {
            if registry.resolve(ns, &refer).is_none() {
                errors.push(ValidateError::new(
                    &fqn,
                    field,
                    ValidateErrorKind::UnresolvedProviderRef(refer.0.clone(), ns.0.clone()),
                ));
            }
        }
    }
}

fn collect_refs(def: &ProviderDef) -> Vec<(String, ProviderName)> {
    let mut refs: Vec<(String, ProviderName)> = Vec::new();

    // 6e: query.delegate 现在是 ProviderCall, 直接收集名字。
    if let Some(Query::Delegate(d)) = &def.query {
        refs.push((
            "query.delegate.provider".into(),
            d.delegate.provider.clone(),
        ));
    }

    if let Some(list) = &def.list {
        for (key, entry) in &list.entries {
            match entry {
                ListEntry::Static(ProviderInvocation::ByName(b)) => {
                    refs.push((format!("list[`{}`].provider", key), b.provider.clone()));
                }
                ListEntry::Dynamic(DynamicListEntry::Sql(e)) => {
                    if let Some(p) = &e.provider {
                        refs.push((format!("list[`{}`].provider", key), p.clone()));
                    }
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                    // 6e: delegate.provider 是数据源 ProviderCall
                    refs.push((
                        format!("list[`{}`].delegate.provider", key),
                        e.delegate.provider.clone(),
                    ));
                    // 输出层 provider hint (Name 形态收集; ChildRef 跳过)
                    if let Some(DelegateProviderField::Name(n)) = &e.provider {
                        refs.push((format!("list[`{}`].provider", key), n.clone()));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(resolve) = &def.resolve {
        for (k, inv) in &resolve.0 {
            match inv {
                ProviderInvocation::ByName(b) => {
                    refs.push((format!("resolve[`{}`].provider", k), b.provider.clone()));
                }
                // 7b: ByDelegate 也是跨 provider 引用
                ProviderInvocation::ByDelegate(b) => {
                    refs.push((
                        format!("resolve[`{}`].delegate.provider", k),
                        b.delegate.provider.clone(),
                    ));
                }
                ProviderInvocation::Empty(_) => {}
            }
        }
    }

    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{InvokeByName, List, ProviderInvocation};
    use crate::ProviderRegistry;

    fn def_with_ref(ns: Option<&str>, name: &str, ref_to: &str) -> ProviderDef {
        let list = List {
            entries: vec![(
                "k".into(),
                ListEntry::Static(ProviderInvocation::ByName(InvokeByName {
                    provider: ProviderName(ref_to.into()),
                    properties: None,
                    meta: None,
                })),
            )],
        };
        ProviderDef {
            schema: None,
            namespace: ns.map(|s| Namespace(s.into())),
            name: SimpleName(name.into()),
            properties: None,
            query: None,
            list: Some(list),
            resolve: None,
            note: None,
        }
    }

    fn def_named(ns: Option<&str>, name: &str) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: ns.map(|s| Namespace(s.into())),
            name: SimpleName(name.into()),
            properties: None,
            query: None,
            list: None,
            resolve: None,
            note: None,
        }
    }

    fn cfg_strict() -> ValidateConfig {
        ValidateConfig::with_default_reserved().with_cross_refs(true)
    }

    #[test]
    fn resolves_in_same_namespace() {
        let mut r = ProviderRegistry::new();
        r.register(def_named(Some("kabegame"), "foo")).unwrap();
        r.register(def_with_ref(Some("kabegame"), "bar", "foo"))
            .unwrap();
        let mut errs = Vec::new();
        validate_cross_refs(&r, &cfg_strict(), &mut errs);
        assert!(errs.is_empty());
    }

    #[test]
    fn resolves_via_parent_chain() {
        let mut r = ProviderRegistry::new();
        r.register(def_named(Some("kabegame"), "foo")).unwrap();
        r.register(def_with_ref(Some("kabegame.plugin.x"), "y", "foo"))
            .unwrap();
        let mut errs = Vec::new();
        validate_cross_refs(&r, &cfg_strict(), &mut errs);
        assert!(errs.is_empty());
    }

    #[test]
    fn unresolved_emits_error() {
        let mut r = ProviderRegistry::new();
        r.register(def_with_ref(Some("k"), "bar", "missing"))
            .unwrap();
        let mut errs = Vec::new();
        validate_cross_refs(&r, &cfg_strict(), &mut errs);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::UnresolvedProviderRef(_, _))));
    }

    #[test]
    fn enforce_off_skips_check() {
        let mut r = ProviderRegistry::new();
        r.register(def_with_ref(Some("k"), "bar", "missing"))
            .unwrap();
        let mut errs = Vec::new();
        // enforce_cross_refs default = false
        validate_cross_refs(&r, &ValidateConfig::with_default_reserved(), &mut errs);
        assert!(errs.is_empty());
    }

    #[test]
    fn query_delegate_provider_collected() {
        // 6e: query.delegate.provider 必须存在于 registry; 否则报 UnresolvedProviderRef
        use crate::ast::{DelegateQuery, ProviderCall};
        let d = ProviderDef {
            schema: None,
            namespace: Some(Namespace("k".into())),
            name: SimpleName("p".into()),
            properties: None,
            query: Some(Query::Delegate(DelegateQuery {
                delegate: ProviderCall {
                    provider: ProviderName("missing".into()),
                    properties: None,
                },
            })),
            list: None,
            resolve: None,
            note: None,
        };
        let mut r = ProviderRegistry::new();
        r.register(d).unwrap();
        let mut errs = Vec::new();
        validate_cross_refs(&r, &cfg_strict(), &mut errs);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::UnresolvedProviderRef(_, _))));
    }
}
