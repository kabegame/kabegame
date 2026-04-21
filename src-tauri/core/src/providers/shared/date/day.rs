//! 日期叶子节点（shared 底层）。
//!
//! 类型归属：shared 底层（日期层级叶子）。
//! apply_query：merge(day_filter(ymd))——追加日期 WHERE 过滤。
//! list_children：数字页段（委托 QueryPageProvider）。
//! list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;

/// 单日叶子节点。apply_query：merge(day_filter)。list_images：override（最后一页）。
pub struct DayProvider {
    pub ymd: String,
}

impl Provider for DayProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::day_filter(self.ymd.clone()))
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
