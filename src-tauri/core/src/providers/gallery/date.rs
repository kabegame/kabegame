//! Gallery 日期层级路由壳（date/ → YYYYy → MMm → DDd）。
//! 类型归属：路由壳（日期层级）。
//! apply_query：prepend crawled_at ASC（根）/ merge year_filter / merge date_filter。
//! list_images：override（委托 QueryPageProvider 取最后一页）；年/月级 desc/ = SortProvider。

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::{
    date::day::DayProvider, page_size::PageSizeGroupProvider, sort::SortProvider,
};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

// ── 年份根 ────────────────────────────────────────────────────────────────────

/// `gallery/date/`：按年份分组根节点。apply_query：prepend crawled_at ASC。
/// 子目录命名 `YYYYy`（如 `2025y`），与前端 `serializeFilter` 分层编码同构。
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
            .map(|y| {
                ChildEntry::new(
                    format!("{y}y"),
                    Arc::new(GalleryDateYearProvider { year: y }),
                )
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let year = parse_year_segment(name)?;
        let q = ImageQuery::year_filter(year.clone());
        if Storage::global().get_images_count_by_query(&q).ok()? == 0 {
            return None;
        }
        Some(Arc::new(GalleryDateYearProvider { year }))
    }
}

// ── 年份节点 ──────────────────────────────────────────────────────────────────

/// `gallery/date/YYYYy/`：年份节点。apply_query：merge(year_filter)。
/// list_children：desc/ + 月份子节点（名 `MMm`）。list_images：override（最后一页）。
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
                let mm = g.year_month[5..7].to_string();
                children.push(ChildEntry::new(
                    format!("{mm}m"),
                    Arc::new(GalleryDateMonthProvider { year_month: g.year_month }),
                ));
            }
        }
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryDateYearProvider {
                year: self.year.clone(),
            }))));
        }
        if let Some(mm) = parse_month_segment(name) {
            let year_month = format!("{}-{}", self.year, mm);
            let groups = Storage::global().get_gallery_date_groups().ok()?;
            if !groups.iter().any(|g| g.year_month == year_month) {
                return None;
            }
            return Some(Arc::new(GalleryDateMonthProvider { year_month }));
        }
        // 「全年」翻页：date/YYYYy/<page> 或 date/YYYYy/x{n}x/<page>
        PageSizeGroupProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}

// ── 月份节点 ──────────────────────────────────────────────────────────────────

/// `gallery/date/YYYYy/MMm/`：月份节点。apply_query：merge(date_filter)。
/// list_children：desc/ + 日期子节点（名 `DDd`）。list_images：override（最后一页）。
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
                let dd = d.ymd[8..10].to_string();
                children.push(ChildEntry::new(
                    format!("{dd}d"),
                    Arc::new(DayProvider { ymd: d.ymd }),
                ));
            }
        }
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryDateMonthProvider {
                year_month: self.year_month.clone(),
            }))));
        }
        if let Some(dd) = parse_day_segment(name) {
            let ymd = format!("{}-{}", self.year_month, dd);
            let dq = ImageQuery::day_filter(ymd.clone());
            if Storage::global().get_images_count_by_query(&dq).ok()? == 0 {
                return None;
            }
            return Some(Arc::new(DayProvider { ymd }));
        }
        // 「全月」翻页：date/YYYYy/MMm/<page> 或 date/YYYYy/MMm/x{n}x/<page>
        PageSizeGroupProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }
}

// ── 分层段解析 ────────────────────────────────────────────────────────────────

/// `YYYYy` → `YYYY`
fn parse_year_segment(name: &str) -> Option<String> {
    let s = name.trim();
    if s.len() != 5 || !s.ends_with('y') {
        return None;
    }
    let y = &s[..4];
    if !y.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(y.to_string())
}

/// `MMm` → `MM`
fn parse_month_segment(name: &str) -> Option<String> {
    let s = name.trim();
    if s.len() != 3 || !s.ends_with('m') {
        return None;
    }
    let mm = &s[..2];
    if !mm.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(mm.to_string())
}

/// `DDd` → `DD`
fn parse_day_segment(name: &str) -> Option<String> {
    let s = name.trim();
    if s.len() != 3 || !s.ends_with('d') {
        return None;
    }
    let dd = &s[..2];
    if !dd.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(dd.to_string())
}
