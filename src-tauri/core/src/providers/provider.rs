//! Provider trait 与核心数据类型（统一路径解析模型）。

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::descriptor::ProviderDescriptor;

/// 图片不变信息（Phase 1 新类型，供新 Provider API 使用）。
#[derive(Debug, Clone)]
pub struct ImageEntry {
    pub id: String,
    pub url: Option<String>,
    pub local_path: String,
    pub plugin_id: String,
    pub crawled_at: u64,
    pub hash: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub display_name: String,
    pub media_type: Option<String>,
}

/// 列表条目（Phase 1 新类型）。
pub enum ListEntry {
    /// 子 Provider：`list_entries()` 可直接返回构建好的 provider。
    Child {
        name: String,
        provider: Arc<dyn Provider>,
    },
    /// 图片条目
    Image(ImageEntry),
}

/// 过渡兼容：旧文件系统条目。
#[derive(Debug, Clone)]
pub enum FsEntry {
    Directory { name: String },
    File {
        name: String,
        image_id: String,
        resolved_path: PathBuf,
    },
}

impl FsEntry {
    pub fn dir(name: impl Into<String>) -> Self {
        FsEntry::Directory { name: name.into() }
    }

    pub fn file(name: impl Into<String>, image_id: impl Into<String>, path: PathBuf) -> Self {
        FsEntry::File {
            name: name.into(),
            image_id: image_id.into(),
            resolved_path: path,
        }
    }
}

/// 过渡兼容：动态子节点解析语义。
pub enum ResolveChild {
    NotFound,
    Listed(Arc<dyn Provider>),
    Dynamic(Arc<dyn Provider>),
}

/// Provider trait - 对路径完全无感知
pub trait Provider: Send + Sync {
    /// 持久化描述符：用于缓存/重建 Provider（RocksDB）
    fn descriptor(&self) -> ProviderDescriptor;

    /// 列出 Child / Image 条目。默认从旧 `list()` 转换。
    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let entries = self.list()?;
        let mut out = Vec::new();
        for entry in entries {
            match entry {
                FsEntry::Directory { name } => {
                    if let Some(provider) = self.get_child(&name) {
                        out.push(ListEntry::Child { name, provider });
                    }
                }
                FsEntry::File {
                    name,
                    image_id,
                    resolved_path,
                } => out.push(ListEntry::Image(ImageEntry {
                    id: image_id,
                    url: None,
                    local_path: resolved_path.to_string_lossy().to_string(),
                    plugin_id: String::new(),
                    crawled_at: 0,
                    hash: String::new(),
                    width: None,
                    height: None,
                    display_name: name,
                    media_type: None,
                })),
            }
        }
        Ok(out)
    }

    /// 过渡兼容：旧 list() 接口，默认由 list_entries 映射。
    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let entries = self.list_entries()?;
        let mut out = Vec::new();
        for entry in entries {
            match entry {
                ListEntry::Child { name, .. } => out.push(FsEntry::dir(name)),
                ListEntry::Image(image) => {
                    let ext = std::path::Path::new(&image.local_path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("bin");
                    out.push(FsEntry::file(
                        format!("{}.{}", image.id, ext),
                        image.id,
                        PathBuf::from(image.local_path),
                    ));
                }
            }
        }
        Ok(out)
    }

    /// 获取指定名称的子 Provider
    /// 默认返回 None，表示不支持子目录
    fn get_child(&self, _name: &str) -> Option<Arc<dyn Provider>> {
        None
    }

    /// 新 API：VD 可选 note 内容（title, content）。
    fn get_note(&self) -> Option<(String, String)> {
        None
    }

    /// 过渡兼容：动态子节点解析。
    fn resolve_child(&self, _name: &str) -> ResolveChild {
        ResolveChild::NotFound
    }

    /// 过渡兼容：按文件名直达解析。
    fn resolve_file(&self, _name: &str) -> Option<(String, PathBuf)> {
        None
    }

    // === 新 API：父节点语义的子节点写操作（Phase 1）===
    fn can_add_child(&self) -> bool {
        false
    }

    fn add_child(&self, _child_name: &str) -> Result<(), String> {
        Err("不支持创建子节点".to_string())
    }

    fn can_rename_child(&self) -> bool {
        false
    }

    fn rename_child(&self, _child_name: &str, _new_name: &str) -> Result<(), String> {
        Err("不支持重命名子节点".to_string())
    }

    fn can_delete_child_v2(&self, _child_name: &str) -> bool {
        false
    }

    fn delete_child_v2(&self, _child_name: &str) -> Result<(), String> {
        Err("不支持删除子节点".to_string())
    }

}

/// delete_child 的模式：Check 仅用于允许/拒绝；Commit 才真正修改数据
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteChildMode {
    Check,
    Commit,
}

/// 路径解析结果（给 virtual_driver 使用）
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
pub enum ResolveResult {
    /// 路径指向一个目录
    Directory(Arc<dyn Provider>),
    /// 路径指向一个文件
    File {
        image_id: String,
        resolved_path: std::path::PathBuf,
    },
    /// 路径不存在
    NotFound,
}
