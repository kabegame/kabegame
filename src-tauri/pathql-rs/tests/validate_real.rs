//! 端到端：递归加载 kabegame-core 的真实 DSL provider 语料后,
//! `validate` 必须返回 `Ok(())`。

#![cfg(all(feature = "json5", feature = "validate"))]

mod common;

use pathql_rs::validate::{validate, ValidateConfig};

#[test]
fn all_real_providers_validate_clean() {
    let registry = common::build_real_registry();
    let cfg = ValidateConfig::with_default_reserved();
    if let Err(errs) = validate(&registry, &cfg) {
        for e in &errs {
            eprintln!("  {}", e);
        }
        panic!("expected clean validate, got {} errors", errs.len());
    }
}

#[test]
fn cross_ref_strict_real_providers_validate_clean() {
    let registry = common::build_real_registry();
    let cfg = ValidateConfig::with_default_reserved().with_cross_refs(true);
    if let Err(errs) = validate(&registry, &cfg) {
        for e in &errs {
            eprintln!("  {}", e);
        }
        panic!(
            "expected clean strict cross-ref validate, got {} errors",
            errs.len()
        );
    }
}
