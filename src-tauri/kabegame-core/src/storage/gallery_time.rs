//! 抓取时间分组索引：以「自然日」为唯一数据源，派生「月」汇总（与画廊/VD/Main `date/*` 共用）。
//!
//! 月列表不再单独查询 SQL，而是由 `DayGroup` 聚合得到，保证与年/月/日树一致。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::gallery::{DateGroup, DayGroup};

/// 由日分组列表聚合出「月」分组（唯一数据源为日计数）。
pub fn gallery_month_groups_from_days(days: &[DayGroup]) -> Vec<DateGroup> {
    let mut by_ym: BTreeMap<String, usize> = BTreeMap::new();
    for d in days {
        if d.ymd.len() >= 7 {
            let ym = d.ymd[..7].to_string();
            *by_ym.entry(ym).or_insert(0) += d.count;
        }
    }
    by_ym
        .into_iter()
        .rev()
        .map(|(year_month, count)| DateGroup { year_month, count })
        .collect()
}

/// 供前端一次拉取：月（派生）+ 日（原始）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryTimeFilterPayload {
    pub months: Vec<DateGroup>,
    pub days: Vec<DayGroup>,
}

/// 基于日粒度列表的索引，可派生月列表并做存在性校验。
#[derive(Debug, Clone, Default)]
pub struct GalleryTimeGroupIndex {
    days: Vec<DayGroup>,
}

impl GalleryTimeGroupIndex {
    pub fn from_days(days: Vec<DayGroup>) -> Self {
        Self { days }
    }

    /// 与历史上按 `strftime('%Y-%m', ...) GROUP BY` 语义一致：每月 count 为所属各自然日 count 之和。
    pub fn months(&self) -> Vec<DateGroup> {
        gallery_month_groups_from_days(&self.days)
    }

    pub fn has_month(&self, ym: &str) -> bool {
        self.days
            .iter()
            .any(|d| d.ymd.len() >= 7 && &d.ymd[..7] == ym)
    }

    pub fn has_day(&self, ymd: &str) -> bool {
        self.days.iter().any(|d| d.ymd == ymd)
    }

    pub fn days(&self) -> &[DayGroup] {
        &self.days
    }

    pub fn into_days(self) -> Vec<DayGroup> {
        self.days
    }
}

impl GalleryTimeFilterPayload {
    pub fn from_storage_days(days: Vec<DayGroup>) -> Self {
        let months = gallery_month_groups_from_days(&days);
        Self { months, days }
    }
}
