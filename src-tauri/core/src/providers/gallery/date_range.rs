//! Gallery `date-range/`：日期范围动态路由。
//! 类型归属：路由壳（动态）。apply_query：merge(date_range_filter)（range 节点）。
//! list_images：override（委托 QueryPageProvider 取最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::providers::shared::sort::SortProvider;
use crate::storage::gallery::ImageQuery;

/// `gallery/date-range/`：根节点，子节点动态按 `YYYY-MM-DD~YYYY-MM-DD` 解析。
pub struct GalleryDateRangeRootProvider;

impl Provider for GalleryDateRangeRootProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let (start, end) = parse_date_range_name(name)?;
        Some(Arc::new(GalleryDateRangeProvider { start, end }))
    }
}

/// `gallery/date-range/YYYY-MM-DD~YYYY-MM-DD/`：日期范围叶子（分页）。
struct GalleryDateRangeProvider {
    start: String,
    end: String,
}

impl Provider for GalleryDateRangeProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
            .merge(&ImageQuery::date_range_filter(self.start.clone(), self.end.clone()))
            .prepend_order_by("images.crawled_at ASC")
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children = vec![ChildEntry::new(
            "desc",
            Arc::new(SortProvider::new(Arc::new(GalleryDateRangeProvider {
                start: self.start.clone(),
                end: self.end.clone(),
            }))),
        )];
        children.extend(PageSizeGroupProvider.list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryDateRangeProvider {
                start: self.start.clone(),
                end: self.end.clone(),
            }))));
        }
        PageSizeGroupProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}

/// 解析 `YYYY-MM-DD~YYYY-MM-DD` 格式的日期范围目录名。
pub fn parse_date_range_name(s: &str) -> Option<(String, String)> {
    let raw = s.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('~').collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parts[0].trim();
    let end = parts[1].trim();
    if start.len() != 10 || end.len() != 10 {
        return None;
    }
    if !start.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !start.as_bytes().get(7).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(7).is_some_and(|c| *c == b'-')
    {
        return None;
    }
    Some((start.to_string(), end.to_string()))
}
