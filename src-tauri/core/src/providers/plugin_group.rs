//! 按插件分组 Provider：按插件ID分组显示图片

use std::sync::Arc;

use crate::providers::common::CommonProvider;
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

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let groups = Storage::global().get_gallery_plugin_groups()?;
        // 这个变量可能mut，随编译目标变化
        #[allow(unused_mut)]
        let mut out: Vec<FsEntry> = groups
            .into_iter()
            .map(|g| {
                #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
                let plugin_name =
                    crate::providers::vd_ops::plugin_display_name_from_manifest(&g.plugin_id)
                        .unwrap_or_else(|| String::new());

                #[cfg(any(kabegame_mode = "light", target_os = "android"))]
                let plugin_name = String::new();

                let plugin_name = plugin_name.trim().to_string();
                if plugin_name.is_empty() {
                    FsEntry::dir(g.plugin_id)
                } else {
                    FsEntry::dir(format!("{} - {}", plugin_name, g.plugin_id))
                }
            })
            .collect();

        // VD 专用：目录说明文件
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            // NOTE: 必须带扩展名，否则某些图片查看器/Explorer 枚举同目录文件时会尝试"打开"该说明文件并弹出错误。
            let display_name = "这里记录了不同插件安装的所有图片.txt";
            let (id, path) =
                crate::providers::vd_ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // name 可能为 "{plugin_name} - {plugin_id}" 或纯 plugin_id
        let plugin_id = name
            .rsplit_once(" - ")
            .map(|(_, id)| id)
            .unwrap_or(name)
            .trim();
        if plugin_id.is_empty() {
            return None;
        }
        // 验证插件是否存在
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        let plugin = groups
            .into_iter()
            .find(|g| g.plugin_id.eq_ignore_ascii_case(plugin_id))?;
        Some(Arc::new(PluginImagesProvider::new(plugin.plugin_id)))
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里记录了不同插件安装的所有图片.txt";
        if name != display_name {
            return None;
        }
        crate::providers::vd_ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}

/// 单个插件的图片 Provider - 委托给 AllProvider 处理分页
pub struct PluginImagesProvider {
    plugin_id: String,
    inner: CommonProvider,
}

impl PluginImagesProvider {
    pub fn new(plugin_id: String) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_plugin(plugin_id.clone()));
        Self { plugin_id, inner }
    }
}

impl Provider for PluginImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_plugin(self.plugin_id.clone()),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按插件\<plugin>”目录中打开文件。
        self.inner.resolve_file(name)
    }
}
