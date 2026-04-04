//! 按任务分组 Provider：按任务 ID 分组显示图片
//!
//! - 根：列出所有“有图片”的任务（目录名=task_id）
//! - 子：`TaskImagesProvider` 委托给 `AllProvider(ImageQuery::by_task)` 做分页/贪心分解

use std::sync::Arc;

use crate::providers::common::CommonProvider;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, VdOpsContext};
use crate::providers::provider::{FsEntry, Provider, ResolveChild};
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

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        // 列出所有任务（不按“是否有图片”过滤）
        let tasks = Storage::global().get_tasks_with_images()?;
        // 这个变量可能mut，随编译目标变化
        #[allow(unused_mut)]
        let mut out: Vec<FsEntry> = tasks
            .into_iter()
            .map(|(id, plugin_id)| {
                #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
                let plugin_name =
                    crate::providers::vd_ops::plugin_display_name_from_manifest(&plugin_id)
                        .unwrap_or_else(|| plugin_id.clone());

                #[cfg(any(kabegame_mode = "light", target_os = "android"))]
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
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            // NOTE: 必须带扩展名，否则某些图片查看器/Explorer 枚举同目录文件时会尝试“打开”该说明文件并弹出错误。
            let display_name = "这里按任务归档图片（目录名含插件名与任务ID，可删除任务目录）.txt";
            let (id, path) =
                crate::providers::vd_ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // name 可能为 "{plugin_name_or_id} - {task_id}"
        let task_id = name
            .rsplit_once(" - ")
            .map(|(_, id)| id)
            .unwrap_or(name)
            .trim();
        if task_id.is_empty() {
            return None;
        }
        // 验证任务存在（不要求有图片）
        if Storage::global().get_task(task_id).ok().flatten().is_none() {
            return None;
        }
        Some(Arc::new(TaskImagesProvider::new(task_id.to_string())))
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // 允许“路径直达”：
        // - VD 的 list() 里通常是 "{plugin_name} - {task_id}"
        // - 但前端（TaskDetail）会直接用纯 taskId 拼路径：`按任务/<taskId>`
        //
        // 因此这里把“纯 taskId”视作 Dynamic child（不会出现在 list 中，也不落持久缓存），
        // 把 "{plugin} - {taskId}" 视作 Listed child（与 list 的语义一致）。
        let (listed, task_id) = match name.rsplit_once(" - ") {
            Some((_, id)) => (true, id.trim()),
            None => (false, name.trim()),
        };
        if task_id.is_empty() {
            return ResolveChild::NotFound;
        }
        if Storage::global().get_task(task_id).ok().flatten().is_none() {
            return ResolveChild::NotFound;
        }
        let child: Arc<dyn Provider> = Arc::new(TaskImagesProvider::new(task_id.to_string()));
        if listed {
            ResolveChild::Listed(child)
        } else {
            ResolveChild::Dynamic(child)
        }
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        let display_name = "这里按任务归档图片（目录名含插件名与任务ID，可删除任务目录）.txt";
        if name != display_name {
            return None;
        }
        crate::providers::vd_ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn delete_child(
        &self,
        child_name: &str,
        kind: DeleteChildKind,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
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
        Storage::global().delete_task(task_id)?;
        ctx.tasks_deleted(task_id);
        Ok(true)
    }
}

/// 单个任务的图片 Provider - 委托给 AllProvider 处理分页
pub struct TaskImagesProvider {
    task_id: String,
    inner: CommonProvider,
}

impl TaskImagesProvider {
    pub fn new(task_id: String) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_task(task_id.clone()));
        Self { task_id, inner }
    }
}

impl Provider for TaskImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_task(self.task_id.clone()),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“按任务\<taskId>”目录中打开文件。
        self.inner.resolve_file(name)
    }

    // 删除任务应由父目录（TaskGroupProvider）负责；这里不实现 delete_child。
}
