//! 排序壳（shared 底层）。
//!
//! - `SortProvider`：排序壳；apply_query：current.to_desc()（翻转所有 order_bys ASC↔DESC）；
//!   其余方法全部 delegate 到 inner。list_images：透传 inner。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::storage::gallery::ImageQuery;

/// 排序翻转壳。apply_query：to_desc()（纯 flip，不贡献 join/where）。
/// 其余方法全部 delegate 到 inner provider。
pub struct SortProvider {
    pub inner: Arc<dyn Provider>,
}

impl SortProvider {
    pub fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }
}

impl Provider for SortProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.to_desc()
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
