//! Main 路径 `date/YYYY`、`date/YYYY-MM`：列表层为贪心 + 子时间目录；`desc` 子节点为 `CommonProvider` + `PaginationMode::SimplePage`（与 `all/desc` 一致，支持 `.../desc/<page>`）。

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::common::{
    self, CommonProvider, PaginationMode, RangeProvider, SimplePageProvider,
};
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, VdOpsContext};
use crate::providers::descriptor::{DateScopedTier, ProviderDescriptor};
use crate::providers::provider::{FsEntry, Provider, ResolveChild};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// MainProvider：`date/<年>` / `date/<月>` 下的「大目录」聚合视图
#[derive(Clone)]
pub struct MainDateScopedProvider {
    query: ImageQuery,
    tier: DateScopedTier,
}

impl MainDateScopedProvider {
    pub fn from_query_and_tier(query: ImageQuery, tier: DateScopedTier) -> Self {
        Self { query, tier }
    }

    pub fn for_year(year: String) -> Self {
        Self::from_query_and_tier(
            ImageQuery::by_year(year.clone()),
            DateScopedTier::Year { year },
        )
    }

    pub fn for_month(year_month: String) -> Self {
        Self::from_query_and_tier(
            ImageQuery::by_date(year_month.clone()),
            DateScopedTier::YearMonth { year_month },
        )
    }
}

impl Provider for MainDateScopedProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::DateScoped {
            query: self.query.clone(),
            tier: self.tier.clone(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let total = Storage::global().get_images_count_by_query(&self.query)?;
        if total == 0 {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        if self.query.is_ascending() {
            entries.push(FsEntry::dir("desc"));
        }

        match &self.tier {
            DateScopedTier::Year { year } => {
                let groups = Storage::global().get_gallery_date_groups()?;
                let prefix = format!("{year}-");
                for g in groups {
                    if g.year_month.len() == 7 && g.year_month.starts_with(&prefix) {
                        entries.push(FsEntry::dir(g.year_month));
                    }
                }
            }
            DateScopedTier::YearMonth { year_month } => {
                let prefix = format!("{year_month}-");
                let days = Storage::global().get_gallery_day_groups()?;
                for d in days {
                    if d.ymd.len() == 10 && d.ymd.starts_with(&prefix) {
                        entries.push(FsEntry::dir(d.ymd));
                    }
                }
            }
        }

        if total <= common::LEAF_SIZE {
            let files =
                Storage::global().get_images_fs_entries_by_query(&self.query, 0, total)?;
            entries.extend(
                files
                    .into_iter()
                    .map(|e| FsEntry::file(e.file_name, e.image_id, PathBuf::from(e.resolved_path))),
            );
        } else {
            entries.extend(common::list_greedy_subdirs_with_remainder(
                &self.query,
                0,
                total,
            )?);
        }

        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let name = name.trim();

        if name == "desc" && self.query.is_ascending() {
            return Some(Arc::new(CommonProvider::with_query_and_mode(
                self.query.to_desc(),
                PaginationMode::SimplePage,
            )));
        }

        match &self.tier {
            DateScopedTier::Year { year } => {
                if name.len() == 7 && name.as_bytes().get(4) == Some(&b'-') {
                    let groups = Storage::global().get_gallery_date_groups().ok()?;
                    let prefix = format!("{year}-");
                    if name.starts_with(&prefix)
                        && groups.iter().any(|g| g.year_month == name)
                    {
                        return Some(Arc::new(MainDateScopedProvider::for_month(
                            name.to_string(),
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
                                return Some(Arc::new(CommonProvider::with_query_and_mode(
                                    q,
                                    PaginationMode::SimplePage,
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

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // 先解析页码，避免与 `get_child` 中贪心区间等逻辑歧义（与 SimplePage 一致）
        if let Ok(page) = name.parse::<usize>() {
            if page > 0 {
                return ResolveChild::Dynamic(Arc::new(SimplePageProvider::new(
                    self.query.clone(),
                    page,
                )) as Arc<dyn Provider>);
            }
        }
        if let Some(p) = self.get_child(name) {
            return ResolveChild::Dynamic(p);
        }
        ResolveChild::NotFound
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        if image_id.trim().is_empty() {
            return None;
        }
        let resolved = Storage::global().resolve_gallery_image_path(image_id).ok()??;
        Some((image_id.to_string(), PathBuf::from(resolved)))
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn delete_child(
        &self,
        child_name: &str,
        kind: DeleteChildKind,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
    ) -> Result<bool, String> {
        if kind != DeleteChildKind::File {
            return Err("不支持删除该类型".to_string());
        }
        if !crate::providers::vd_ops::query_can_delete_child_file(&self.query) {
            return Err("当前目录不支持删除文件".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        let removed =
            crate::providers::vd_ops::query_delete_child_file(&self.query, child_name)?;
        if removed {
            if let Some(album_id) = crate::providers::vd_ops::album_id_from_query(&self.query) {
                if let Some(name) = Storage::global().get_album_name_by_id(album_id)? {
                    ctx.album_images_removed(album_id, &name);
                }
            }
        }
        Ok(removed)
    }
}
