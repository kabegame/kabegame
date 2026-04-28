//! Delegate 环检测 (6e).
//!
//! 从每个 ProviderDef 出发, DFS 跟踪 delegate 边 (Query::Delegate +
//! DynamicDelegateEntry); 命中 back-edge 报 `DelegateCycle`。
//!
//! 仅在 `cfg.enforce_cross_refs` 启用时跑 — 部分注册的 registry 上跑环检测会
//! 误报 (引用未注册的 provider 不是环, 是 cross_ref 错误)。

use std::collections::HashSet;

use crate::ast::{DynamicListEntry, ListEntry, Namespace, ProviderDef, ProviderName, Query};
use crate::validate::{ValidateConfig, ValidateError, ValidateErrorKind};
use crate::ProviderRegistry;

pub fn check_delegate_cycles(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    if !cfg.enforce_cross_refs {
        return;
    }
    let mut already_reported: HashSet<String> = HashSet::new();
    for ((ns, name), def) in registry.iter_dsl() {
        let mut visited = HashSet::new();
        let mut stack: Vec<String> = Vec::new();
        if let Some(cycle) = dfs_delegate(def, ns, registry, &mut visited, &mut stack) {
            // 用环上的字典序最小元素作 dedup key, 避免同一环从不同起点都报一次。
            let key = cycle.iter().min().cloned().unwrap_or_default();
            if already_reported.insert(key) {
                let fqn = super::fqn(ns, name);
                errors.push(ValidateError::new(
                    fqn,
                    "delegate".to_string(),
                    ValidateErrorKind::DelegateCycle(cycle),
                ));
            }
        }
    }
}

fn fqn_of(ns: &Namespace, name: &str) -> String {
    if ns.0.is_empty() {
        name.to_string()
    } else {
        format!("{}.{}", ns.0, name)
    }
}

fn dfs_delegate(
    def: &ProviderDef,
    current_ns: &Namespace,
    registry: &ProviderRegistry,
    visited: &mut HashSet<String>,
    stack: &mut Vec<String>,
) -> Option<Vec<String>> {
    let key = fqn_of(current_ns, &def.name.0);
    if let Some(pos) = stack.iter().position(|s| s == &key) {
        // 命中环: 返回 stack[pos..] + key 闭环
        let mut chain: Vec<String> = stack[pos..].to_vec();
        chain.push(key);
        return Some(chain);
    }
    if visited.contains(&key) {
        return None;
    }
    visited.insert(key.clone());
    stack.push(key.clone());

    let target_names: Vec<&ProviderName> = collect_delegate_targets(def);
    for target in target_names {
        if let Some(target_def) = registry.resolve(current_ns, target) {
            // 用 target_def 的 namespace 作下一步 ns (resolve 链已找到具体定义)
            let next_ns = target_def.namespace.clone().unwrap_or_else(|| Namespace(String::new()));
            if let Some(c) = dfs_delegate(&target_def, &next_ns, registry, visited, stack) {
                return Some(c);
            }
        }
    }

    stack.pop();
    None
}

fn collect_delegate_targets(def: &ProviderDef) -> Vec<&ProviderName> {
    let mut out: Vec<&ProviderName> = Vec::new();
    if let Some(Query::Delegate(d)) = &def.query {
        out.push(&d.delegate.provider);
    }
    if let Some(list) = &def.list {
        for (_, entry) in &list.entries {
            if let ListEntry::Dynamic(DynamicListEntry::Delegate(d)) = entry {
                out.push(&d.delegate.provider);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        DelegateQuery, DynamicDelegateEntry, DynamicListEntry, Identifier, List, ProviderCall,
        ProviderName, SimpleName,
    };

    fn cfg_strict() -> ValidateConfig {
        ValidateConfig::with_default_reserved().with_cross_refs(true)
    }

    fn def_query_delegate(ns: &str, name: &str, target: &str) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: Some(Namespace(ns.into())),
            name: SimpleName(name.into()),
            properties: None,
            query: Some(Query::Delegate(DelegateQuery {
                delegate: ProviderCall {
                    provider: ProviderName(target.into()),
                    properties: None,
                },
            })),
            list: None,
            resolve: None,
            note: None,
        }
    }

    fn def_dynamic_delegate(ns: &str, name: &str, target: &str) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: Some(Namespace(ns.into())),
            name: SimpleName(name.into()),
            properties: None,
            query: None,
            list: Some(List {
                entries: vec![(
                    "${out.id}".into(),
                    ListEntry::Dynamic(DynamicListEntry::Delegate(DynamicDelegateEntry {
                        delegate: ProviderCall {
                            provider: ProviderName(target.into()),
                            properties: None,
                        },
                        child_var: Identifier("out".into()),
                        provider: None,
                        properties: None,
                        meta: None,
                    })),
                )],
            }),
            resolve: None,
            note: None,
        }
    }

    fn def_named(ns: &str, name: &str) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: Some(Namespace(ns.into())),
            name: SimpleName(name.into()),
            properties: None,
            query: None,
            list: None,
            resolve: None,
            note: None,
        }
    }

    #[test]
    fn no_cycles_clean() {
        let mut r = ProviderRegistry::new();
        r.register(def_named("k", "leaf")).unwrap();
        r.register(def_query_delegate("k", "router", "leaf")).unwrap();
        let mut errs = Vec::new();
        check_delegate_cycles(&r, &cfg_strict(), &mut errs);
        assert!(errs.is_empty());
    }

    #[test]
    fn self_cycle_detected() {
        let mut r = ProviderRegistry::new();
        r.register(def_query_delegate("k", "loopy", "loopy")).unwrap();
        let mut errs = Vec::new();
        check_delegate_cycles(&r, &cfg_strict(), &mut errs);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::DelegateCycle(_))));
    }

    #[test]
    fn two_node_cycle_detected() {
        let mut r = ProviderRegistry::new();
        r.register(def_query_delegate("k", "a", "b")).unwrap();
        r.register(def_query_delegate("k", "b", "a")).unwrap();
        let mut errs = Vec::new();
        check_delegate_cycles(&r, &cfg_strict(), &mut errs);
        assert_eq!(
            errs.iter()
                .filter(|e| matches!(e.kind, ValidateErrorKind::DelegateCycle(_)))
                .count(),
            1,
            "two-node cycle should report exactly once after dedup"
        );
    }

    #[test]
    fn dynamic_delegate_cycle_detected() {
        let mut r = ProviderRegistry::new();
        r.register(def_dynamic_delegate("k", "a", "b")).unwrap();
        r.register(def_query_delegate("k", "b", "a")).unwrap();
        let mut errs = Vec::new();
        check_delegate_cycles(&r, &cfg_strict(), &mut errs);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::DelegateCycle(_))));
    }

    #[test]
    fn cross_ref_off_skips_check() {
        let mut r = ProviderRegistry::new();
        r.register(def_query_delegate("k", "loopy", "loopy")).unwrap();
        let mut errs = Vec::new();
        // enforce_cross_refs default = false
        check_delegate_cycles(&r, &ValidateConfig::with_default_reserved(), &mut errs);
        assert!(errs.is_empty());
    }
}
