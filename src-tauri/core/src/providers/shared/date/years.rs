//! 年份列表节点（路由壳）。
//!
//! 类型归属：路由壳（日期层级根）。
//! apply_query：prepend_order_by(images.crawled_at ASC)——统一为整个日期子树贡献时间排序。
//! list_images：默认实现（全量查）。

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::date::year::YearProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 年份列表节点（根）。apply_query：prepend_order_by(crawled_at ASC)。
pub struct YearsProvider;

impl Provider for YearsProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.prepend_order_by("images.crawled_at ASC")
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let groups = Storage::global().get_gallery_date_groups()?;
        let years: BTreeSet<String> = groups
            .into_iter()
            .filter_map(|g| {
                if g.year_month.len() >= 4 { Some(g.year_month[..4].to_string()) } else { None }
            })
            .collect();
        Ok(years
            .into_iter()
            .map(|y| ChildEntry::new(y.clone(), Arc::new(YearProvider { year: y })))
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let name = name.trim();
        if name.len() != 4 || !name.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let q = ImageQuery::year_filter(name.to_string());
        if Storage::global().get_images_count_by_query(&q).ok()? == 0 {
            return None;
        }
        Some(Arc::new(YearProvider { year: name.to_string() }))
    }
}
