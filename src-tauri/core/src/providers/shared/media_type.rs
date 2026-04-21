//! 按媒体类型分组的共享 provider（shared 底层）。
//!
//! - `MediaTypesProvider`：路由壳；apply_query：noop；列出 "image" / "video" 两个子节点。
//! - `MediaTypeProvider`：shared 底层；apply_query：merge(media_type_filter)；list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;

/// 媒体类型列表节点（根）。apply_query：noop。
pub struct MediaTypesProvider;

impl Provider for MediaTypesProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![
            ChildEntry::new("image", Arc::new(MediaTypeProvider { kind: "image".to_string() })),
            ChildEntry::new("video", Arc::new(MediaTypeProvider { kind: "video".to_string() })),
        ])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "image" | "video" => {
                Some(Arc::new(MediaTypeProvider { kind: name.to_string() }))
            }
            _ => None,
        }
    }
}

/// 单一媒体类型节点。apply_query：merge(media_type_filter)。list_images：override（最后一页）。
pub struct MediaTypeProvider {
    pub kind: String,
}

impl Provider for MediaTypeProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::media_type_filter(&self.kind))
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        PageSizeGroupProvider.list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        PageSizeGroupProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}
