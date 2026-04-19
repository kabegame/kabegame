//! VD `bySurf/`：按畅游记录（host）分组，直接委托 shared::SurfsProvider。
//! 类型归属：路由壳（host 已是显示名，直接 delegate）。
//! apply_query：noop。list_images：默认实现。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::surf::SurfsProvider;
use crate::storage::gallery::ImageQuery;

pub struct VdBySurfProvider;

impl Provider for VdBySurfProvider {
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        SurfsProvider.list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        SurfsProvider.get_child(name, composed)
    }
}
