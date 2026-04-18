//! Gallery 日期层级路由壳（date/ → 年 → 月 → 日）。
//! 类型归属：路由壳（日期层级）。
//! apply_query：prepend crawled_at ASC（根）/ merge year_filter / merge date_filter。
//! list_images：override（委托 QueryPageProvider 取最后一页）；年/月级 desc/ = SortProvider。

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::{
    date::day::DayProvider, query_page::QueryPageProvider, sort::SortProvider,
};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

// ── 年份根 ────────────────────────────────────────────────────────────────────

/// `gallery/date/`：按年份分组根节点。apply_query：prepend crawled_at ASC。
pub struct GalleryDateGroupProvider;

impl Provider for GalleryDateGroupProvider {
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
            .map(|y| ChildEntry::new(y.clone(), Arc::new(GalleryDateYearProvider { year: y })))
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
        Some(Arc::new(GalleryDateYearProvider { year: name.to_string() }))
    }
}

// ── 年份节点 ──────────────────────────────────────────────────────────────────

/// `gallery/date/YYYY/`：年份节点。apply_query：merge(year_filter)。
/// list_children：desc/ + 月份子节点。list_images：override（最后一页）。
struct GalleryDateYearProvider {
    year: String,
}

impl Provider for GalleryDateYearProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::year_filter(self.year.clone()))
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children = vec![ChildEntry::new(
            "desc",
            Arc::new(SortProvider::new(Arc::new(GalleryDateYearProvider {
                year: self.year.clone(),
            }))),
        )];
        let groups = Storage::global().get_gallery_date_groups()?;
        let prefix = format!("{}-", self.year);
        for g in groups {
            if g.year_month.len() == 7 && g.year_month.starts_with(&prefix) {
                let ym = g.year_month.clone();
                children.push(ChildEntry::new(
                    ym.clone(),
                    Arc::new(GalleryDateMonthProvider { year_month: ym }),
                ));
            }
        }
        Ok(children)
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryDateYearProvider {
                year: self.year.clone(),
            }))));
        }
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
        Some(Arc::new(GalleryDateMonthProvider { year_month: name.to_string() }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}

// ── 月份节点 ──────────────────────────────────────────────────────────────────

/// `gallery/date/YYYY-MM/`：月份节点。apply_query：merge(date_filter)。
/// list_children：desc/ + 日期子节点。list_images：override（最后一页）。
struct GalleryDateMonthProvider {
    year_month: String,
}

impl Provider for GalleryDateMonthProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::date_filter(self.year_month.clone()))
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children = vec![ChildEntry::new(
            "desc",
            Arc::new(SortProvider::new(Arc::new(GalleryDateMonthProvider {
                year_month: self.year_month.clone(),
            }))),
        )];
        let prefix = format!("{}-", self.year_month);
        let days = Storage::global().get_gallery_day_groups()?;
        for d in days {
            if d.ymd.len() == 10 && d.ymd.starts_with(&prefix) {
                let ymd = d.ymd.clone();
                children.push(ChildEntry::new(
                    ymd.clone(),
                    Arc::new(DayProvider { ymd }),
                ));
            }
        }
        Ok(children)
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryDateMonthProvider {
                year_month: self.year_month.clone(),
            }))));
        }
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
        QueryPageProvider::root().list_images(composed)
    }
}
