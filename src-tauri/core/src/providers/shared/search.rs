//! SearchDisplayNameProvider:纯查询组件,按 `display_name` 子串注入 LIKE WHERE。
//!
//! 路由不由它负责——由 gallery/ 侧的路由壳
//! (例如 [`GallerySearchDisplayNameLeafShell`](crate::providers::gallery::search::GallerySearchDisplayNameLeafShell))
//! 代理调用本组件完成 query merge,壳自己决定 `list_children` / `get_child` 如何暴露下游树。
//!
//! 与 [`HideProvider`](crate::providers::shared::hide::HideProvider) 同为"纯查询组件"模式。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider};
use crate::storage::gallery::ImageQuery;

pub struct SearchDisplayNameProvider {
    pub query: String,
}

impl Provider for SearchDisplayNameProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::display_name_search(self.query.clone()))
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, _name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        None
    }
}
