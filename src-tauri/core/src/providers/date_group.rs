//! 按日期分组 Provider：按年月分组显示图片

use std::sync::Arc;

use crate::providers::all::AllProvider;
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;
use std::path::PathBuf;

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

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let groups = storage.get_gallery_date_groups()?;
        let mut out: Vec<FsEntry> = groups
            .into_iter()
            .map(|g| FsEntry::dir(g.year_month))
            .collect();

        // VD 专用：目录说明文件
        #[cfg(feature = "virtual-drive")]
        {
            let display_name = "这里按抓取时间归档图片（按月份分组）";
            let (id, path) =
                crate::virtual_drive::ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // 验证日期是否存在
        let groups = storage.get_gallery_date_groups().ok()?;
        let date = groups.into_iter().find(|g| g.year_month == name)?;
        Some(Arc::new(DateImagesProvider::new(date.year_month)))
    }

    #[cfg(feature = "virtual-drive")]
    fn resolve_file(&self, _storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里按抓取时间归档图片（按月份分组）";
        if name != display_name {
            return None;
        }
        crate::virtual_drive::ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}

/// 单个日期的图片 Provider - 委托给 AllProvider 处理分页
pub struct DateImagesProvider {
    year_month: String,
    inner: AllProvider,
}

impl DateImagesProvider {
    pub fn new(year_month: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_date(year_month.clone()));
        Self { year_month, inner }
    }
}

impl Provider for DateImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_date(self.year_month.clone()),
        }
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(storage, name)
    }

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按时间\YYYY-MM”目录中打开文件（Explorer 会走 parent.resolve_file）。
        self.inner.resolve_file(storage, name)
    }
}
