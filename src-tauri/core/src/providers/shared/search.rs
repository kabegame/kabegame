//! 通用搜索前置过滤器（与 [`HideGateProvider`] 同构的 filter-wrapper 族）。
//!
//! 三层结构，全部以 `inner: Arc<dyn Provider>` 注入,可挂载到任意树:
//! - [`SearchRootProvider`]              — `.../search/`:单一子节点 `display-name`，inner 原样传递
//! - [`SearchDisplayNameRootProvider`]   — `.../search/display-name/`:接任意非空字符串为子节点
//! - [`SearchDisplayNameProvider`]       — `.../search/display-name/<q>/`:
//!     - `apply_query`:`inner.apply_query` 后 merge `ImageQuery::display_name_search(q)`
//!     - 其余方法全部 delegate 到 `inner`
//!
//! 注册点(例如 [`GalleryRootProvider`](crate::providers::gallery::root::GalleryRootProvider))
//! 只需 `SearchRootProvider::new(Arc::new(TheirRoot))`。嵌套天然合法:
//! `search/.../A/search/.../B/` ⇒ 两层 leaf 各贡献一条 LIKE，组合为 AND。
//!
//! [`HideGateProvider`]: crate::providers::shared::hide_gate::HideGateProvider

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::storage::gallery::ImageQuery;

/// `.../search/`:搜索根壳。目前仅接 `display-name` 字段。
pub struct SearchRootProvider {
    pub inner: Arc<dyn Provider>,
}

impl SearchRootProvider {
    pub fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }
}

impl Provider for SearchRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![ChildEntry::new(
            "display-name",
            Arc::new(SearchDisplayNameRootProvider::new(self.inner.clone())),
        )])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "display-name" => Some(Arc::new(SearchDisplayNameRootProvider::new(
                self.inner.clone(),
            ))),
            _ => None,
        }
    }
}

/// `.../search/display-name/`:字段壳，接任意非空字符串作为查询词。
pub struct SearchDisplayNameRootProvider {
    pub inner: Arc<dyn Provider>,
}

impl SearchDisplayNameRootProvider {
    pub fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }
}

impl Provider for SearchDisplayNameRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let query = name.trim();
        if query.is_empty() {
            return None;
        }
        Some(Arc::new(SearchDisplayNameProvider {
            query: query.to_string(),
            inner: self.inner.clone(),
        }))
    }
}

/// `.../search/display-name/<q>/`:LIKE 过滤叶子。注入 WHERE，其余全部 delegate。
pub struct SearchDisplayNameProvider {
    pub query: String,
    pub inner: Arc<dyn Provider>,
}

impl Provider for SearchDisplayNameProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        self.inner
            .apply_query(current)
            .merge(&ImageQuery::display_name_search(self.query.clone()))
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        self.inner.list_children(composed)
    }

    fn list_children_with_meta(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        self.inner.list_children_with_meta(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        self.inner.list_images(composed)
    }

    fn get_note(&self) -> Option<(String, String)> {
        self.inner.get_note()
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        self.inner.get_meta()
    }
}
