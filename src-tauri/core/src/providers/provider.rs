//! 虚拟文件系统 Provider trait 和相关类型（核心可复用部分）。
//!
//! 设计原则：
//! - Provider 对路径完全无感知
//! - 每个 Provider 只返回自己的内容（子目录或文件）
//! - 子目录通过 `get_child(name)` 获取对应的子 Provider
//! - 路径解析由外层框架（virtual_drive / gallery_browse）递归处理

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::descriptor::ProviderDescriptor;
use crate::storage::Storage;

/// 虚拟文件系统条目（用于 list 返回）
#[derive(Debug, Clone)]
pub enum FsEntry {
    /// 目录条目（只有名字，子 Provider 通过 get_child 获取）
    Directory { name: String },
    /// 文件条目
    File {
        name: String,
        #[allow(dead_code)]
        image_id: String,
        resolved_path: PathBuf,
    },
}

impl FsEntry {
    pub fn name(&self) -> &str {
        match self {
            FsEntry::Directory { name } => name,
            FsEntry::File { name, .. } => name,
        }
    }

    #[allow(dead_code)]
    pub fn is_directory(&self) -> bool {
        matches!(self, FsEntry::Directory { .. })
    }

    /// 创建目录条目
    pub fn dir(name: impl Into<String>) -> Self {
        FsEntry::Directory { name: name.into() }
    }

    /// 创建文件条目
    pub fn file(name: impl Into<String>, image_id: impl Into<String>, path: PathBuf) -> Self {
        FsEntry::File {
            name: name.into(),
            image_id: image_id.into(),
            resolved_path: path,
        }
    }
}

/// Provider trait - 对路径完全无感知
///
/// 每个 Provider 实现两个核心方法：
/// - `list()`: 列出当前目录下的所有条目
/// - `get_child(name)`: 获取指定名称的子 Provider（用于目录递归）
pub trait Provider: Send + Sync {
    /// 持久化描述符：用于缓存/重建 Provider（RocksDB）
    fn descriptor(&self) -> ProviderDescriptor;

    /// 列出该 Provider 下的所有条目
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String>;

    /// 获取指定名称的子 Provider
    /// 默认返回 None，表示不支持子目录
    fn get_child(&self, _storage: &Storage, _name: &str) -> Option<Arc<dyn Provider>> {
        None
    }

    /// 获取当前 Provider 的所有子 Provider（用于 warm cache）。
    ///
    /// 默认实现：`list()` 出所有目录项，然后逐个调用 `get_child()`。
    fn get_children(&self, storage: &Storage) -> Result<Vec<(String, Arc<dyn Provider>)>, String> {
        let entries = self.list(storage)?;
        let mut out = Vec::new();
        for e in entries {
            let FsEntry::Directory { name } = e else {
                continue;
            };
            if let Some(child) = self.get_child(storage, &name) {
                out.push((name, child));
            }
        }
        Ok(out)
    }

    /// 直接解析当前目录下的文件（避免为了解析单个文件反复 list 全目录）
    ///
    /// 返回 (image_id, resolved_path)。默认返回 None。
    fn resolve_file(&self, _storage: &Storage, _name: &str) -> Option<(String, PathBuf)> {
        None
    }

    /// 是否支持重命名该节点
    fn can_rename(&self) -> bool {
        false
    }

    /// 重命名该节点
    fn rename(&self, _storage: &Storage, _new_name: &str) -> Result<(), String> {
        Err("不支持重命名".to_string())
    }

    // === 虚拟盘（virtual-drive feature）可写能力：默认拒绝 ===
    //
    // 说明：
    // - 普通 Provider 不应与虚拟盘交互；这些方法只用于 VD 在处理文件系统操作（mkdir/unlink）时委托给 provider。
    // - 因此它们只在 Windows + virtual-drive feature 下编译，避免把 VD 语义带到 core 的常规构建中。

    /// 是否支持在当前目录下创建子目录（mkdir）
    #[cfg(feature = "virtual-drive")]
    fn can_create_child_dir(&self) -> bool {
        false
    }

    /// 在当前目录下创建子目录（mkdir）
    #[cfg(feature = "virtual-drive")]
    fn create_child_dir(
        &self,
        _storage: &Storage,
        _child_name: &str,
        _ctx: &dyn VdOpsContext,
    ) -> Result<(), String> {
        Err("不支持创建目录".to_string())
    }

    /// 虚拟盘删除请求：删除当前目录下的某个 child（文件或目录）。
    ///
    /// 设计要点：
    /// - **只有一个函数**：VD 不再通过 can_* 进行预判。
    /// - 通过 `mode` 支持 Dokan 的“两阶段”删除：先 Check(允许/拒绝)，后 Commit(真正删除)。
    /// - 返回 `bool` 表示是否实际发生删除（Commit 时才有意义；Check 可返回 true 表示允许）。
    #[cfg(feature = "virtual-drive")]
    fn delete_child(
        &self,
        _storage: &Storage,
        _child_name: &str,
        _kind: DeleteChildKind,
        _mode: DeleteChildMode,
        _ctx: &dyn VdOpsContext,
    ) -> Result<bool, String> {
        Err("不支持删除".to_string())
    }
}

/// 虚拟盘（virtual-drive feature）写操作的副作用执行接口。
///
/// 设计原则：
/// - providers 只依赖该 trait，不直接依赖 dokan/tauri/windows 实现细节。
/// - 虚拟盘 handler（Windows Dokan）提供具体实现，把“刷新/事件/缓存失效”落到这里。
#[cfg(feature = "virtual-drive")]
pub trait VdOpsContext {
    fn albums_created(&self, album_name: &str);
    fn albums_deleted(&self, album_name: &str);
    fn album_images_removed(&self, album_name: &str);
    fn tasks_deleted(&self, task_id: &str);
}

/// delete_child 的 child 类型（文件/目录）
#[cfg(feature = "virtual-drive")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteChildKind {
    File,
    Directory,
}

/// delete_child 的模式：Check 仅用于允许/拒绝；Commit 才真正修改数据
#[cfg(feature = "virtual-drive")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteChildMode {
    Check,
    Commit,
}

/// 路径解析结果（给 virtual_drive 使用）
pub enum ResolveResult {
    /// 路径指向一个目录
    Directory(Arc<dyn Provider>),
    /// 路径指向一个文件
    File {
        image_id: String,
        resolved_path: PathBuf,
    },
    /// 路径不存在
    NotFound,
}
