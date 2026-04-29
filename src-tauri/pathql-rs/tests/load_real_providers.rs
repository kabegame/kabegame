//! 端到端：用 Json5Loader 把真实 src-tauri/core/src/providers/**/*.json{,5}
//! 一份一份喂给 Loader, 再 register 到 ProviderRegistry。
//!
//! 这模拟 Phase 6 中 kabegame-core 用 include_dir 嵌入 + 运行期注册的
//! 完整流程, 但用 std::fs::read_to_string + 硬编码文件列表驱动
//! (pathql-rs 自身不做目录扫描)。

#![cfg(feature = "json5")]

use std::path::PathBuf;

use pathql_rs::{Json5Loader, Loader, Namespace, ProviderName, ProviderRegistry, Source};

/// 硬编码当前所有 provider 文件的相对路径（相对 core/src/providers/dsl/）。
/// 新增 provider 时同步此列表。
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

fn providers_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core")
        .join("src")
        .join("providers")
        .join("dsl")
}

fn build_registry() -> ProviderRegistry {
    let loader = Json5Loader;
    let dir = providers_dir();
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
fn loads_all_existing_providers() {
    let r = build_registry();
    assert_eq!(r.len(), PROVIDER_FILES.len());
}

#[test]
fn root_provider_routes_to_gallery_and_vd() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let root = r
        .resolve(&root_ns, &ProviderName("root_provider".into()))
        .expect("root_provider");
    let list = root.list.as_ref().expect("root list");
    let names: Vec<&str> = list.entries.iter().map(|(k, _)| k.as_str()).collect();
    assert!(names.contains(&"gallery"));
    assert!(names.contains(&"vd"));
}

#[test]
fn gallery_route_resolves_in_namespace_chain() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let g = r
        .resolve(&root_ns, &ProviderName("gallery_route".into()))
        .expect("gallery_route should be resolvable");
    assert_eq!(g.name.0, "gallery_route");
}

#[test]
fn loads_with_bytes_source() {
    // 模拟 include_dir 路径：用 read 拿到 bytes, 然后 Source::Bytes
    let dir = providers_dir();
    let raw = std::fs::read(dir.join("root_provider.json")).unwrap();
    let def = Json5Loader.load(Source::Bytes(&raw)).expect("bytes load");
    assert_eq!(def.name.0, "root_provider");
}

#[test]
fn vd_zh_cn_router_loads_via_loader() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let vd = r
        .resolve(&root_ns, &ProviderName("vd_zh_CN_root_router".into()))
        .expect("vd_zh_CN_root_router");
    let list = vd.list.as_ref().expect("list");
    assert_eq!(list.entries.len(), 7);
    assert_eq!(list.entries[0].0, "按画册");
}

#[test]
fn gallery_paginate_router_dynamic_entry_loaded() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let p = r
        .resolve(&root_ns, &ProviderName("gallery_paginate_router".into()))
        .expect("gallery_paginate_router");
    let list = p.list.as_ref().expect("list");
    assert_eq!(list.entries.len(), 1);
    let key = &list.entries[0].0;
    assert_eq!(key, "${out.meta.page_num}");
    match &list.entries[0].1 {
        pathql_rs::ListEntry::Dynamic(pathql_rs::DynamicListEntry::Delegate(_)) => {}
        _ => panic!("expected dynamic delegate entry"),
    }
}
