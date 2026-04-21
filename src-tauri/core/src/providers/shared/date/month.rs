//! 月份节点（shared 底层）。
//!
//! 类型归属：shared 底层（日期层级）。
//! apply_query：merge(date_filter(year_month))——追加年月 WHERE 过滤。
//! list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::date::day::DayProvider;
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 单一月份节点。apply_query：merge(date_filter)。list_images：override（最后一页）。
pub struct MonthProvider {
    pub year_month: String,
}

impl Provider for MonthProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::date_filter(self.year_month.clone()))
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let prefix = format!("{}-", self.year_month);
        let days = Storage::global().get_gallery_day_groups()?;
        Ok(days
            .into_iter()
            .filter(|d| d.ymd.len() == 10 && d.ymd.starts_with(&prefix))
            .map(|d| {
                ChildEntry::new(
                    d.ymd.clone(),
                    Arc::new(DayProvider { ymd: d.ymd }),
                )
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let name = name.trim();
        if name.len() != 10
            || name.as_bytes().get(4) != Some(&b'-')
            || name.as_bytes().get(7) != Some(&b'-')
        {
            return None;
        }
        let prefix = format!("{}-", self.year_month);
        if !name.starts_with(&prefix) {
            return None;
        }
        let dq = ImageQuery::day_filter(name.to_string());
        if Storage::global().get_images_count_by_query(&dq).ok()? == 0 {
            return None;
        }
        Some(Arc::new(DayProvider { ymd: name.to_string() }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}
