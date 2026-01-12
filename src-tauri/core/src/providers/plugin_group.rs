//! 按插件分组 Provider：按插件ID分组显示图片

use std::sync::Arc;

use crate::providers::all::AllProvider;
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;
use std::path::PathBuf;

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

impl Provider for PluginGroupProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::PluginGroup
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let groups = storage.get_gallery_plugin_groups()?;
        let mut out: Vec<FsEntry> = groups
            .into_iter()
            .map(|g| FsEntry::dir(g.plugin_id))
            .collect();

        // VD 专用：目录说明文件
        #[cfg(feature = "virtual-drive")]
        {
            let display_name = "这里记录了不同插件安装的所有图片";
            let (id, path) =
                crate::virtual_drive::ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // 验证插件是否存在
        let groups = storage.get_gallery_plugin_groups().ok()?;
        let plugin = groups
            .into_iter()
            .find(|g| g.plugin_id.eq_ignore_ascii_case(name))?;
        Some(Arc::new(PluginImagesProvider::new(plugin.plugin_id)))
    }

    #[cfg(feature = "virtual-drive")]
    fn resolve_file(&self, _storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里记录了不同插件安装的所有图片";
        if name != display_name {
            return None;
        }
        crate::virtual_drive::ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}

/// 单个插件的图片 Provider - 委托给 AllProvider 处理分页
pub struct PluginImagesProvider {
    plugin_id: String,
    inner: AllProvider,
}

impl PluginImagesProvider {
    pub fn new(plugin_id: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_plugin(plugin_id.clone()));
        Self { plugin_id, inner }
    }
}

impl Provider for PluginImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_plugin(self.plugin_id.clone()),
        }
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(storage, name)
    }

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按插件\<plugin>”目录中打开文件。
        self.inner.resolve_file(storage, name)
    }
}
