use crate::ast::{Namespace, ProviderDef, ProviderName, SimpleName};
use crate::provider::{DslProvider, EngineError, Provider, ProviderContext};
use crate::template::eval::TemplateValue;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("duplicate provider: {0:?}.{1:?}")]
    Duplicate(Namespace, SimpleName),
}

/// 工厂回调: 接受实例化属性表, 构造 Provider 实例。
///
/// **不带 ctx 参数**——provider 实例不持 runtime/registry 字段, 构造时无需它们;
/// 方法调用时由 runtime 通过 ctx 注入。
pub type ProviderFactory = Arc<
    dyn Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
        + Send
        + Sync
        + 'static,
>;

pub enum RegistryEntry {
    Dsl(Arc<ProviderDef>),
    Programmatic(ProviderFactory),
}

impl std::fmt::Debug for RegistryEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryEntry::Dsl(d) => f.debug_tuple("Dsl").field(d).finish(),
            RegistryEntry::Programmatic(_) => {
                f.debug_tuple("Programmatic").field(&"<factory>").finish()
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct ProviderRegistry {
    defs: HashMap<(Namespace, SimpleName), RegistryEntry>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册 DSL provider def。
    pub fn register(&mut self, def: ProviderDef) -> Result<(), RegistryError> {
        let ns = def
            .namespace
            .clone()
            .unwrap_or_else(|| Namespace(String::new()));
        let key = (ns.clone(), def.name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(key.0, key.1));
        }
        self.defs.insert(key, RegistryEntry::Dsl(Arc::new(def)));
        Ok(())
    }

    /// 注册编程 provider (RULES §12.3): factory 接收 properties, 返回 Provider 实例。
    pub fn register_provider<F>(
        &mut self,
        namespace: Namespace,
        name: SimpleName,
        factory: F,
    ) -> Result<(), RegistryError>
    where
        F: Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
            + Send
            + Sync
            + 'static,
    {
        let key = (namespace.clone(), name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(namespace, name));
        }
        self.defs
            .insert(key, RegistryEntry::Programmatic(Arc::new(factory)));
        Ok(())
    }

    /// Java 包风格父链查找。
    pub fn lookup(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
    ) -> Option<&RegistryEntry> {
        let (ref_ns, simple) = reference.split();
        if let Some(abs_ns) = ref_ns {
            return self.defs.get(&(abs_ns, simple));
        }
        let mut ns_opt = Some(current_ns.clone());
        while let Some(ns) = ns_opt {
            if let Some(found) = self.defs.get(&(ns.clone(), simple.clone())) {
                return Some(found);
            }
            ns_opt = ns.parent();
        }
        self.defs.get(&(Namespace(String::new()), simple))
    }

    /// **统一的 provider 实例化入口** (供 runtime / 其他 provider 在 resolve 时用)。
    /// 命中 DSL 项 → 构造 DslProvider; 命中 Programmatic 项 → 调 factory。
    /// `_ctx` 当前未使用——保留供将来 DSL 实例化期需要 runtime 时扩展。
    pub fn instantiate(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
        properties: &HashMap<String, TemplateValue>,
        _ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        match self.lookup(current_ns, reference)? {
            RegistryEntry::Programmatic(factory) => factory(properties).ok(),
            RegistryEntry::Dsl(def) => Some(Arc::new(DslProvider {
                def: def.clone(),
                properties: properties.clone(),
            })),
        }
    }

    /// 历史 API: 返回 DSL ProviderDef Arc (向后兼容; programmatic 项返回 None)。
    pub fn resolve(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
    ) -> Option<Arc<ProviderDef>> {
        match self.lookup(current_ns, reference)? {
            RegistryEntry::Dsl(def) => Some(def.clone()),
            RegistryEntry::Programmatic(_) => None,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&(Namespace, SimpleName), &RegistryEntry)> {
        self.defs.iter()
    }

    /// 仅遍历 DSL 项 (跳过 Programmatic) — validator 等只对 DSL spec 适用的场景用。
    pub fn iter_dsl(
        &self,
    ) -> impl Iterator<Item = (&(Namespace, SimpleName), &Arc<ProviderDef>)> {
        self.defs.iter().filter_map(|(k, v)| match v {
            RegistryEntry::Dsl(def) => Some((k, def)),
            RegistryEntry::Programmatic(_) => None,
        })
    }

    pub fn len(&self) -> usize {
        self.defs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.defs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(ns: Option<&str>, name: &str) -> ProviderDef {
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

    fn dummy_factory() -> impl Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
           + Send
           + Sync
           + 'static {
        |_props| {
            // a stub provider that won't be called in registry-only tests
            struct Stub;
            impl Provider for Stub {
                fn list(
                    &self,
                    _: &crate::compose::ProviderQuery,
                    _: &ProviderContext,
                ) -> Result<Vec<crate::provider::ChildEntry>, EngineError> {
                    Ok(Vec::new())
                }
                fn resolve(
                    &self,
                    _: &str,
                    _: &crate::compose::ProviderQuery,
                    _: &ProviderContext,
                ) -> Option<Arc<dyn Provider>> {
                    None
                }
            }
            Ok(Arc::new(Stub) as Arc<dyn Provider>)
        }
    }

    #[test]
    fn register_one() {
        let mut r = ProviderRegistry::new();
        assert!(r.is_empty());
        r.register(def(Some("kabegame"), "foo")).unwrap();
        assert_eq!(r.len(), 1);
        assert!(!r.is_empty());
    }

    #[test]
    fn register_duplicate() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("kabegame"), "foo")).unwrap();
        let err = r.register(def(Some("kabegame"), "foo")).expect_err("dup");
        assert!(matches!(err, RegistryError::Duplicate(_, _)));
    }

    #[test]
    fn resolve_simple_same_ns() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("kabegame"), "foo")).unwrap();
        let found = r.resolve(
            &Namespace("kabegame".into()),
            &ProviderName("foo".into()),
        );
        assert!(found.is_some());
    }

    #[test]
    fn resolve_simple_parent_fallback() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("kabegame"), "bar")).unwrap();
        let found = r.resolve(
            &Namespace("kabegame.plugin.x".into()),
            &ProviderName("bar".into()),
        );
        assert!(found.is_some(), "should fall back through parent chain");
    }

    #[test]
    fn resolve_absolute() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("b.c"), "d")).unwrap();
        let found = r.resolve(&Namespace("a".into()), &ProviderName("b.c.d".into()));
        assert!(found.is_some());
    }

    #[test]
    fn resolve_root_fallback() {
        let mut r = ProviderRegistry::new();
        r.register(def(None, "util")).unwrap();
        let found = r.resolve(
            &Namespace("kabegame.plugin".into()),
            &ProviderName("util".into()),
        );
        assert!(found.is_some(), "should find at root namespace");
    }

    #[test]
    fn resolve_miss() {
        let r = ProviderRegistry::new();
        let found = r.resolve(&Namespace("a".into()), &ProviderName("missing".into()));
        assert!(found.is_none());
    }

    #[test]
    fn iter_yields_all() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("a"), "x")).unwrap();
        r.register(def(Some("b"), "y")).unwrap();
        let count = r.iter().count();
        assert_eq!(count, 2);
    }

    // ===== 6a: programmatic registration =====

    #[test]
    fn register_provider_simple() {
        let mut r = ProviderRegistry::new();
        r.register_provider(
            Namespace("test".into()),
            SimpleName("foo".into()),
            dummy_factory(),
        )
        .unwrap();
        assert_eq!(r.len(), 1);
        let found = r.lookup(&Namespace("test".into()), &ProviderName("foo".into()));
        assert!(matches!(found, Some(RegistryEntry::Programmatic(_))));
    }

    #[test]
    fn register_provider_duplicate_with_dsl() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("test"), "foo")).unwrap();
        let err = r
            .register_provider(
                Namespace("test".into()),
                SimpleName("foo".into()),
                dummy_factory(),
            )
            .expect_err("dup");
        assert!(matches!(err, RegistryError::Duplicate(_, _)));
    }

    #[test]
    fn register_provider_duplicate_with_programmatic() {
        let mut r = ProviderRegistry::new();
        r.register_provider(
            Namespace("test".into()),
            SimpleName("foo".into()),
            dummy_factory(),
        )
        .unwrap();
        let err = r
            .register_provider(
                Namespace("test".into()),
                SimpleName("foo".into()),
                dummy_factory(),
            )
            .expect_err("dup");
        assert!(matches!(err, RegistryError::Duplicate(_, _)));
    }

    #[test]
    fn register_provider_namespace_chain() {
        let mut r = ProviderRegistry::new();
        r.register_provider(
            Namespace("a".into()),
            SimpleName("foo".into()),
            dummy_factory(),
        )
        .unwrap();
        let found = r.lookup(
            &Namespace("a.b.c".into()),
            &ProviderName("foo".into()),
        );
        assert!(matches!(found, Some(RegistryEntry::Programmatic(_))));
    }

    #[test]
    fn iter_yields_both_kinds() {
        let mut r = ProviderRegistry::new();
        r.register(def(Some("a"), "x")).unwrap();
        r.register_provider(
            Namespace("a".into()),
            SimpleName("y".into()),
            dummy_factory(),
        )
        .unwrap();
        let mut dsl_count = 0;
        let mut prog_count = 0;
        for (_k, entry) in r.iter() {
            match entry {
                RegistryEntry::Dsl(_) => dsl_count += 1,
                RegistryEntry::Programmatic(_) => prog_count += 1,
            }
        }
        assert_eq!(dsl_count, 1);
        assert_eq!(prog_count, 1);
    }

    #[test]
    fn resolve_old_api_returns_none_for_programmatic() {
        let mut r = ProviderRegistry::new();
        r.register_provider(
            Namespace("a".into()),
            SimpleName("foo".into()),
            dummy_factory(),
        )
        .unwrap();
        // resolve (old API returning ProviderDef) returns None for programmatic
        let found = r.resolve(&Namespace("a".into()), &ProviderName("foo".into()));
        assert!(found.is_none());
    }
}
