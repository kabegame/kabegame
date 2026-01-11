//! 虚拟文件系统 Provider trait 和相关类型
//!
//! 设计原则：
//! - Provider 对路径完全无感知
//! - 每个 Provider 只返回自己的内容（子目录或文件）
//! - 子目录通过 `get_child(name)` 获取对应的子 Provider
//! - 路径解析由框架自动递归处理

use std::path::PathBuf;
use std::sync::Arc;

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
pub trait VirtualFsProvider: Send + Sync {
    /// 列出该 Provider 下的所有条目
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String>;

    /// 获取指定名称的子 Provider
    /// 默认返回 None，表示不支持子目录
    fn get_child(&self, _storage: &Storage, _name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        None
    }

    /// 直接解析当前目录下的文件（避免为了解析单个文件反复 list 全目录）
    ///
    /// 返回 (image_id, resolved_path)。默认返回 None。
    fn resolve_file(&self, _storage: &Storage, _name: &str) -> Option<(String, PathBuf)> {
        None
    }

    /// 是否支持删除该节点本身
    fn can_delete(&self) -> bool {
        false
    }

    /// 删除该节点本身
    fn delete(&self, _storage: &Storage) -> Result<(), String> {
        Err("不支持删除".to_string())
    }

    /// 是否支持重命名该节点
    fn can_rename(&self) -> bool {
        false
    }

    /// 重命名该节点
    fn rename(&self, _storage: &Storage, _new_name: &str) -> Result<(), String> {
        Err("不支持重命名".to_string())
    }
}

/// 路径解析结果
pub enum ResolveResult {
    /// 路径指向一个目录
    Directory(Arc<dyn VirtualFsProvider>),
    /// 路径指向一个文件
    File {
        image_id: String,
        resolved_path: PathBuf,
    },
    /// 路径不存在
    NotFound,
}

// NOTE: 旧的 PathResolver（无缓存）已被 KabegameFs 内部的带缓存解析器取代
