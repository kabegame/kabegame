//! 终端分页 provider（新 Provider trait）。
//!
//! 类型归属：终端。apply_query：noop（分页参数内化在字段里）。list_images：override（分页/最后一页）。
//!
//! - `page = None`：`list_images` 返回最后一页；`list_children` 返回数字段 `1..=N`。
//! - `page = Some(n)`：`list_images` 返回第 n 页；`list_children = []`（叶子）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::settings::Settings;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

fn page_size() -> usize {
    Settings::global().get_gallery_page_size() as usize
}

/// 终端分页节点。不持有自己的 query——composed 由 runtime 通过 apply_query 链传入。
pub struct QueryPageProvider {
    /// None = 组根（list_images 取最后一页；list_children 返回 1..=N）
    /// Some(n) = 叶子（list_images 取第 n 页；list_children = []）
    pub page: Option<usize>,
}

impl QueryPageProvider {
    pub fn root() -> Self {
        Self { page: None }
    }

    pub fn page(n: usize) -> Self {
        Self { page: Some(n.max(1)) }
    }
}

impl Provider for QueryPageProvider {
    // 不列最后一个页了，避免 UI 上重复（最后一页的图片列表和分页节点都在最后了）
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        if self.page.is_some() {
            return Ok(Vec::new());
        }
        let ps = page_size();
        let total = Storage::global().get_images_count_by_query(composed)?;
        if total == 0 {
            return Ok(Vec::new());
        }
        let total_pages = total.div_ceil(ps);
        Ok((1..=total_pages-1)
            .map(|n| ChildEntry::new(n.to_string(), Arc::new(QueryPageProvider::page(n))))
            .collect())
    }

    // 可以包含最后一页（如果正好满页就不多列了）
    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if self.page.is_some() {
            return None;
        }
        let n: usize = name.parse().ok().filter(|&n| n > 0)?;
        Some(Arc::new(QueryPageProvider::page(n)))
    }

    // 列出最后一页
    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        let storage = Storage::global();
        let ps = page_size();
        match self.page {
            Some(p) => {
                let offset = (p - 1) * ps;
                storage.get_images_info_range_by_query(composed, offset, ps)
            }
            None => {
                let total = storage.get_images_count_by_query(composed)?;
                if total == 0 {
                    return Ok(Vec::new());
                }
                let total_pages = total.div_ceil(ps);
                let last_offset = (total_pages - 1) * ps;
                storage.get_images_info_range_by_query(composed, last_offset, ps)
            }
        }
    }
}
