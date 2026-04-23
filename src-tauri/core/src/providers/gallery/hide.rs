//! GalleryHideShell:`gallery/hide/` 路由壳。
//!
//! `apply_query` 代理 [`HideProvider`](crate::providers::shared::hide::HideProvider)
//! 注入隐藏过滤 WHERE;`list_children` / `get_child` / `list_images` 全部委派
//! 给 [`GalleryRootProvider`](crate::providers::gallery::root::GalleryRootProvider),
//! 使 `gallery/hide/` 下游暴露完整 gallery 树(含 `search` 等),
//! 可与任意维度 / 搜索前缀组合。

use std::sync::Arc;

use crate::providers::gallery::root::GalleryRootProvider;
use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::hide::HideProvider;
use crate::storage::gallery::ImageQuery;

pub struct GalleryHideShell;

impl Provider for GalleryHideShell {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        HideProvider.apply_query(current)
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        GalleryRootProvider.list_children(composed)
    }

    fn list_children_with_meta(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        GalleryRootProvider.list_children_with_meta(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        GalleryRootProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        GalleryRootProvider.list_images(composed)
    }
}
