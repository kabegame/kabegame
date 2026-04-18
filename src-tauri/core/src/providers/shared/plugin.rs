//! 按插件分组的共享 provider（shared 底层）。
//!
//! - `PluginsProvider`：路由壳；apply_query：noop；list_images：默认实现。
//! - `PluginProvider`：shared 底层；apply_query：with_where(plugin_id = ?)；list_images：override（最后一页）。

use std::sync::Arc;

use crate::plugin::PluginManager;
use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::query_page::QueryPageProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 插件列表节点（根）。apply_query：noop。
pub struct PluginsProvider;

impl Provider for PluginsProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let groups = Storage::global().get_gallery_plugin_groups()?;
        let pm = PluginManager::global();
        Ok(groups
            .into_iter()
            .map(|g| {
                let id = g.plugin_id.clone();
                let provider: Arc<dyn Provider> = Arc::new(PluginProvider { plugin_id: id.clone() });
                match pm.get_sync(&id) {
                    Some(p) => ChildEntry::with_meta(g.plugin_id, provider, ProviderMeta::Plugin(p)),
                    None => ChildEntry::new(g.plugin_id, provider),
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let plugin_id = name.trim();
        if plugin_id.is_empty() {
            return None;
        }
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        if !groups.iter().any(|g| g.plugin_id.eq_ignore_ascii_case(plugin_id)) {
            return None;
        }
        Some(Arc::new(PluginProvider { plugin_id: plugin_id.to_string() }))
    }
}

/// 单一插件节点。apply_query：with_where(plugin_id)。list_images：override（最后一页）。
pub struct PluginProvider {
    pub plugin_id: String,
}

impl Provider for PluginProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_where("images.plugin_id = ?", vec![self.plugin_id.clone()])
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        QueryPageProvider::root().list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        PluginManager::global().get_sync(&self.plugin_id).map(ProviderMeta::Plugin)
    }
}
