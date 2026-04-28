//! DSL 加载: 用 [`include_dir!`] 把 `core/src/providers/dsl/**/*.json5` 编进二进制,
//! 启动期按文件清单依次喂给 pathql-rs 的 [`pathql_rs::Json5Loader`] 并注册到
//! [`pathql_rs::ProviderRegistry`]。
//!
//! 启用 `validate` feature 时, 注册完后跑一次 [`pathql_rs::validate::validate`]
//! 做交叉引用 / SQL 形态体检, 失败直接 panic — DSL 是源码资产, 启动期就该挂。

use include_dir::{include_dir, Dir};
use pathql_rs::{
    validate::{validate, ValidateConfig},
    Json5Loader, Loader, ProviderDef, ProviderRegistry, Source,
};

/// 编译期嵌入的 DSL 资产根。布局必须与 `core/src/providers/dsl/` 同构。
pub static DSL_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/src/providers/dsl");

/// 文件清单。新增 / 删除 DSL provider 时同步更新此处 + register 调用方。
pub const DSL_FILES: &[&str] = &[
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

/// 把 9 个 .json5 加载、注册进给定 registry, 返回 root_provider 的 ProviderDef。
///
/// `root_provider` 单独返回, 因为它是 DslProvider 实例化为 runtime root 的素材。
pub fn load_dsl_into(registry: &mut ProviderRegistry) -> ProviderDef {
    let loader = Json5Loader;
    let mut root_def: Option<ProviderDef> = None;
    for rel in DSL_FILES {
        let file = DSL_DIR
            .get_file(rel)
            .unwrap_or_else(|| panic!("DSL file `{}` not found in include_dir embed", rel));
        let bytes = file.contents();
        let def = loader
            .load(Source::Bytes(bytes))
            .unwrap_or_else(|e| panic!("Json5Loader failed on `{}`: {}", rel, e));
        if def.name.0 == "root_provider" {
            root_def = Some(def.clone());
        }
        registry
            .register(def)
            .unwrap_or_else(|e| panic!("register `{}` failed: {}", rel, e));
    }
    root_def.expect("root_provider missing from DSL_FILES")
}

/// 启动期 sanity: 跑一次完整 validate (cross-ref + sql shape)。失败直接 panic, 让构建立刻挂。
/// 注意: cross-ref 模式默认关掉是因为 9 个 DSL 引用的部分名字仍由 programmatic 层提供 (gallery_albums_router 等);
/// 这里走的是 `enforce_cross_refs = false` 默认值, 只检查 reserved + sql 等本地约束。
pub fn validate_dsl(registry: &ProviderRegistry) {
    let cfg = ValidateConfig::with_default_reserved();
    if let Err(errs) = validate(registry, &cfg) {
        for e in &errs {
            eprintln!("[DSL validate] {}", e);
        }
        panic!("DSL validation failed ({} errors)", errs.len());
    }
}
