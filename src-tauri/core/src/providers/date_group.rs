//! VD「按时间」与「范围」子树；时间层级与 `main_date_browse` / `MainDateScopedProvider` 一致（年→月→日），不再单独按月平铺。

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::main_date_browse::{list_main_date_browse_root_entries, main_date_child_provider};
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
const VD_DATE_NOTE_NAME: &str = "这里按抓取时间归档图片（年→月→日，与画廊一致）.txt";

/// 虚拟盘「按时间」根：年份目录 +「范围」+ 说明文件（与 Main `date/` 同源，见 `main_date_browse`）。
#[derive(Clone, Default)]
pub struct VdByDateProvider;

impl VdByDateProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Provider for VdByDateProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::DateGroup
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let mut out = list_main_date_browse_root_entries()?;
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            let display_name = VD_DATE_NOTE_NAME;
            let (id, path) =
                crate::providers::vd_ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }
        Ok(out)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        main_date_child_provider(name)
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        let display_name = VD_DATE_NOTE_NAME;
        if name != display_name {
            return None;
        }
        crate::providers::vd_ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}

/// “范围”根目录：不列出任何月份；由前端 / 路径直接用 `get_child` 解析范围字符串
#[derive(Clone, Default)]
pub struct DateRangeRootProvider;

impl DateRangeRootProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Provider for DateRangeRootProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::DateRangeRoot
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![])
    }

    fn resolve_child(&self, name: &str) -> crate::providers::provider::ResolveChild {
        let Some((start, end)) = parse_range_name(name) else {
            return crate::providers::provider::ResolveChild::NotFound;
        };
        crate::providers::provider::ResolveChild::Dynamic(
            Arc::new(DateRangeImagesProvider::new(start, end)) as Arc<dyn Provider>
        )
    }
}

pub(crate) fn parse_range_name(s: &str) -> Option<(String, String)> {
    let raw = s.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('~').collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parts[0].trim();
    let end = parts[1].trim();
    if start.len() != 10 || end.len() != 10 {
        return None;
    }
    if !start.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !start.as_bytes().get(7).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(7).is_some_and(|c| *c == b'-')
    {
        return None;
    }
    Some((start.to_string(), end.to_string()))
}

/// 日期范围的图片 Provider
pub struct DateRangeImagesProvider {
    start_ymd: String,
    end_ymd: String,
    inner: CommonProvider,
}

impl DateRangeImagesProvider {
    pub fn new(start_ymd: String, end_ymd: String) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_date_range(
            start_ymd.clone(),
            end_ymd.clone(),
        ));
        Self {
            start_ymd,
            end_ymd,
            inner,
        }
    }
}

impl Provider for DateRangeImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_date_range(self.start_ymd.clone(), self.end_ymd.clone()),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        self.inner.resolve_file(name)
    }
}
