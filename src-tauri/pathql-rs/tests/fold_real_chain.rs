//! 端到端：模拟 Phase 6 实际 resolve 路径的 fold 链。
//!
//! 路径：root_provider → gallery_route → gallery_all_router (delegate) →
//!       gallery_paginate_router → gallery_page_router (delegate) → query_page_provider
//!
//! Delegate query 节点不参与 fold（路径重定向，由 Phase 6 ProviderRuntime 处理）。
//! 本测试只对 ContribQuery 节点做 fold_contrib，对结果 ProviderQuery 字段做 snapshot 校验。

#![cfg(all(feature = "json5", feature = "compose"))]

use std::path::PathBuf;

use pathql_rs::ast::{Namespace, NumberOrTemplate, ProviderName, Query, SqlExpr};
use pathql_rs::compose::{fold_contrib, ProviderQuery};
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

fn fold_provider_query(state: &mut ProviderQuery, registry: &ProviderRegistry, name: &str) {
    let ns = Namespace("kabegame".into());
    let def = registry
        .resolve(&ns, &ProviderName(name.into()))
        .unwrap_or_else(|| panic!("provider {} not in registry", name));
    if let Some(Query::Contrib(q)) = &def.query {
        fold_contrib(state, q).unwrap_or_else(|e| panic!("fold {} failed: {}", name, e));
    }
}

#[test]
fn fold_gallery_page_chain() {
    let r = build_full_registry();
    let mut state = ProviderQuery::new();

    // gallery_route.query: { from: "images", limit: 0 }
    fold_provider_query(&mut state, &r, "gallery_route");
    // gallery_all_router.query: { delegate: "./x100x/1/" } — Delegate, skipped
    fold_provider_query(&mut state, &r, "gallery_all_router");
    // gallery_paginate_router.query: { limit: 0 }
    fold_provider_query(&mut state, &r, "gallery_paginate_router");
    // gallery_page_router.query: { delegate: "./__provider" } — Delegate, skipped
    fold_provider_query(&mut state, &r, "gallery_page_router");
    // query_page_provider.query: { offset: "${...} * (${...} - 1)", limit: "${properties.page_size}" }
    fold_provider_query(&mut state, &r, "query_page_provider");

    // ----- snapshot -----

    // from cascaded from gallery_route (no later override)
    assert_eq!(state.from, Some(SqlExpr("images".into())));

    // limit last-wins: query_page_provider's "${properties.page_size}"
    match state.limit {
        Some(NumberOrTemplate::Template(ref t)) => {
            assert_eq!(t.0, "${properties.page_size}");
        }
        _ => panic!("expected templated limit, got {:?}", state.limit),
    }

    // offset accumulated: only one term from query_page_provider
    assert_eq!(state.offset_terms.len(), 1);
    match &state.offset_terms[0] {
        NumberOrTemplate::Template(t) => {
            assert!(t.0.contains("${properties.page_size}"));
            assert!(t.0.contains("${properties.page_num}"));
        }
        _ => panic!("expected templated offset"),
    }

    // no fields / joins / wheres / order accumulated
    assert!(state.fields.is_empty());
    assert!(state.joins.is_empty());
    assert!(state.wheres.is_empty());
    assert!(state.order.entries.is_empty());
    assert!(state.order.global.is_none());

    // no refs allocated
    assert_eq!(state.aliases.counter, 0);
}

#[test]
fn fold_skipping_root_and_delegates_only_contrib_applies() {
    // Confirm that root_provider (no query) and delegate-only nodes never push into state.
    let r = build_full_registry();
    let mut state = ProviderQuery::new();

    fold_provider_query(&mut state, &r, "root_provider");
    fold_provider_query(&mut state, &r, "gallery_all_router"); // delegate
    fold_provider_query(&mut state, &r, "gallery_page_router"); // delegate
    fold_provider_query(&mut state, &r, "vd_root_router");
    fold_provider_query(&mut state, &r, "vd_zh_CN_root_router");

    // none of these contribute via Contrib → state stays empty
    assert!(state.from.is_none());
    assert!(state.fields.is_empty());
    assert!(state.joins.is_empty());
    assert!(state.wheres.is_empty());
    assert!(state.offset_terms.is_empty());
    assert!(state.limit.is_none());
}

#[test]
fn fold_gallery_route_alone_sets_from_and_limit_zero() {
    let r = build_full_registry();
    let mut state = ProviderQuery::new();
    fold_provider_query(&mut state, &r, "gallery_route");
    assert_eq!(state.from, Some(SqlExpr("images".into())));
    assert_eq!(state.limit, Some(NumberOrTemplate::Number(0.0)));
}
