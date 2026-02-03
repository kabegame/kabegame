//! 按日期分组 Provider：按年月分组显示图片

use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::provider::ResolveChild;
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;
use std::path::PathBuf;

const DIR_RANGE: &str = "范围";

/// 日期分组列表 Provider - 列出所有年月
#[derive(Clone)]
pub struct DateGroupProvider;

impl DateGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DateGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for DateGroupProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::DateGroup
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let groups = Storage::global().get_gallery_date_groups()?;
        let mut out: Vec<FsEntry> = groups
            .into_iter()
            .map(|g| FsEntry::dir(g.year_month))
            .collect();

        // 额外入口：范围查询（由前端日历组件驱动）
        out.insert(0, FsEntry::dir(DIR_RANGE));

        // VD 专用：目录说明文件
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            // NOTE: 必须带扩展名，否则某些图片查看器/Explorer 枚举同目录文件时会尝试“打开”该说明文件并弹出错误。
            let display_name = "这里按抓取时间归档图片（按月份分组）.txt";
            let (id, path) =
                crate::providers::vd_ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // 范围查询：按 "YYYY-MM-DD~YYYY-MM-DD" 编码在子目录名里
        if name.eq_ignore_ascii_case(DIR_RANGE) {
            return Some(Arc::new(DateRangeRootProvider::new()) as Arc<dyn Provider>);
        }

        // 按月查询：验证日期是否存在
        let groups = Storage::global().get_gallery_date_groups().ok()?;
        let date = groups.into_iter().find(|g| g.year_month == name)?;
        Some(Arc::new(DateImagesProvider::new(date.year_month)))
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里按抓取时间归档图片（按月份分组）.txt";
        if name != display_name {
            return None;
        }
        crate::providers::vd_ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}

/// “范围”根目录：不列出任何月份；由前端直接用 get_child 解析范围字符串
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

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // name: "YYYY-MM-DD~YYYY-MM-DD"
        let Some((start, end)) = parse_range_name(name) else {
            return ResolveChild::NotFound;
        };
        ResolveChild::Dynamic(
            Arc::new(DateRangeImagesProvider::new(start, end)) as Arc<dyn Provider>
        )
    }
}

fn parse_range_name(s: &str) -> Option<(String, String)> {
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
    // 仅做轻量校验：YYYY-MM-DD
    if !start.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !start.as_bytes().get(7).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(7).is_some_and(|c| *c == b'-')
    {
        return None;
    }
    Some((start.to_string(), end.to_string()))
}

/// 日期范围的图片 Provider - 委托给 AllProvider 处理分页
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

/// 单个日期的图片 Provider - 委托给 AllProvider 处理分页
pub struct DateImagesProvider {
    year_month: String,
    inner: CommonProvider,
}

impl DateImagesProvider {
    pub fn new(year_month: String) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_date(year_month.clone()));
        Self { year_month, inner }
    }
}

impl Provider for DateImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_date(self.year_month.clone()),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按时间\YYYY-MM”目录中打开文件（Explorer 会走 parent.resolve_file）。
        self.inner.resolve_file(name)
    }
}
