//! Provider 架构纯函数测试（无需 DB 初始化）。
//!
//! 关注：
//! - `apply_query` 链的 composed SQL 正确性（每个 provider 贡献 join/where/order）
//! - `SortProvider::apply_query` 的翻转语义（对所有 order_bys 生效）
//! - `ImageQuery::prepend_order_by` 的前插语义
//! - 交叉路由（Phase 6 §3 验证）：PluginProvider + Year/Month/Day 组合
//! - Gallery 画册路径（`album/{id}/album-order/...` / `image-only/...` / `wallpaper-order/...`）
//!   —— 当前这些路径在 `GalleryAlbumEntryProvider::get_child` 里**没有**分支，会落入
//!   `Storage::get_album_by_id(...)` → 返回 `None` → runtime 报"路径不存在"。
//!   本模块用手工拼链的方式验证"修好之后"的 composed 结构；若新 shell 不存在则编译失败。

#![cfg(test)]

use std::sync::Arc;

use crate::providers::gallery::album::{
    GalleryAlbumEntryProvider, GalleryAlbumMediaFilterShell, GalleryAlbumOrderShell,
    GalleryAlbumWallpaperShell, GalleryAlbumsProvider,
};
use crate::providers::gallery::all::GalleryAllProvider;
use crate::providers::gallery::root::GalleryRootProvider;
use crate::providers::gallery::search::GallerySearchDisplayNameShell;
use crate::providers::provider::Provider;
use crate::providers::shared::search::SearchDisplayNameProvider;
use crate::providers::shared::{
    album::AlbumsProvider, plugin::PluginProvider, sort::SortProvider,
};
use crate::providers::shared::date::{
    month::MonthProvider, year::YearProvider, years::YearsProvider,
};
use crate::storage::gallery::ImageQuery;

// ── 基础：SortProvider 翻转语义 ──────────────────────────────────────────────

#[test]
fn sort_provider_flips_ascending_order_to_descending() {
    let mut q = ImageQuery::new();
    q = q.with_order("images.crawled_at ASC");
    q = q.with_order("images.id ASC");

    let flipped = SortProvider::new(Arc::new(PluginProvider {
        plugin_id: "noop".to_string(),
    }))
    .apply_query(q);

    assert_eq!(
        flipped.order_bys,
        vec![
            "images.crawled_at DESC".to_string(),
            "images.id DESC".to_string(),
        ],
        "SortProvider 应该翻转 order_bys 里每一项的方向"
    );
}

#[test]
fn prepend_order_by_inserts_at_front() {
    let q = ImageQuery::new()
        .with_order("images.crawled_at ASC")
        .prepend_order_by("ai.id ASC");

    assert_eq!(
        q.order_bys,
        vec!["ai.id ASC".to_string(), "images.crawled_at ASC".to_string()],
        "prepend_order_by 应该把新条目插到最前面（时间 provider 依赖这点）"
    );
}

#[test]
fn sort_provider_flips_prepended_order_together() {
    let base = ImageQuery::new()
        .with_order("images.crawled_at ASC")
        .prepend_order_by("ai.id ASC");

    let desc = SortProvider::new(Arc::new(PluginProvider {
        plugin_id: "noop".to_string(),
    }))
    .apply_query(base);

    assert_eq!(
        desc.order_bys,
        vec!["ai.id DESC".to_string(), "images.crawled_at DESC".to_string()],
        "SortProvider 应该同时翻转 prepended 和原有 order_bys"
    );
}

// ── 共享 provider 的 apply_query 语义 ───────────────────────────────────────

#[test]
fn plugin_provider_appends_where_plugin_id() {
    let q = PluginProvider { plugin_id: "foo".to_string() }
        .apply_query(ImageQuery::new());

    let (sql, params) = q.build_sql();
    assert!(
        sql.contains("images.plugin_id = ?"),
        "plugin provider 应该追加 plugin_id WHERE"
    );
    assert!(params.contains(&"foo".to_string()));
}

#[test]
fn albums_provider_contributes_join_and_time_order() {
    let q = AlbumsProvider.apply_query(ImageQuery::new());

    let (sql, _params) = q.build_sql();
    assert!(
        sql.contains("INNER JOIN album_images ai"),
        "AlbumsProvider 应该贡献 album_images JOIN"
    );
    assert!(
        sql.contains("images.crawled_at ASC"),
        "AlbumsProvider 应该 prepend crawled_at ASC"
    );
}

// ── Phase 6 §3 交叉路由验证：PluginProvider + YearProvider 组合 ────────────

