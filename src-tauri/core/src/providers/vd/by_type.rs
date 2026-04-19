//! VD `byType/`：按媒体类型分组（翻译后的 `image`/`video` 名）。
//! 类型归属：路由壳（i18n 名称翻译 + 委托 shared::MediaTypeProvider）。
//! apply_query：noop。list_images：默认实现。

use std::sync::Arc;

use kabegame_i18n::vd_display_name;

use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::media_type::{MediaTypeProvider, MediaTypesProvider};
use crate::storage::gallery::ImageQuery;

pub struct VdByTypeProvider;

impl Provider for VdByTypeProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![
            ChildEntry::new(
                vd_display_name("image"),
                Arc::new(MediaTypeProvider { kind: "image".to_string() }),
            ),
            ChildEntry::new(
                vd_display_name("video"),
                Arc::new(MediaTypeProvider { kind: "video".to_string() }),
            ),
        ])
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let canonical = if name == vd_display_name("image") {
            "image"
        } else if name == vd_display_name("video") {
            "video"
        } else {
            return None;
        };
        MediaTypesProvider.get_child(canonical, composed)
    }
}
