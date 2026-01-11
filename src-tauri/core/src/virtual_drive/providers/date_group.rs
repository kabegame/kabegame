//! 按日期分组 Provider：按年月分组显示图片

use std::sync::Arc;

use super::super::provider::{FsEntry, VirtualFsProvider};
use super::all::AllProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

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

impl VirtualFsProvider for DateGroupProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let groups = storage.get_gallery_date_groups()?;
        Ok(groups
            .into_iter()
            .map(|g| FsEntry::dir(g.year_month))
            .collect())
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        // 验证日期是否存在
        let groups = storage.get_gallery_date_groups().ok()?;
        let date = groups.into_iter().find(|g| g.year_month == name)?;
        Some(Arc::new(DateImagesProvider::new(date.year_month)))
    }
}

/// 单个日期的图片 Provider - 委托给 AllProvider 处理分页
pub struct DateImagesProvider {
    inner: AllProvider,
}

impl DateImagesProvider {
    pub fn new(year_month: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_date(year_month));
        Self { inner }
    }
}

impl VirtualFsProvider for DateImagesProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        self.inner.get_child(storage, name)
    }
}
