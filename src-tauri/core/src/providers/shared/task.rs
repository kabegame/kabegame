//! 按任务分组的共享 provider（shared 底层）。
//!
//! - `TasksProvider`：路由壳；apply_query：noop；list_images：默认实现。
//! - `TaskProvider`：shared 底层；apply_query：with_where(task_id = ?)；list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 任务列表节点（根）。apply_query：noop。
pub struct TasksProvider;

impl Provider for TasksProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let tasks = Storage::global().get_tasks_with_images()?;
        let ids: Vec<String> = tasks.iter().map(|(id, _)| id.clone()).collect();
        let mut meta_map = Storage::global().get_tasks_by_ids(&ids)?;
        Ok(tasks
            .into_iter()
            .map(|(id, _)| {
                let provider: Arc<dyn Provider> = Arc::new(TaskProvider { task_id: id.clone() });
                match meta_map.remove(&id) {
                    Some(t) => ChildEntry::with_meta(id, provider, ProviderMeta::Task(t)),
                    None => ChildEntry::new(id, provider),
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let task_id = name.trim();
        if task_id.is_empty() {
            return None;
        }
        if Storage::global().get_task(task_id).ok()?.is_none() {
            return None;
        }
        Some(Arc::new(TaskProvider { task_id: task_id.to_string() }))
    }
}

/// 单一任务节点。apply_query：with_where(task_id)。list_images：override（最后一页）。
pub struct TaskProvider {
    pub task_id: String,
}

impl Provider for TaskProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_where("images.task_id = ?", vec![self.task_id.clone()])
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        PageSizeGroupProvider.list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        PageSizeGroupProvider.get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        Storage::global().get_task(&self.task_id).ok()?.map(ProviderMeta::Task)
    }
}
