//! Provider trait 与核心数据类型（统一路径解析模型）。

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

/// Provider trait - 对路径完全无感知
pub trait Provider: Send + Sync {
    /// 持久化描述符：用于缓存/重建 Provider（RocksDB）
    fn descriptor(&self) -> ProviderDescriptor;

    /// 列出 Child / Image 条目。Child 条目包含构建好的子 provider。
    fn list_entries(&self) -> Result<Vec<ListEntry>, String>;

    /// 获取指定名称的子 Provider
    /// 默认返回 None，表示不支持子目录
    fn get_child(&self, _name: &str) -> Option<Arc<dyn Provider>> {
        None
    }

    /// 新 API：VD 可选 note 内容（title, content）。
    fn get_note(&self) -> Option<(String, String)> {
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

    fn can_delete_child(&self, _child_name: &str) -> bool {
        false
    }

    fn delete_child(&self, _child_name: &str) -> Result<(), String> {
        Err("不支持删除子节点".to_string())
    }

}
