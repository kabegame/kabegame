//! HideProvider:纯查询组件,注入隐藏画册过滤 WHERE(带 `/*HIDE*/` 标记)。
//!
//! 路由不由它负责——由 [`GalleryHideShell`](crate::providers::gallery::hide::GalleryHideShell)
//! 代理调用本组件完成 query merge,再把 list_children/get_child/list_images 委派给
//! `GalleryRootProvider`。
//!
//! WHERE 复用 `gallery.rs` 中始终注入的 `ai_hid` LEFT JOIN 别名。
//! `/*HIDE*/` 字符串是跨模块约定:`shared/album.rs` 与 `vd/albums.rs` 在
//! `album_id == HIDDEN_ALBUM_ID` 时扫描 wheres 并剥除含此标记的片段,
//! 使隐藏画册详情页仍能展示自己的图片。**必须原样保留**。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider};
use crate::storage::gallery::ImageQuery;

pub struct HideProvider;

impl Provider for HideProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_where("/*HIDE*/ ai_hid.image_id IS NULL", vec![])
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, _name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        None
    }
}
