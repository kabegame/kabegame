//! DSL 加载: 用 [`include_dir!`] 把 `core/src/providers/dsl/**/*.json5` 编进二进制,
//! 启动期按文件清单依次喂给 pathql-rs 的 runtime 动态注册接口。
//!
//! 启用 `validate` feature 时, 注册完后跑一次 [`pathql_rs::validate::validate`]
//! 做交叉引用 / SQL 形态体检, 失败直接 panic — DSL 是源码资产, 启动期就该挂。

use include_dir::{include_dir, Dir};
use pathql_rs::{validate::ValidateConfig, LoaderType, ProviderRuntime, Source};

/// Provider DSL files supported inside plugin `providers/` directories.
pub const PROVIDER_FILE_EXTENSIONS: &[&str] = &["json", "json5"];

pub fn is_provider_file_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with("providers/")
        && PROVIDER_FILE_EXTENSIONS.iter().any(|ext| {
            normalized
                .rsplit_once('.')
                .map(|(_, got)| got.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
}

/// 编译期嵌入的 DSL 资产根。布局必须与 `core/src/providers/dsl/` 同构。
pub static DSL_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/src/providers/dsl");

pub const ROOT_PROVIDER: &str = "root_provider.json";

/// 文件清单。新增 / 删除 DSL provider 时同步更新此处 + register 调用方。
pub const DSL_FILES: &[&str] = &[
    ROOT_PROVIDER,
    "images/images_root_provider.json5",
    "images/images_id_provider.json5",
    "images/images_metadata_provider.json5",
    "gallery/gallery_route.json5",
    "gallery/all_router/gallery_all_router.json5",
    "gallery/all_router/desc/gallery_all_desc_router.json5",
    "gallery/all_router/x_page_x/gallery_paginate_router.json5",
    "gallery/all_router/x_page_x/gallery_page_router.json5",
    "gallery/gallery_hide_router.json5",
    "gallery/gallery_search_router.json5",
    "gallery/gallery_bigger_crawler_time_router.json5",
    "gallery/gallery_bigger_crawler_time_filter.json5",
    "gallery/album/gallery_album_bigger_order_router.json5",
    "gallery/album/gallery_album_bigger_order_filter.json5",
    "gallery/album/gallery_album_order_provider.json5",
    "gallery/album/gallery_album_media_type_provider.json5",
    "gallery/albums/gallery_albums_router.json5",
    "gallery/albums/gallery_album_provider.json5",
    "gallery/plugins/gallery_plugins_router.json5",
    "shared/plugin_provider.json5",
    "gallery/plugins/gallery_plugin_provider.json5",
    "gallery/tasks/gallery_tasks_router.json5",
    "gallery/tasks/gallery_task_provider.json5",
    "gallery/surfs/gallery_surfs_router.json5",
    "gallery/surfs/gallery_surf_provider.json5",
    "gallery/media_type/gallery_media_type_router.json5",
    "gallery/media_type/gallery_media_type_provider.json5",
    "gallery/gallery_wallpaper_order_router.json5",
    "gallery/search/gallery_search_display_name_router.json5",
    "gallery/search/gallery_search_display_name_query_provider.json5",
    "gallery/date_range/gallery_date_range_router.json5",
    "gallery/date_range/gallery_date_range_entry_provider.json5",
    "gallery/dates/gallery_dates_router.json5",
    "gallery/dates/gallery_date_year_provider.json5",
    "gallery/dates/gallery_date_month_provider.json5",
    "gallery/dates/gallery_date_day_provider.json5",
    "shared/page_size_provider.json5",
    "shared/query_page_provider.json5",
    "shared/sort_provider.json5",
    "shared/sort_router.json5",
    "shared/limit_leaf_provider.json5",
    "shared/plugin_entry_provider.json5",
    "vd/vd_root_router.json5",
    "vd/vd_zh_CN_root_router.json5",
    "vd/vd_en_US_root_router.json5",
    "vd/vd_ja_root_router.json5",
    "vd/vd_ko_root_router.json5",
    "vd/vd_zhtw_root_router.json5",
    "vd/vd_all_provider.json5",
    "vd/vd_albums_provider.json5",
    "vd/vd_album_entry_provider.json5",
    "vd/vd_sub_album_gate_provider.json5",
    "vd/vd_zh_CN_plugins_provider.json5",
    "vd/vd_en_US_plugins_provider.json5",
    "vd/vd_ja_plugins_provider.json5",
    "vd/vd_ko_plugins_provider.json5",
    "vd/vd_zhtw_plugins_provider.json5",
    "vd/vd_zh_CN_plugin_router.json5",
    "vd/vd_en_US_plugin_router.json5",
    "vd/vd_ja_plugin_router.json5",
    "vd/vd_ko_plugin_router.json5",
    "vd/vd_zhtw_plugin_router.json5",
    "vd/vd_tasks_provider.json5",
    "vd/vd_surfs_provider.json5",
    "vd/vd_media_type_provider.json5",
    "vd/vd_dates_provider.json5",
];

/// 把所有内置 DSL 文件动态注册进 runtime。
pub fn register_embedded_dsl(runtime: &ProviderRuntime) {
    for rel in DSL_FILES {
        let file = DSL_DIR
            .get_file(rel)
            .unwrap_or_else(|| panic!("DSL file `{}` not found in include_dir embed", rel));
        let bytes = file.contents();
        runtime
            .register_provider_dsl(LoaderType::JSON5, Source::Bytes(bytes))
            .unwrap_or_else(|e| panic!("register DSL `{}` failed: {}", rel, e));
    }
}

/// 启动期 sanity: 跑一次完整 validate。失败直接 panic, 让构建立刻挂。
/// Phase 7c 后 core 内置 provider 已全量 DSL 化; 这里仍沿用默认配置, 只检查
/// reserved / SQL shape 等本地约束。跨引用严格模式留给后续第三方 DSL namespace
/// 装载策略一起开启。
pub fn validate_dsl(runtime: &ProviderRuntime) {
    let cfg = ValidateConfig::with_default_reserved();
    if let Err(errs) = runtime.validate(&cfg) {
        for e in &errs {
            eprintln!("[DSL validate] {}", e);
        }
        panic!("DSL validation failed ({} errors)", errs.len());
    }
}
