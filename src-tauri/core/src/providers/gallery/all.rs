//! Gallery `all/` 与 `wallpaper-order/`：全量分页 + desc 翻转。
//! 类型归属：路由壳。
//! apply_query：prepend crawled_at ASC（all）/ wallpaper_set_filter + last_set_wallpaper_at ASC（wallpaper-order）。
//! list_images：override（委托 QueryPageProvider 取最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::{query_page::QueryPageProvider, sort::SortProvider};
use crate::storage::gallery::ImageQuery;

/// Gallery `all/`：全部图片，按抓取时间正序；`desc/` 翻转。
pub struct GalleryAllProvider;

impl Provider for GalleryAllProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.prepend_order_by("images.crawled_at ASC")
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children = vec![
            ChildEntry::new("desc", Arc::new(SortProvider::new(Arc::new(GalleryAllProvider)))),
        ];
        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryAllProvider))));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}

/// Gallery `wallpaper-order/`：仅"曾设为壁纸"的图片，按设置时间正序；`desc/` 翻转。
pub struct GalleryWallpaperOrderProvider;

impl Provider for GalleryWallpaperOrderProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
            .merge(&ImageQuery::wallpaper_set_filter())
            .prepend_order_by("images.last_set_wallpaper_at ASC")
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children = vec![
            ChildEntry::new(
                "desc",
                Arc::new(SortProvider::new(Arc::new(GalleryWallpaperOrderProvider))),
            ),
        ];
        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryWallpaperOrderProvider))));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}
