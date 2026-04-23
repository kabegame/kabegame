//! GalleryRootProvider:画廊根目录,列出 11 个 canonical 子入口。
//! 类型归属:路由壳(gallery 根)。apply_query:noop。list_images:默认实现(不 override)。
//!
//! 11 个入口:`all` / `wallpaper-order` / `plugin` / `task` / `surf` / `media-type` /
//! `date` / `date-range` / `album` / `hide` / `search`。其中 `hide` 与 `search` 都是
//! gallery 特有的"路由壳 + 代理 shared 纯查询组件"模式——见 `gallery/hide.rs` 与
//! `gallery/search.rs`。
//!
//! `search/` 允许嵌套(`search/.../A/search/.../B/...` = LIKE A AND LIKE B),
//! 因为叶子壳 `list_children` / `get_child` 委派给 `GalleryRootProvider`,
//! 下游树含 `search` 入口。

use std::sync::Arc;

use crate::providers::gallery::{
    album::GalleryAlbumsProvider,
    all::{GalleryAllProvider, GalleryWallpaperOrderProvider},
    date::GalleryDateGroupProvider,
    date_range::GalleryDateRangeRootProvider,
    hide::GalleryHideShell,
    media_type::GalleryMediaTypeProvider,
    plugin::GalleryPluginGroupProvider,
    search::GallerySearchShell,
    surf::GallerySurfGroupProvider,
    task::GalleryTaskGroupProvider,
};
use crate::providers::provider::{ChildEntry, Provider};
use crate::storage::gallery::ImageQuery;

/// 画廊根 provider — 10 个基础 canonical 入口 + `hide` + `search`(两个过滤壳)。
pub struct GalleryRootProvider;

impl Provider for GalleryRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![
            ChildEntry::new("all", Arc::new(GalleryAllProvider)),
            ChildEntry::new("wallpaper-order", Arc::new(GalleryWallpaperOrderProvider)),
            ChildEntry::new("plugin", Arc::new(GalleryPluginGroupProvider)),
            ChildEntry::new("task", Arc::new(GalleryTaskGroupProvider)),
            ChildEntry::new("surf", Arc::new(GallerySurfGroupProvider)),
            ChildEntry::new("media-type", Arc::new(GalleryMediaTypeProvider)),
            ChildEntry::new("date", Arc::new(GalleryDateGroupProvider)),
            ChildEntry::new("date-range", Arc::new(GalleryDateRangeRootProvider)),
            ChildEntry::new("album", Arc::new(GalleryAlbumsProvider)),
            ChildEntry::new("hide", Arc::new(GalleryHideShell)),
            ChildEntry::new("search", Arc::new(GallerySearchShell)),
        ])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let provider: Arc<dyn Provider> = match name {
            "all" => Arc::new(GalleryAllProvider),
            "wallpaper-order" => Arc::new(GalleryWallpaperOrderProvider),
            "plugin" => Arc::new(GalleryPluginGroupProvider),
            "task" => Arc::new(GalleryTaskGroupProvider),
            "surf" => Arc::new(GallerySurfGroupProvider),
            "media-type" => Arc::new(GalleryMediaTypeProvider),
            "date" => Arc::new(GalleryDateGroupProvider),
            "date-range" => Arc::new(GalleryDateRangeRootProvider),
            "album" => Arc::new(GalleryAlbumsProvider),
            "hide" => Arc::new(GalleryHideShell),
            "search" => Arc::new(GallerySearchShell),
            _ => return None,
        };
        Some(provider)
    }
}
