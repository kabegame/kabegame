use crate::ast::{Namespace, ProviderDef, ProviderName, SimpleName};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("duplicate provider: {0:?}.{1:?}")]
    Duplicate(Namespace, SimpleName),
}

#[derive(Debug, Default)]
pub struct ProviderRegistry {
    defs: HashMap<(Namespace, SimpleName), Arc<ProviderDef>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, def: ProviderDef) -> Result<(), RegistryError> {
        let ns = def
            .namespace
            .clone()
            .unwrap_or_else(|| Namespace(String::new()));
        let key = (ns, def.name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(key.0, key.1));
        }
        self.defs.insert(key, Arc::new(def));
        Ok(())
    }

    /// Java-package-style fallback: current → parent → ... → root（空 namespace）
    pub fn resolve(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
    ) -> Option<Arc<ProviderDef>> {
        let (ref_ns, simple) = reference.split();
        if let Some(abs_ns) = ref_ns {
            return self.defs.get(&(abs_ns, simple)).cloned();
        }
        let mut ns_opt = Some(current_ns.clone());
        while let Some(ns) = ns_opt {
            if let Some(found) = self.defs.get(&(ns.clone(), simple.clone())) {
                return Some(found.clone());
            }
            ns_opt = ns.parent();
        }
        self.defs.get(&(Namespace(String::new()), simple)).cloned()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&(Namespace, SimpleName), &Arc<ProviderDef>)> {
        self.defs.iter()
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
}
