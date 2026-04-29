//! 遶ｯ蛻ｰ遶ｯ・壽ｨ｡諡・Phase 6 螳樣刔 resolve 霍ｯ蠕・噪 fold 體ｾ縲・//!
//! 霍ｯ蠕・ｼ嗷oot_provider 竊・gallery_route 竊・gallery_all_router (delegate) 竊・//!       gallery_paginate_router 竊・gallery_page_router (delegate) 竊・query_page_provider
//!
//! Delegate query 闃らせ荳榊盾荳・fold・郁ｷｯ蠕・㍾螳壼髄・檎罰 Phase 6 ProviderRuntime 螟・炊・峨・//! 譛ｬ豬玖ｯ募宵蟇ｹ ContribQuery 闃らせ蛛・fold_contrib・悟ｯｹ扈捺棡 ProviderQuery 蟄玲ｮｵ蛛・snapshot 譬｡鬪後・
#![cfg(feature = "json5")]

use std::path::PathBuf;

use pathql_rs::ast::{Namespace, NumberOrTemplate, ProviderName, Query, SqlExpr};
use pathql_rs::compose::{fold_contrib, ProviderQuery};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

const PROVIDER_FILES: &[&str] = &[
    "root_provider.json",
    "gallery/gallery_route.json5",
    "gallery/all_router/gallery_all_router.json5",
    "gallery/all_router/x_page_x/gallery_paginate_router.json5",
    "gallery/all_router/x_page_x/gallery_page_router.json5",
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
        .join("providers")
        .join("dsl");
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

    // 7b: gallery_route.query 邇ｰ蝨ｨ蜷ｫ order=[crawled_at asc] (莉・gallery_all_router 荳顔ｧｻ),
    // from=images, limit=0
    fold_provider_query(&mut state, &r, "gallery_route");
    // 7b: gallery_all_router 遘ｻ髯､莠・query 蟄玲ｮｵ (莉・Contrib 謾ｹ荳ｺ郤ｯ router; order/limit/offset 荳顔ｧｻ蛻ｰ
    // gallery_route, 蛻・｡ｵ騾夊ｿ・list 蜉ｨ諤・｡ｹ蟋疲汚 page_size_provider + gallery_page_router)
    fold_provider_query(&mut state, &r, "gallery_all_router");
    // gallery_paginate_router.query: { limit: 0 }
    fold_provider_query(&mut state, &r, "gallery_paginate_router");
    // gallery_page_router.query: { delegate: query_page_provider {ps,pn} } 窶・Delegate, skipped (fold 荳榊ｱ募ｼ)
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

    // 7b: offset 莉・ｸ鬘ｹ 窶・query_page_provider 逧・template (gallery_all_router 荳榊・雍｡迪ｮ offset)
    assert_eq!(state.offset_terms.len(), 1);
    match &state.offset_terms[0] {
        NumberOrTemplate::Template(t) => {
            assert!(t.0.contains("${properties.page_size}"));
            assert!(t.0.contains("${properties.page_num}"));
        }
        _ => panic!("expected query_page_provider's offset template"),
    }

    // 7b: order 譚･閾ｪ gallery_route (荳顔ｧｻ蜷・
    assert_eq!(state.order.entries.len(), 1);
    assert_eq!(state.order.entries[0].0, "images.crawled_at");
    assert!(state.order.global.is_none());

    assert_eq!(state.fields.len(), 17);
    assert_eq!(state.joins.len(), 2);
    assert!(state.wheres.is_empty());

    // no refs allocated
    assert_eq!(state.aliases.counter, 0);
}

#[test]
fn fold_skipping_root_and_delegates_only_contrib_applies() {
    // 7b: gallery_all_router has no contrib query; delegate nodes are skipped here.
    let r = build_full_registry();
    let mut state = ProviderQuery::new();

    fold_provider_query(&mut state, &r, "gallery_all_router"); // 7b: 譌 query, 譌雍｡迪ｮ
    fold_provider_query(&mut state, &r, "gallery_page_router"); // delegate, skipped
    assert!(state.from.is_none());
    assert!(state.fields.is_empty());
    assert!(state.joins.is_empty());
    assert!(state.wheres.is_empty());
    assert!(state.order.entries.is_empty());
    assert!(state.offset_terms.is_empty());
    assert!(state.limit.is_none());
}

#[test]
fn fold_gallery_route_alone_sets_from_and_limit_zero() {
    let r = build_full_registry();
    let mut state = ProviderQuery::new();
    fold_provider_query(&mut state, &r, "gallery_route");
    assert_eq!(state.from, Some(SqlExpr("images".into())));
    assert_eq!(state.limit, None);
    assert_eq!(state.fields.len(), 17);
    assert_eq!(state.joins.len(), 2);
    // 7b: gallery_route 邇ｰ荵溯ｴ｡迪ｮ order
    assert_eq!(state.order.entries.len(), 1);
    assert_eq!(state.order.entries[0].0, "images.crawled_at");
}
