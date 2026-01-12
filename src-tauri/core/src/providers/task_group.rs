//! 按任务分组 Provider：按任务 ID 分组显示图片
//!
//! - 根：列出所有“有图片”的任务（目录名=task_id）
//! - 子：`TaskImagesProvider` 委托给 `AllProvider(ImageQuery::by_task)` 做分页/贪心分解

use std::sync::Arc;

use crate::providers::all::AllProvider;
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;
use std::path::PathBuf;

/// 任务分组列表 Provider - 列出所有任务
#[derive(Clone)]
pub struct TaskGroupProvider;

impl TaskGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TaskGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for TaskGroupProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::TaskGroup
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        // 只列出“有图片”的任务，避免出现大量空目录
        let tasks = storage.get_tasks_with_images()?;
        let mut out: Vec<FsEntry> = tasks
            .into_iter()
            .map(|(id, plugin_id)| {
                #[cfg(feature = "virtual-drive")]
                let plugin_name =
                    crate::virtual_drive::ops::plugin_display_name_from_manifest(&plugin_id)
                        .unwrap_or_else(|| plugin_id.clone());

                #[cfg(not(feature = "virtual-drive"))]
                let plugin_name = plugin_id;

                let plugin_name = plugin_name.trim().to_string();
                if plugin_name.is_empty() {
                    FsEntry::dir(id)
                } else {
                    FsEntry::dir(format!("{} - {}", plugin_name, id))
                }
            })
            .collect();

        // VD 专用：目录说明文件（说明在文件名里）
        #[cfg(feature = "virtual-drive")]
        {
            let display_name = "这里按任务归档图片（目录名含插件名与任务ID，可删除任务目录）";
            let (id, path) =
                crate::virtual_drive::ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // name 可能为 "{plugin_name_or_id} - {task_id}"
        let task_id = name
            .rsplit_once(" - ")
            .map(|(_, id)| id)
            .unwrap_or(name)
            .trim();
        if task_id.is_empty() {
            return None;
        }
        // 验证任务存在（且仍有图片）
        let ok = storage.get_task(task_id).ok().flatten().is_some()
            && storage
                .get_task_image_ids(task_id)
                .map(|ids| !ids.is_empty())
                .unwrap_or(false);
        if !ok {
            return None;
        }
        Some(Arc::new(TaskImagesProvider::new(task_id.to_string())))
    }

    #[cfg(feature = "virtual-drive")]
    fn resolve_file(&self, _storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里按任务归档图片（目录名含插件名与任务ID，可删除任务目录）";
        if name != display_name {
            return None;
        }
        crate::virtual_drive::ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }

    #[cfg(feature = "virtual-drive")]
    fn delete_child(
        &self,
        storage: &Storage,
        child_name: &str,
        kind: DeleteChildKind,
        mode: DeleteChildMode,
        ctx: &dyn crate::providers::provider::VdOpsContext,
    ) -> Result<bool, String> {
        if kind != DeleteChildKind::Directory {
            return Err("不支持删除该类型".to_string());
        }
        let task_id = child_name
            .rsplit_once(" - ")
            .map(|(_, id)| id)
            .unwrap_or(child_name)
            .trim();
        if task_id.is_empty() {
            return Err("任务ID不能为空".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        storage.delete_task(task_id)?;
        ctx.tasks_deleted(task_id);
        Ok(true)
    }
}

/// 单个任务的图片 Provider - 委托给 AllProvider 处理分页
pub struct TaskImagesProvider {
    task_id: String,
    inner: AllProvider,
}

impl TaskImagesProvider {
    pub fn new(task_id: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_task(task_id.clone()));
        Self { task_id, inner }
    }
}

impl Provider for TaskImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_task(self.task_id.clone()),
        }
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(storage, name)
    }

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按任务\<taskId>”目录中打开文件。
        self.inner.resolve_file(storage, name)
    }

    // 删除任务应由父目录（TaskGroupProvider）负责；这里不实现 delete_child。
}
