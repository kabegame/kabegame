//! Main / VD 共用的「按时间」浏览：根目录为**年份**列表，子级为 `MainDateScopedProvider`（年→月→日），与画廊 `date/*` 路径一致。

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::providers::common::{CommonProvider, PaginationMode};
use crate::providers::main_date_scoped::MainDateScopedProvider;
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 从 `get_gallery_date_groups()` 派生 distinct 年份，早→晚。
pub(crate) fn gallery_distinct_years() -> Result<Vec<String>, String> {
    let groups = Storage::global().get_gallery_date_groups()?;
    let set: BTreeSet<String> = groups
        .into_iter()
        .filter_map(|g| {
            if g.year_month.len() >= 4 {
                Some(g.year_month[..4].to_string())
            } else {
                None
            }
        })
        .collect();
    Ok(set.into_iter().collect())
}

/// `date/` 与 VD「按时间」根目录：仅年份文件夹。
pub(crate) fn list_main_date_browse_root_entries() -> Result<Vec<FsEntry>, String> {
    let years = gallery_distinct_years()?;
    Ok(years.into_iter().map(FsEntry::dir).collect())
}

/// `date/<name>` / `按时间/<name>`：`YYYY` / `YYYY-MM` / `YYYY-MM-DD` → 年 / 月 / 日粒度（与画廊路径一致）。
pub(crate) fn main_date_child_provider(name: &str) -> Option<Arc<dyn Provider>> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    let b = name.as_bytes();

    // YYYY-MM-DD
    if name.len() == 10 && b.get(4) == Some(&b'-') && b.get(7) == Some(&b'-') {
        let q = ImageQuery::by_date_day(name.to_string());
        if Storage::global().get_images_count_by_query(&q).ok()? == 0 {
            return None;
        }
        return Some(Arc::new(CommonProvider::with_query_and_mode(
            q,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>);
    }

    // YYYY-MM
    if name.len() == 7 && b.get(4) == Some(&b'-') {
        let groups = Storage::global().get_gallery_date_groups().ok()?;
        let exists = groups.iter().any(|g| g.year_month == name);
        if !exists {
            return None;
        }
        return Some(Arc::new(MainDateScopedProvider::for_month(
            name.to_string(),
        )) as Arc<dyn Provider>);
    }

    // YYYY
    if name.len() == 4 && name.chars().all(|c| c.is_ascii_digit()) {
        let q = ImageQuery::by_year(name.to_string());
        if Storage::global().get_images_count_by_query(&q).ok()? == 0 {
            return None;
        }
        return Some(Arc::new(MainDateScopedProvider::for_year(
            name.to_string(),
        )) as Arc<dyn Provider>);
    }

    None
}
