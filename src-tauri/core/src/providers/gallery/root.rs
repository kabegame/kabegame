//! GalleryRootProvider：画廊根目录，列出 9 个固定子入口（canonical 名）。
//! 类型归属：路由壳（gallery 根）。apply_query：noop。list_images：默认实现（不 override）。

use std::sync::Arc;

use crate::providers::gallery::{
    album::GalleryAlbumsProvider,
    all::{GalleryAllProvider, GalleryWallpaperOrderProvider},
    date::GalleryDateGroupProvider,
    date_range::GalleryDateRangeRootProvider,
    media_type::GalleryMediaTypeProvider,
    plugin::GalleryPluginGroupProvider,
    surf::GallerySurfGroupProvider,
    task::GalleryTaskGroupProvider,
};
use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::hide_gate::HideGateProvider;
use crate::storage::gallery::ImageQuery;

/// 画廊根 provider — 固定 9 个 canonical 入口。
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
            ChildEntry::new(
                "hide",
                Arc::new(HideGateProvider::new(Arc::new(GalleryRootProvider))),
            ),
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
            "hide" => Arc::new(HideGateProvider::new(Arc::new(GalleryRootProvider))),
            _ => return None,
        };
        Some(provider)
    }
}
