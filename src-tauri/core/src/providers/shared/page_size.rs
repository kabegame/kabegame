//! 分页大小 provider（路由壳）。
//!
//! 路径约定：
//! - `<path>/{page}`          → PageSizeGroupProvider 默认大小 100
//! - `<path>/x{size}x/{page}` → PageSizeGroupProvider 路由到 PageSizeProvider{size}
//!
//! PageSizeGroupProvider：list_children 只列数字页段（默认大小 100）；
//!                        get_child 额外接受 `x{size}x` 动态段。
//! PageSizeProvider：     list_children 列数字页段（使用 page_size）；
//!                        list_images 返回最后一页；委托给 QueryPageProvider。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::query_page::QueryPageProvider;
use crate::storage::gallery::ImageQuery;

pub const DEFAULT_PAGE_SIZE: usize = 100;

/// 将任意 n 规范化到 10..=1000、步长 10。n=0 返回 None。
fn normalize_page_size(n: usize) -> Option<usize> {
    if n == 0 {
        return None;
    }
    let clamped = n.clamp(10, 1000);
    let snapped = ((clamped + 5) / 10) * 10;
    Some(snapped.clamp(10, 1000))
}

/// 分页大小节点。列出指定 page_size 下的数字页段；委托 QueryPageProvider 实现。
pub struct PageSizeProvider {
    pub page_size: usize,
}

impl Provider for PageSizeProvider {
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        QueryPageProvider::new(self.page_size).list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        QueryPageProvider::new(self.page_size).get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::new(self.page_size).list_images(composed)
    }
}

/// 路由壳：list_children 只列默认大小的数字页段；
/// get_child 额外接受 `x{size}x` 动态段路由到对应 PageSizeProvider。
pub struct PageSizeGroupProvider;

impl Provider for PageSizeGroupProvider {
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if let Some(inner) = name.strip_prefix('x').and_then(|s| s.strip_suffix('x')) {
            let n: usize = inner.parse().ok()?;
            let ps = normalize_page_size(n)?;
            return Some(Arc::new(PageSizeProvider { page_size: ps }));
        }
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeProvider { page_size: DEFAULT_PAGE_SIZE }.list_images(composed)
    }
}
