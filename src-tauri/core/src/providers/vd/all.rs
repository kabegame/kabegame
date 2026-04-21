//! VD `all/`：扁平分页，按 id ASC（页数越小 id 越小；根级别显示最后一页 = 最新）。
//! 类型归属：路由壳（分页委托终端）。
//! apply_query：noop（排序已由父链 VdRootProvider 贡献 id ASC）。
//! list_images：override（委托 PageSizeProvider 取最后一页）。
//! VD 不列 x{size}x 段；固定页面大小 100。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::page_size::{PageSizeProvider, DEFAULT_PAGE_SIZE};
use crate::storage::gallery::ImageQuery;

pub struct VdAllProvider;

impl Provider for VdAllProvider {
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.list_images(composed)
    }
}
