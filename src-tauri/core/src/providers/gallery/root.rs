//! GalleryRootProvider：画廊根目录，列出固定的 canonical 子入口。
//! 类型归属：路由壳（gallery 根）。apply_query：noop。list_images：默认实现（不 override）。
//!
//! 同文件并列 `GalleryFilteredRootProvider`：**搜索上下文内**使用的裁剪版根——
//! 结构与 `GalleryRootProvider` 相同，但：
//! - 不含 `search` 子入口（避免二次嵌套）
//! - `hide` 分支包裹的内层根也指向 `GalleryFilteredRootProvider`（保证搜索上下文内不会出现 search）

use std::sync::Arc;

use crate::providers::gallery::{
    album::GalleryAlbumsProvider,
    all::{GalleryAllProvider, GalleryWallpaperOrderProvider},
    date::GalleryDateGroupProvider,
    date_range::GalleryDateRangeRootProvider,
    media_type::GalleryMediaTypeProvider,
    plugin::GalleryPluginGroupProvider,
    search::GallerySearchRootProvider,
    surf::GallerySurfGroupProvider,
    task::GalleryTaskGroupProvider,
};
use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::hide_gate::HideGateProvider;
use crate::storage::gallery::ImageQuery;

/// 画廊根 provider — 10 个基础 canonical 入口 + `search`。
pub struct GalleryRootProvider;

/// 搜索上下文内的裁剪版画廊根：与 `GalleryRootProvider` 行为相同，但不含 `search`，
/// 且 `hide` 分支内层自指向本类型。
pub struct GalleryFilteredRootProvider;

impl Provider for GalleryRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(gallery_root_children(true))
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        gallery_root_get_child(name, true)
    }
}

impl Provider for GalleryFilteredRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(gallery_root_children(false))
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        gallery_root_get_child(name, false)
    }
}

fn hide_inner_root(include_search: bool) -> Arc<dyn Provider> {
    if include_search {
        Arc::new(GalleryRootProvider)
    } else {
        Arc::new(GalleryFilteredRootProvider)
    }
}

fn gallery_root_children(include_search: bool) -> Vec<ChildEntry> {
    let mut entries = vec![
        ChildEntry::new("all", Arc::new(GalleryAllProvider)),
        ChildEntry::new("wallpaper-order", Arc::new(GalleryWallpaperOrderProvider)),
        ChildEntry::new("plugin", Arc::new(GalleryPluginGroupProvider)),
        ChildEntry::new("task", Arc::new(GalleryTaskGroupProvider)),
        ChildEntry::new("surf", Arc::new(GallerySurfGroupProvider)),
        ChildEntry::new("media-type", Arc::new(GalleryMediaTypeProvider)),
        ChildEntry::new("date", Arc::new(GalleryDateGroupProvider)),
        ChildEntry::new("date-range", Arc::new(GalleryDateRangeRootProvider)),
        ChildEntry::new("album", Arc::new(GalleryAlbumsProvider)),
        ChildEntry::new(
            "hide",
            Arc::new(HideGateProvider::new(hide_inner_root(include_search))),
        ),
    ];
    if include_search {
        entries.push(ChildEntry::new(
            "search",
            Arc::new(GallerySearchRootProvider),
        ));
    }
    entries
}

fn gallery_root_get_child(name: &str, include_search: bool) -> Option<Arc<dyn Provider>> {
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
        "hide" => Arc::new(HideGateProvider::new(hide_inner_root(include_search))),
        "search" if include_search => Arc::new(GallerySearchRootProvider),
        _ => return None,
    };
    Some(provider)
}
