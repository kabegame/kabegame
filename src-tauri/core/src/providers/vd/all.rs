//! VD `all/`：扁平分页，按 id ASC（页数越小 id 越小；根级别显示最后一页 = 最新）。
//! 类型归属：路由壳（分页委托终端）。
//! apply_query：noop（排序已由父链 VdRootProvider 贡献 id ASC）。
//! list_images：override（委托 QueryPageProvider 取最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::query_page::QueryPageProvider;
use crate::providers::vd::locale::VdLocaleConfig;
use crate::storage::gallery::ImageQuery;

pub struct VdAllProvider {
    pub cfg: VdLocaleConfig,
}

impl Provider for VdAllProvider {
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        QueryPageProvider::root().list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}
