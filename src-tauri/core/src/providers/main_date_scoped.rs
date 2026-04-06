//! Main 路径 `date/YYYY`、`date/YYYY-MM`：列表层为贪心 + 子时间目录；
//! `desc` 子节点为 `CommonProvider` + `PaginationMode::SimplePage`。

use std::sync::Arc;

use crate::providers::common::{self, CommonProvider, PaginationMode, RangeProvider, SimplePageProvider};
use crate::providers::config::ProviderConfig;
use crate::providers::descriptor::{DateScopedTier, ProviderDescriptor};
use crate::providers::provider::{ListEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

#[derive(Clone)]
pub struct MainDateScopedProvider {
    query: ImageQuery,
    tier: DateScopedTier,
    config: ProviderConfig,
}

impl MainDateScopedProvider {
    pub fn from_query_and_tier(query: ImageQuery, tier: DateScopedTier, config: ProviderConfig) -> Self {
        Self { query, tier, config }
    }

    pub fn for_year(year: String, config: ProviderConfig) -> Self {
        Self::from_query_and_tier(
            ImageQuery::by_year(year.clone()),
            DateScopedTier::Year { year },
            config,
        )
    }

    pub fn for_month(year_month: String, config: ProviderConfig) -> Self {
        Self::from_query_and_tier(
            ImageQuery::by_date(year_month.clone()),
            DateScopedTier::YearMonth { year_month },
            config,
        )
    }

    fn simple_page_config(&self) -> ProviderConfig {
        ProviderConfig {
            pagination_mode: PaginationMode::SimplePage,
            ..self.config
        }
    }
}

impl Provider for MainDateScopedProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::DateScoped {
            query: self.query.clone(),
            tier: self.tier.clone(),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let total = Storage::global().get_images_count_by_query(&self.query)?;
        if total == 0 {
            return Ok(Vec::new());
        }

        let mut entries: Vec<ListEntry> = Vec::new();
        if self.query.is_ascending() {
            entries.push(ListEntry::Child {
                name: self.config.display_name("desc"),
                provider: Arc::new(CommonProvider::with_query_and_config(
                    self.query.to_desc(),
                    self.simple_page_config(),
                )),
            });
        }

        match &self.tier {
            DateScopedTier::Year { year } => {
                let groups = Storage::global().get_gallery_date_groups()?;
                let prefix = format!("{year}-");
                for g in groups {
                    if g.year_month.len() == 7 && g.year_month.starts_with(&prefix) {
                        entries.push(ListEntry::Child {
                            name: g.year_month.clone(),
                            provider: Arc::new(MainDateScopedProvider::for_month(
                                g.year_month,
                                self.config,
                            )),
                        });
                    }
                }
            }
            DateScopedTier::YearMonth { year_month } => {
                let prefix = format!("{year_month}-");
                let days = Storage::global().get_gallery_day_groups()?;
                for d in days {
                    if d.ymd.len() == 10 && d.ymd.starts_with(&prefix) {
                        let q = ImageQuery::by_date_day(d.ymd.clone());
                        if Storage::global().get_images_count_by_query(&q)? > 0 {
                            entries.push(ListEntry::Child {
                                name: d.ymd,
                                provider: Arc::new(CommonProvider::with_query_and_config(
                                    q,
                                    self.simple_page_config(),
                                )),
                            });
                        }
                    }
                }
            }
        }

        if total <= common::LEAF_SIZE {
            let images = Storage::global().get_image_entries_by_query(&self.query, 0, total)?;
            entries.extend(images.into_iter().map(ListEntry::Image));
        } else {
            let ranges = {
                let mut out = Vec::new();
                let mut pos = 0usize;
                let mut size = common::LEAF_SIZE;
                let mut sizes = Vec::new();
                while size <= total {
                    sizes.push(size);
                    size *= 10;
                }
                sizes.reverse();
                for s in sizes {
                    if s == total {
                        continue;
                    }
                    while pos + s <= total {
                        out.push((pos, s));
                        pos += s;
                    }
                }
                out
            };
            for (offset, count) in &ranges {
                entries.push(ListEntry::Child {
                    name: format!("{}-{}", offset + 1, offset + count),
                    provider: Arc::new(RangeProvider::new(
                        self.query.clone(),
                        *offset,
                        *count,
                        common::calc_depth_for_size(*count),
                    )),
                });
            }
            let covered: usize = ranges.iter().map(|(_, c)| c).sum();
            let remainder = total.saturating_sub(covered);
            if remainder > 0 {
                let images = Storage::global().get_image_entries_by_query(
                    &self.query,
                    covered,
                    remainder,
                )?;
                entries.extend(images.into_iter().map(ListEntry::Image));
            }
        }

        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let name = name.trim();
        if let Ok(page) = name.parse::<usize>() {
            if page > 0 {
                return Some(Arc::new(SimplePageProvider::new(self.query.clone(), page)));
            }
        }

        if self.config.canonical_name(name) == "desc" && self.query.is_ascending() {
            return Some(Arc::new(CommonProvider::with_query_and_config(
                self.query.to_desc(),
                self.simple_page_config(),
            )));
        }

        match &self.tier {
            DateScopedTier::Year { year } => {
                if name.len() == 7 && name.as_bytes().get(4) == Some(&b'-') {
                    let groups = Storage::global().get_gallery_date_groups().ok()?;
                    let prefix = format!("{year}-");
                    if name.starts_with(&prefix) && groups.iter().any(|g| g.year_month == name) {
                        return Some(Arc::new(MainDateScopedProvider::for_month(
                            name.to_string(),
                            self.config,
                        )));
                    }
                }
            }
            DateScopedTier::YearMonth { year_month } => {
                if name.len() == 10
                    && name.as_bytes().get(4) == Some(&b'-')
                    && name.as_bytes().get(7) == Some(&b'-')
                {
                    let prefix = format!("{year_month}-");
                    if name.starts_with(&prefix) {
                        let days = Storage::global().get_gallery_day_groups().ok()?;
                        if days.iter().any(|d| d.ymd == name) {
                            let q = ImageQuery::by_date_day(name.to_string());
                            if Storage::global().get_images_count_by_query(&q).ok()? > 0 {
                                return Some(Arc::new(CommonProvider::with_query_and_config(
                                    q,
                                    self.simple_page_config(),
                                )));
                            }
                        }
                    }
                }
            }
        }

        let total = Storage::global().get_images_count_by_query(&self.query).ok()?;
        if total == 0 || total <= common::LEAF_SIZE {
            return None;
        }
        let (offset, count) = common::parse_range(name)?;
        if !common::validate_greedy_range(offset, count, total) {
            return None;
        }
        let depth = common::calc_depth_for_size(count);
        Some(Arc::new(RangeProvider::new(
            self.query.clone(),
            offset,
            count,
            depth,
        )))
    }
}
