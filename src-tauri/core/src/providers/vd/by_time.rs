//! VD `byTime/`：按时间归档，年 → 月（i18n）→ 日（i18n）→ 分页。
//! 类型归属：路由壳（i18n 名称翻译层，委托 shared::date::* provider）。
//! apply_query：各层 delegate 对应 shared provider（YearsProvider / YearProvider / MonthProvider）。
//! list_images：各层 delegate 对应 shared provider 的 list_images（最后一页）。

use std::sync::Arc;

use kabegame_i18n::{current_vd_locale, translate_vd_canonical};

use crate::providers::provider::{ChildEntry, ImageEntry, Provider};
use crate::providers::shared::date::{
    day::DayProvider, month::MonthProvider, year::YearProvider, years::YearsProvider,
};
use crate::providers::vd::notes::vd_by_time_note;
use crate::storage::gallery::ImageQuery;

// ── 月/日 i18n 工具（VD byTime 层使用）────────────────────────────────────

/// 月份 canonical keys（1-indexed）
const MONTH_CANONICAL: [&str; 12] = [
    "vd.month.jan", "vd.month.feb", "vd.month.mar",
    "vd.month.apr", "vd.month.may", "vd.month.jun",
    "vd.month.jul", "vd.month.aug", "vd.month.sep",
    "vd.month.oct", "vd.month.nov", "vd.month.dec",
];

fn month_display_name(month: u32) -> String {
    if !(1..=12).contains(&month) {
        return month.to_string();
    }
    let key = MONTH_CANONICAL[(month - 1) as usize];
    translate_vd_canonical(current_vd_locale(), key)
}

fn month_canonical_from_display(name: &str) -> Option<u32> {
    let locale = current_vd_locale();
    for (i, &key) in MONTH_CANONICAL.iter().enumerate() {
        if translate_vd_canonical(locale, key) == name {
            return Some((i + 1) as u32);
        }
    }
    name.parse::<u32>().ok().filter(|&m| (1..=12).contains(&m))
}

fn day_display_name(day: u32) -> String {
    translate_vd_canonical(current_vd_locale(), &format!("vd.day.{day}"))
}

fn day_canonical_from_display(name: &str) -> Option<u32> {
    for d in 1u32..=31 {
        if day_display_name(d) == name {
            return Some(d);
        }
    }
    name.parse::<u32>().ok().filter(|&d| (1..=31).contains(&d))
}

// ── byTime 根（仅列年份）────────────────────────────────────────────────────

pub struct VdByTimeProvider;

impl Provider for VdByTimeProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        YearsProvider.apply_query(current)
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children = YearsProvider.list_children(composed)?;
        // Year names are pure 4-digit, canonical = display; wrap in VdByTimeYearRouter for i18n month nav
        // Show most-recent years first (reverse BTreeSet order)
        Ok(children
            .into_iter()
            .rev()
            .map(|c| {
                let year = c.name.clone();
                ChildEntry::new(year.clone(), Arc::new(VdByTimeYearRouter { year }))
            })
            .collect())
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        // Validate via shared YearsProvider (checks 4-digit + DB existence)
        YearsProvider.get_child(name, composed)?;
        Some(Arc::new(VdByTimeYearRouter { year: name.to_string() }))
    }

    fn get_note(&self) -> Option<(String, String)> {
        Some(vd_by_time_note())
    }
}

// ── 年级（月份子目录 i18n 名）─────────────────────────────────────────────

struct VdByTimeYearRouter {
    year: String,
}

impl Provider for VdByTimeYearRouter {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        YearProvider { year: self.year.clone() }.apply_query(current)
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children = YearProvider { year: self.year.clone() }.list_children(composed)?;
        // children have canonical names "YYYY-MM"; translate to i18n month display names, desc
        Ok(children
            .into_iter()
            .rev()
            .filter_map(|c| {
                // c.name is "YYYY-MM"; extract month number from position 5..
                let month_num: u32 = c.name.get(5..)?.parse().ok()?;
                let display = month_display_name(month_num);
                Some(ChildEntry::new(
                    display,
                    Arc::new(VdByTimeMonthRouter { year_month: c.name }),
                ))
            })
            .collect())
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        // name is i18n month display name → reverse-lookup to canonical month number
        let month_num = month_canonical_from_display(name)?;
        let ym = format!("{}-{:02}", self.year, month_num);
        // Validate existence via shared YearProvider
        YearProvider { year: self.year.clone() }.get_child(&ym, composed)?;
        Some(Arc::new(VdByTimeMonthRouter { year_month: ym }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        YearProvider { year: self.year.clone() }.list_images(composed)
    }
}

// ── 月级（日期子目录 i18n 名）─────────────────────────────────────────────

struct VdByTimeMonthRouter {
    year_month: String, // YYYY-MM
}

impl Provider for VdByTimeMonthRouter {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        MonthProvider { year_month: self.year_month.clone() }.apply_query(current)
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children = MonthProvider { year_month: self.year_month.clone() }.list_children(composed)?;
        // children have canonical names "YYYY-MM-DD"; translate to i18n day display names, desc
        Ok(children
            .into_iter()
            .rev()
            .filter_map(|c| {
                // c.name is "YYYY-MM-DD"; extract day number from position 8..
                let day_num: u32 = c.name.get(8..)?.parse().ok()?;
                let display = day_display_name(day_num);
                // Day-level provider is shared DayProvider (handles its own pagination)
                Some(ChildEntry::new(display, Arc::new(DayProvider { ymd: c.name })))
            })
            .collect())
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        // name is i18n day display name → reverse-lookup to canonical day number
        let day_num = day_canonical_from_display(name)?;
        let ymd = format!("{}-{:02}", self.year_month, day_num);
        // Validate existence via shared MonthProvider
        MonthProvider { year_month: self.year_month.clone() }.get_child(&ymd, composed)?;
        Some(Arc::new(DayProvider { ymd }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        MonthProvider { year_month: self.year_month.clone() }.list_images(composed)
    }
}
