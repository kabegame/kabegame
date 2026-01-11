//! 按插件分组 Provider：按插件ID分组显示图片

use std::sync::Arc;

use super::super::provider::{FsEntry, VirtualFsProvider};
use super::all::AllProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 插件分组列表 Provider - 列出所有插件
#[derive(Clone)]
pub struct PluginGroupProvider;

impl PluginGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualFsProvider for PluginGroupProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let groups = storage.get_gallery_plugin_groups()?;
        Ok(groups
            .into_iter()
            .map(|g| FsEntry::dir(g.plugin_id))
            .collect())
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        // 验证插件是否存在
        let groups = storage.get_gallery_plugin_groups().ok()?;
        let plugin = groups
            .into_iter()
            .find(|g| g.plugin_id.eq_ignore_ascii_case(name))?;
        Some(Arc::new(PluginImagesProvider::new(plugin.plugin_id)))
    }
}

/// 单个插件的图片 Provider - 委托给 AllProvider 处理分页
pub struct PluginImagesProvider {
    inner: AllProvider,
}

impl PluginImagesProvider {
    pub fn new(plugin_id: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_plugin(plugin_id));
        Self { inner }
    }
}

impl VirtualFsProvider for PluginImagesProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        self.inner.get_child(storage, name)
    }
}
