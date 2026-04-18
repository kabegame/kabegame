//! VD `byTask/`：按任务分组，目录名 `{插件展示名} - {task_id}`。
//! 类型归属：路由壳（i18n 名称翻译 + 委托 shared::TaskProvider）。
//! apply_query：noop。list_images：默认实现。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider, ProviderMeta};
use crate::providers::shared::task::TaskProvider;
use crate::providers::vd::{
    locale::VdLocaleConfig,
    notes::vd_by_task_note,
    plugin_names::{resolve_task_id_from_dir_name, vd_task_dir_name},
};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

pub struct VdByTaskProvider {
    pub cfg: VdLocaleConfig,
}

impl Provider for VdByTaskProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let tasks = Storage::global().get_tasks_with_images()?;
        let ids: Vec<String> = tasks.iter().map(|(id, _)| id.clone()).collect();
        let mut meta_map = Storage::global().get_tasks_by_ids(&ids)?;
        Ok(tasks
            .into_iter()
            .map(|(id, plugin_id)| {
                let name = vd_task_dir_name(&id, &plugin_id);
                let provider: Arc<dyn Provider> = Arc::new(TaskProvider { task_id: id.clone() });
                match meta_map.remove(&id) {
                    Some(t) => ChildEntry::with_meta(name, provider, ProviderMeta::Task(t)),
                    None => ChildEntry::new(name, provider),
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let task_id = resolve_task_id_from_dir_name(name);
        if task_id.is_empty() {
            return None;
        }
        if Storage::global().get_task(task_id).ok()?.is_none() {
            return None;
        }
        Some(Arc::new(TaskProvider { task_id: task_id.to_string() }))
    }

    fn get_note(&self) -> Option<(String, String)> {
        Some(vd_by_task_note())
    }
}