#[test]
fn cross_route_plugin_plus_year_composes_both_filters() {
    // 模拟路径：`byPlugin/foo/byTime/2024`（若 VdByPluginRouter::get_child 临时接 byTime）
    let mut composed = ImageQuery::new().with_order("images.id ASC"); // VD 根兜底序

    composed = PluginProvider {
        plugin_id: "foo".to_string(),
    }
    .apply_query(composed);
    composed = YearsProvider.apply_query(composed);
    composed = YearProvider {
        year: "2024".to_string(),
    }
    .apply_query(composed);

    let (sql, params) = composed.build_sql();

    assert!(
        sql.contains("images.plugin_id = ?"),
        "cross-route 应保留 plugin WHERE"
    );
    assert!(
        sql.contains("strftime('%Y'"),
        "cross-route 应追加 year WHERE"
    );
    assert!(params.contains(&"foo".to_string()));
    assert!(params.contains(&"2024".to_string()));

    // ORDER BY 应该同时含 crawled_at ASC（来自 YearsProvider prepend）+ id ASC（根兜底）
    assert!(
        sql.contains("ORDER BY images.crawled_at ASC, images.id ASC"),
        "cross-route 应保留一份最终序。实际: {}",
        sql
    );
}

#[test]
fn cross_route_plugin_plus_month_plus_desc_flips_all_orders() {
    let mut composed = ImageQuery::new().with_order("images.id ASC");

    composed = PluginProvider {
        plugin_id: "foo".to_string(),
    }
    .apply_query(composed);
    composed = YearsProvider.apply_query(composed);
    composed = YearProvider {
        year: "2024".to_string(),
    }
    .apply_query(composed);
    composed = MonthProvider {
        year_month: "2024-03".to_string(),
    }
    .apply_query(composed);

    // 外层套 SortProvider
    composed = SortProvider::new(Arc::new(PluginProvider {
        plugin_id: "noop".to_string(),
    }))
    .apply_query(composed);

    let (sql, _params) = composed.build_sql();

    assert!(
        sql.contains("ORDER BY images.crawled_at DESC, images.id DESC"),
        "cross-route + desc 应翻转所有 order_bys。实际: {}",
        sql
    );
}

// ── BUG: 画册路径 album-order / image-only / video-only / wallpaper-order ──

/// 模拟前端路径 `gallery/album/{id}/album-order/1`（join-asc 排序）。
/// 正确实现：
///   AlbumsProvider.apply_query  — JOIN album_images + prepend crawled_at ASC
///   AlbumProvider(id).apply_query — WHERE ai.album_id = ?
///   GalleryAlbumOrderShell.apply_query — prepend `COALESCE(ai."order", ai.rowid) ASC`
///   QueryPageProvider 分页 (apply_query noop)
///
/// 期望 SQL：
///   ... INNER JOIN album_images ai ON ...
///   WHERE (ai.album_id = ?)
///   ORDER BY COALESCE(ai."order", ai.rowid) ASC, images.crawled_at ASC
///
/// 注意：`album_images` 表无 `id` 列（主键 `(album_id, image_id)` + 可空 `"order"`）。
#[test]
fn album_album_order_asc_composes_join_where_order() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumOrderShell.apply_query(q);

    let (sql, params) = q.build_sql();

    assert!(sql.contains("INNER JOIN album_images ai"));
    assert!(sql.contains("ai.album_id = ?"));
    assert!(
        sql.contains("ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC, images.crawled_at ASC"),
        "album-order 应在时间序之前插 album_images 顺序列。实际: {}",
        sql
    );
    assert!(params.contains(&"TEST".to_string()));
}

/// 模拟 `album/{id}/album-order/desc/1`（join-desc）。
#[test]
fn album_album_order_desc_flips_both_orders() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumOrderShell.apply_query(q);
    q = SortProvider::new(Arc::new(GalleryAlbumOrderShell)).apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(
        sql.contains("ORDER BY COALESCE(ai.\"order\", ai.rowid) DESC, images.crawled_at DESC"),
        "album-order/desc 应翻转两项。实际: {}",
        sql
    );
}

/// 模拟 `album/{id}/image-only/1`（仅图片过滤，time-asc 默认序）。
#[test]
fn album_image_only_adds_media_type_filter() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumMediaFilterShell {
        kind: "image".to_string(),
    }
    .apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(
        sql.contains("ai.album_id = ?"),
        "image-only 应保留父链 album_id WHERE"
    );
    assert!(
        sql.contains("NOT (LOWER(COALESCE(images.type"),
        "image-only 应追加 media_type 过滤。实际: {}",
        sql
    );
}

