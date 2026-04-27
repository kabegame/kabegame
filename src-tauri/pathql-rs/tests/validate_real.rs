//! 端到端：用 Json5Loader 加载 9 个真实 provider 文件后,
//! `validate` 必须返回 `Ok(())` (不开启 enforce_cross_refs, 因为部分被引用 provider 不在 fixture 集中).

#![cfg(all(feature = "json5", feature = "validate"))]

use std::path::PathBuf;

use pathql_rs::validate::{validate, ValidateConfig};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

const PROVIDER_FILES: &[&str] = &[
    "root_provider.json",
    "gallery/gallery_route.json5",
    "gallery/gallery_all_router.json5",
    "gallery/gallery_paginate_router.json5",
    "gallery/gallery_page_router.json5",
    "shared/page_size_provider.json5",
    "shared/query_page_provider.json5",
    "vd/vd_root_router.json5",
    "vd/vd_zh_CN_root_router.json5",
];

fn build_full_registry() -> ProviderRegistry {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core")
        .join("src")
        .join("providers");
    let loader = Json5Loader;
    let mut registry = ProviderRegistry::new();
    for rel in PROVIDER_FILES {
        let path = dir.join(rel);
        let def = loader
            .load(Source::Path(&path))
            .unwrap_or_else(|e| panic!("load {}: {}", rel, e));
        registry
            .register(def)
            .unwrap_or_else(|e| panic!("register {}: {}", rel, e));
    }
    registry
}

#[test]
fn all_real_providers_validate_clean() {
    let registry = build_full_registry();
    let cfg = ValidateConfig::with_default_reserved();
    if let Err(errs) = validate(&registry, &cfg) {
        for e in &errs {
            eprintln!("  {}", e);
        }
        panic!("expected clean validate, got {} errors", errs.len());
    }
}

#[test]
fn cross_ref_strict_finds_missing_subset_providers() {
    // With strict cross-ref ON and only 9 providers loaded, many references
    // resolve to providers not in fixture set — should report errors,
    // confirming the validator is wired up.
    let registry = build_full_registry();
    let cfg = ValidateConfig::with_default_reserved().with_cross_refs(true);
    let result = validate(&registry, &cfg);
    let errs = result.expect_err("strict cross-ref should detect missing providers");
    assert!(
        errs.iter().any(|e| matches!(
            e.kind,
            pathql_rs::validate::ValidateErrorKind::UnresolvedProviderRef(_, _)
        )),
        "expected at least one UnresolvedProviderRef among {} errors",
        errs.len()
    );
}
