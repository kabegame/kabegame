//! 加载期语义校验。RULES.md §10。
//!
//! 入口: `validate(registry, &cfg)`. 失败返回 `Vec<ValidateError>` (不 short-circuit).

#![cfg(feature = "validate")]

pub mod config;
pub mod cross_ref;
pub mod cycle;
pub mod dynamic;
pub mod error;
pub mod meta_check;
pub mod names;
pub mod query_refs;
pub mod resolve_check;
pub mod simple;
pub mod sql;

pub use config::ValidateConfig;
pub use error::{ValidateError, ValidateErrorKind};

use crate::ProviderRegistry;

pub fn validate(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
) -> Result<(), Vec<ValidateError>> {
    let mut errors = Vec::new();
    simple::validate_simple(registry, cfg, &mut errors);
    sql::validate_sql_exprs(registry, cfg, &mut errors);
    resolve_check::validate_resolve(registry, &mut errors);
    cross_ref::validate_cross_refs(registry, cfg, &mut errors);
    cycle::check_delegate_cycles(registry, cfg, &mut errors);
    meta_check::validate_meta(registry, cfg, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// 拼接 namespace + name 为全限定名 (root namespace 直接用 name)。
pub(crate) fn fqn(ns: &crate::Namespace, name: &crate::SimpleName) -> String {
    if ns.0.is_empty() {
        name.0.clone()
    } else {
        format!("{}.{}", ns.0, name.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_validates_clean() {
        let r = ProviderRegistry::new();
        let cfg = ValidateConfig::with_default_reserved();
        assert!(validate(&r, &cfg).is_ok());
    }
}