/// 模拟 `album/{id}/video-only/1`。
#[test]
fn album_video_only_adds_media_type_filter() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumMediaFilterShell {
        kind: "video".to_string(),
    }
    .apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(sql.contains("ai.album_id = ?"));
    assert!(
        sql.contains("(LOWER(COALESCE(images.type"),
        "video-only 应追加视频过滤。实际: {}",
        sql
    );
}

/// 模拟 `album/{id}/image-only/album-order/1`（image + join-asc）。
#[test]
fn album_image_only_album_order_composes_all() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumMediaFilterShell {
        kind: "image".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumOrderShell.apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(sql.contains("ai.album_id = ?"));
    assert!(sql.contains("NOT (LOWER(COALESCE(images.type"));
    assert!(
        sql.contains("ORDER BY COALESCE(ai.\"order\", ai.rowid) ASC, images.crawled_at ASC"),
        "image-only/album-order 应含 COALESCE(ai.\"order\", ai.rowid) ASC + crawled_at ASC。实际: {}",
        sql
    );
}

/// 模拟 `album/{id}/wallpaper-order/1`（仅设过壁纸）。
#[test]
fn album_wallpaper_order_filters_and_reorders() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumWallpaperShell.apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(sql.contains("ai.album_id = ?"));
    assert!(
        sql.contains("images.last_set_wallpaper_at IS NOT NULL"),
        "wallpaper-order 应过滤 last_set_wallpaper_at"
    );
    assert!(
        sql.contains("ORDER BY images.last_set_wallpaper_at ASC, images.crawled_at ASC"),
        "wallpaper-order 应 prepend last_set_wallpaper_at ASC。实际: {}",
        sql
    );
}

/// 模拟 `album/{id}/wallpaper-order/desc/1`。
#[test]
fn album_wallpaper_order_desc_flips_both() {
    let mut q = ImageQuery::new();
    q = GalleryAlbumsProvider.apply_query(q);
    q = GalleryAlbumEntryProvider {
        album_id: "TEST".to_string(),
    }
    .apply_query(q);
    q = GalleryAlbumWallpaperShell.apply_query(q);
    q = SortProvider::new(Arc::new(GalleryAlbumWallpaperShell)).apply_query(q);

    let (sql, _params) = q.build_sql();

    assert!(
        sql.contains("ORDER BY images.last_set_wallpaper_at DESC, images.crawled_at DESC"),
        "wallpaper-order/desc 应翻转两项。实际: {}",
        sql
    );
}

// ── get_child 单元测试：SortProvider / QueryPageProvider（无 DB） ──────────

// ── Search Provider：LIKE 过滤与下游组合 ──────────────────────────────────

fn search_leaf(query: &str) -> SearchDisplayNameProvider {
    SearchDisplayNameProvider {
        query: query.to_string(),
    }
}

#[test]
fn display_name_search_leaf_appends_like_where() {
    let q = search_leaf("原神").apply_query(ImageQuery::new());

    let (sql, params) = q.build_sql();
    assert!(
        sql.contains("LOWER(images.display_name) LIKE LOWER(?) ESCAPE '\\'"),
        "search 叶子应追加 LIKE WHERE。实际: {}",
        sql
    );
    assert!(
        params.contains(&"%原神%".to_string()),
        "search 叶子应注入 %原神% 参数。实际 params: {:?}",
        params
    );
}

#[test]
fn display_name_search_escapes_like_wildcards() {
    let q = search_leaf("50%_off").apply_query(ImageQuery::new());

    let (_sql, params) = q.build_sql();
    assert!(
        params.contains(&"%50\\%\\_off%".to_string()),
        "LIKE 通配符 % 与 _ 应被反斜杠转义。实际 params: {:?}",
        params
    );
}

#[test]
fn search_composes_with_all_plus_desc() {
    let mut composed = ImageQuery::new();
    composed = search_leaf("原神").apply_query(composed);
    composed = GalleryAllProvider.apply_query(composed);
    composed = SortProvider::new(Arc::new(GalleryAllProvider)).apply_query(composed);

    let (sql, params) = composed.build_sql();

    assert!(
        sql.contains("LOWER(images.display_name) LIKE LOWER(?) ESCAPE '\\'"),
        "组合链应保留 search LIKE WHERE。实际: {}",
        sql
    );
    assert!(
        sql.contains("images.crawled_at DESC"),
        "组合链应含 all + desc 翻转后的 crawled_at DESC。实际: {}",
        sql
    );
    assert!(params.contains(&"%原神%".to_string()));
}

