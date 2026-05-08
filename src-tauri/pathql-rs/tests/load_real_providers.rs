//! 端到端：用 Json5Loader 把真实 src-tauri/kabegame-core/src/providers/dsl/**/*.json{,5}
//! 一份一份喂给 Loader, 再 register 到 ProviderRegistry。
//!
//! 这模拟 Phase 6 中 kabegame-core 用 include_dir 嵌入 + 运行期注册的
//! 完整流程, 但从测试侧递归扫描磁盘 DSL 根目录。

#![cfg(feature = "json5")]

mod common;

use pathql_rs::{Json5Loader, Loader, Namespace, ProviderName, Source};

#[test]
fn loads_all_existing_providers() {
    let files = common::provider_file_paths();
    let r = common::build_real_registry();
    assert_eq!(r.len(), files.len());
}

#[test]
fn recursive_scan_excludes_non_provider_files() {
    let rels: Vec<String> = common::provider_file_paths()
        .iter()
        .map(|path| common::relative_provider_path(path))
        .collect();

    assert!(rels.contains(&"root_provider.json".to_string()));
    assert!(rels.contains(&"vd/zh_CN/vd_zh_CN_root_router.json5".to_string()));
    assert!(!rels.contains(&"schema.json5".to_string()));
    assert!(!rels.contains(&"gallery/all_router/x_page_x/gallery_page_router.json5".to_string()));
}

#[test]
fn root_provider_routes_to_gallery_and_vd() {
    let r = common::build_real_registry();
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
    let r = common::build_real_registry();
    let root_ns = Namespace("kabegame".into());
    let g = r
        .resolve(&root_ns, &ProviderName("gallery_route".into()))
        .expect("gallery_route should be resolvable");
    assert_eq!(g.name.0, "gallery_route");
}

#[test]
fn loads_with_bytes_source() {
    // 模拟 include_dir 路径：用 read 拿到 bytes, 然后 Source::Bytes
    let dir = common::providers_dir();
    let raw = std::fs::read(dir.join("root_provider.json")).unwrap();
    let def = Json5Loader.load(Source::Bytes(&raw)).expect("bytes load");
    assert_eq!(def.name.0, "root_provider");
}

#[test]
fn vd_zh_cn_router_loads_via_loader() {
    let r = common::build_real_registry();
    let root_ns = Namespace("kabegame".into());
    let vd = r
        .resolve(&root_ns, &ProviderName("vd_zh_CN_root_router".into()))
        .expect("vd_zh_CN_root_router");
    let list = vd.list.as_ref().expect("list");
    assert_eq!(list.entries.len(), 8);
    assert_eq!(list.entries[0].0, "画册");
    assert!(list.entries.iter().any(|(name, _)| name == "按时间"));
}

#[test]
fn gallery_paginate_router_dynamic_entry_loaded() {
    let r = common::build_real_registry();
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
