//! `gallery/search/` 路由壳。
//!
//! 三层结构:
//! - [`GallerySearchShell`]                  — `gallery/search/`:apply_query noop,子节点仅 `display-name`
//! - [`GallerySearchDisplayNameShell`]       — `gallery/search/display-name/`:apply_query noop,
//!   接任意非空字符串解析为叶子壳
//! - [`GallerySearchDisplayNameLeafShell`]   — `gallery/search/display-name/<q>/`:
//!     - `apply_query`:代理 [`SearchDisplayNameProvider`] 做 query merge
//!     - `list_children` / `get_child` / `list_images`:委派 [`GalleryRootProvider`]
//!       (下游暴露完整 gallery 树,可嵌套 AND 与任意维度组合)
//!
//! 与 [`GalleryHideShell`](crate::providers::gallery::hide::GalleryHideShell) 同为
//! "路由壳 + 代理 shared 纯查询组件"模式。

use std::sync::Arc;

use crate::providers::gallery::root::GalleryRootProvider;
use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::search::SearchDisplayNameProvider;
use crate::storage::gallery::ImageQuery;

/// `gallery/search/`:路由壳(无状态,apply_query noop)。
pub struct GallerySearchShell;

impl Provider for GallerySearchShell {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![ChildEntry::new(
            "display-name",
            Arc::new(GallerySearchDisplayNameShell),
        )])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "display-name" => Some(Arc::new(GallerySearchDisplayNameShell)),
            _ => None,
        }
    }
}

/// `gallery/search/display-name/`:路由壳(无状态,apply_query noop)。
/// 子节点按任意非空字符串动态解析为查询词。
pub struct GallerySearchDisplayNameShell;

impl Provider for GallerySearchDisplayNameShell {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let query = name.trim();
        if query.is_empty() {
            return None;
        }
        Some(Arc::new(GallerySearchDisplayNameLeafShell {
            query: query.to_string(),
        }))
    }
}

/// `gallery/search/display-name/<q>/`:叶子壳。
/// `apply_query` 代理 `SearchDisplayNameProvider` 做 query merge;
/// 路由 / 子枚举 / 图片列举 委派给 `GalleryRootProvider`——从而下游暴露完整 gallery 树,
/// 天然支持嵌套 AND (`search/.../A/search/.../B/`) 与挂 all/plugin/date/album/hide/... 。
pub struct GallerySearchDisplayNameLeafShell {
    pub query: String,
}

impl Provider for GallerySearchDisplayNameLeafShell {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        SearchDisplayNameProvider {
            query: self.query.clone(),
        }
        .apply_query(current)
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