#[test]
fn search_composes_with_plugin_filter() {
    let mut composed = ImageQuery::new();
    composed = search_leaf("原神").apply_query(composed);
    composed = PluginProvider {
        plugin_id: "pixiv".to_string(),
    }
    .apply_query(composed);

    let (sql, params) = composed.build_sql();

    assert!(
        sql.contains("LOWER(images.display_name) LIKE LOWER(?) ESCAPE '\\'"),
        "组合链应保留 search LIKE。实际: {}",
        sql
    );
    assert!(
        sql.contains("images.plugin_id = ?"),
        "组合链应追加 plugin_id WHERE。实际: {}",
        sql
    );
    assert!(params.contains(&"%原神%".to_string()));
    assert!(params.contains(&"pixiv".to_string()));
}

/// 模拟 `search/display-name/A/search/display-name/B/all/`——嵌套 search 应 AND 组合。
/// 走 get_child 链以真实验证 GallerySearchShell → GallerySearchDisplayNameShell → 叶子壳的路由,
/// 并确认叶子壳的 `get_child` 委派 GalleryRootProvider 后仍能再进入 search 子树。
#[test]
fn nested_search_produces_and_composition() {
    let composed = ImageQuery::new();

    // 第一层:gallery 根 → search → display-name → A
    let root: Arc<dyn Provider> = Arc::new(GalleryRootProvider);
    let search1 = root.get_child("search", &composed).expect("gallery 有 search 入口");
    let display1 = search1
        .get_child("display-name", &composed)
        .expect("search 有 display-name 子");
    let leaf1 = display1
        .get_child("A", &composed)
        .expect("非空 query 应解析为叶子");
    let composed = leaf1.apply_query(composed);

    // 第二层:从第一层叶子继续 get_child('search')(叶子壳 get_child 委派 GalleryRootProvider,仍有 search)
    let search2 = leaf1
        .get_child("search", &composed)
        .expect("叶子壳 get_child 委派 GalleryRootProvider,含 search");
    let display2 = search2
        .get_child("display-name", &composed)
        .expect("第二层同样有 display-name");
    let leaf2 = display2
        .get_child("B", &composed)
        .expect("第二层 query 解析");
    let composed = leaf2.apply_query(composed);

    // 最后:all/
    let all = leaf2
        .get_child("all", &composed)
        .expect("叶子壳 get_child 委派 GalleryRootProvider,含 all");
    let composed = all.apply_query(composed);

    let (sql, params) = composed.build_sql();

    let like_count = sql.matches("LOWER(images.display_name) LIKE LOWER(?) ESCAPE '\\'").count();
    assert_eq!(
        like_count, 2,
        "嵌套 search 应产生两条 LIKE WHERE(AND 组合)。实际: {}",
        sql
    );
    assert!(
        params.contains(&"%A%".to_string()) && params.contains(&"%B%".to_string()),
        "params 应同时含 %A% 和 %B%。实际: {:?}",
        params
    );
    assert!(
        sql.contains("images.crawled_at ASC"),
        "all 应 prepend crawled_at ASC。实际: {}",
        sql
    );
}

/// 空 query 在 GallerySearchDisplayNameShell::get_child 被拦截。
#[test]
fn empty_query_is_rejected() {
    let shell = GallerySearchDisplayNameShell;
    let composed = ImageQuery::new();
    assert!(shell.get_child("", &composed).is_none());
    assert!(shell.get_child("   ", &composed).is_none());
}

#[test]
fn sort_provider_delegates_get_child_to_inner() {
    // SortProvider::get_child 透传到 inner。用一个 noop PluginProvider 做 inner
    // （PluginProvider::get_child 调 QueryPageProvider::root().get_child — 纯解析数字，不读 DB）。
    let inner: Arc<dyn Provider> = Arc::new(PluginProvider {
        plugin_id: "noop".to_string(),
    });
    let sort = SortProvider::new(inner);

    let composed = ImageQuery::new();

    let child = sort.get_child("1", &composed);
    assert!(child.is_some(), "SortProvider 应 delegate 数字段到 inner");

    let nope = sort.get_child("not-a-number", &composed);
    assert!(
        nope.is_none(),
        "SortProvider 应 delegate 非数字/非 desc 段到 inner"
    );
}
