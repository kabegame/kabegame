//! 年份节点（shared 底层）。
//!
//! 类型归属：shared 底层（日期层级）。
//! apply_query：merge(year_filter(year))——追加年份 WHERE 过滤，不影响父链已有排序。
//! list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::date::month::MonthProvider;
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 单一年份节点。apply_query：merge(year_filter)。list_images：override（最后一页）。
pub struct YearProvider {
    pub year: String,
}

impl Provider for YearProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::year_filter(self.year.clone()))
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let groups = Storage::global().get_gallery_date_groups()?;
        let prefix = format!("{}-", self.year);
        Ok(groups
            .into_iter()
            .filter(|g| g.year_month.len() == 7 && g.year_month.starts_with(&prefix))
            .map(|g| {
                ChildEntry::new(
                    g.year_month.clone(),
                    Arc::new(MonthProvider { year_month: g.year_month }),
                )
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let name = name.trim();
        if name.len() != 7 || name.as_bytes().get(4) != Some(&b'-') {
            return None;
        }
        let prefix = format!("{}-", self.year);
        if !name.starts_with(&prefix) {
            return None;
        }
        let groups = Storage::global().get_gallery_date_groups().ok()?;
        if !groups.iter().any(|g| g.year_month == name) {
            return None;
        }
        Some(Arc::new(MonthProvider { year_month: name.to_string() }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}
