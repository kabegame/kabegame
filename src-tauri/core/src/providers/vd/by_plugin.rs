//! VD `byPlugin/`：按插件分组，目录名 `{展示名} - {plugin_id}`。
//! 类型归属：路由壳（i18n 名称翻译 + 委托 shared::PluginProvider）。
//! apply_query：noop。list_images：默认实现。

use std::sync::Arc;

use crate::plugin::PluginManager;
use crate::providers::provider::{ChildEntry, Provider, ProviderMeta};
use crate::providers::shared::plugin::PluginProvider;
use crate::providers::vd::{
    locale::VdLocaleConfig,
    notes::vd_by_plugin_note,
    plugin_names::{resolve_plugin_id_from_dir_name, vd_plugin_dir_name},
};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

pub struct VdByPluginProvider {
    pub cfg: VdLocaleConfig,
}

impl Provider for VdByPluginProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let groups = Storage::global().get_gallery_plugin_groups()?;
        let pm = PluginManager::global();
        Ok(groups
            .into_iter()
            .map(|g| {
                let id = g.plugin_id.clone();
                let name = vd_plugin_dir_name(&id);
                let provider: Arc<dyn Provider> = Arc::new(PluginProvider { plugin_id: id.clone() });
                match pm.get_sync(&id) {
                    Some(p) => ChildEntry::with_meta(name, provider, ProviderMeta::Plugin(p)),
                    None => ChildEntry::new(name, provider),
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let plugin_id = resolve_plugin_id_from_dir_name(name);
        if plugin_id.is_empty() {
            return None;
        }
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        if !groups.iter().any(|g| g.plugin_id.eq_ignore_ascii_case(plugin_id)) {
            return None;
        }
        Some(Arc::new(PluginProvider { plugin_id: plugin_id.to_string() }))
    }

    fn get_note(&self) -> Option<(String, String)> {
        Some(vd_by_plugin_note())
    }
}
