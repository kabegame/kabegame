//! Gallery `search/`：前置搜索过滤器，与 `all`/`plugin`/... 并列。
//!
//! 三层结构：
//! - `GallerySearchRootProvider`              — `gallery/search/` 根壳（apply_query: noop）
//! - `GallerySearchDisplayNameRootProvider`   — `gallery/search/display-name/` 字段壳（apply_query: noop）
//! - `GallerySearchDisplayNameProvider`       — `gallery/search/display-name/<q>/` 叶子：
//!     - `apply_query`：merge `ImageQuery::display_name_search(query)`（LIKE `%q%`，大小写不敏感）
//!     - `list_children` / `get_child`：委派给 `GalleryFilteredRootProvider`（裁剪掉 `search` 入口
//!       的 Gallery 根），使搜索上下文可与任意下游维度（all/plugin/date/album/hide/...）组合。

use std::sync::Arc;

use crate::providers::gallery::root::GalleryFilteredRootProvider;
use crate::providers::provider::{ChildEntry, Provider};
use crate::storage::gallery::ImageQuery;

/// `gallery/search/`：搜索根。目前只支持 `display-name` 字段。
pub struct GallerySearchRootProvider;

impl Provider for GallerySearchRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![ChildEntry::new(
            "display-name",
            Arc::new(GallerySearchDisplayNameRootProvider),
        )])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "display-name" => Some(Arc::new(GallerySearchDisplayNameRootProvider)),
            _ => None,
        }
    }
}

/// `gallery/search/display-name/`：字段壳。子节点按任意非空字符串动态解析为查询词。
pub struct GallerySearchDisplayNameRootProvider;

impl Provider for GallerySearchDisplayNameRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let query = name.trim();
        if query.is_empty() {
            return None;
        }
        Some(Arc::new(GallerySearchDisplayNameProvider {
            query: query.to_string(),
        }))
    }
}

/// `gallery/search/display-name/<q>/`：搜索过滤叶子 + 暴露裁剪版 Gallery 根作为子树。
pub struct GallerySearchDisplayNameProvider {
    pub(crate) query: String,
}

impl Provider for GallerySearchDisplayNameProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::display_name_search(self.query.clone()))
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        GalleryFilteredRootProvider.list_children(composed)
    }

    fn list_children_with_meta(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        GalleryFilteredRootProvider.list_children_with_meta(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        GalleryFilteredRootProvider.get_child(name, composed)
    }
}
