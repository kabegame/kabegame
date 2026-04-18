//! HideGateProvider：隐藏画册过滤门。
//!
//! `apply_query` 注入带 `/*HIDE*/` 标签的 NOT EXISTS 子句，
//! 过滤所有已加入隐藏画册的图片。`AlbumProvider` / `VdAlbumEntryProvider`
//! 在 `album_id == HIDDEN_ALBUM_ID` 时会扫描 `wheres` 并剥除含
//! `/*HIDE*/` 的片段，使隐藏画册详情页仍能显示自己的图片。
//!
//! 所有非 `apply_query` 方法 delegate 到 inner。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::storage::gallery::ImageQuery;
use crate::storage::HIDDEN_ALBUM_ID;

pub struct HideGateProvider {
    pub inner: Arc<dyn Provider>,
}

impl HideGateProvider {
    pub fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }
}

impl Provider for HideGateProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        self.inner.apply_query(current).with_where(
            "/*HIDE*/ NOT EXISTS (SELECT 1 FROM album_images aih \
             WHERE aih.album_id = ? AND aih.image_id = images.id)",
            vec![HIDDEN_ALBUM_ID.to_string()],
        )
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
