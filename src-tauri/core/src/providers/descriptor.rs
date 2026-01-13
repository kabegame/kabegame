//! Provider 描述符（可持久化到 RocksDB，用于重建 Provider）。

use serde::{Deserialize, Serialize};

use crate::storage::gallery::ImageQuery;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderDescriptor {
    Root,

    GalleryRoot,

    Albums,
    Album {
        album_id: String,
    },

    PluginGroup,
    DateGroup,
    /// “按时间/范围” 根目录（子目录为动态范围：YYYY-MM-DD~YYYY-MM-DD）
    DateRangeRoot,
    TaskGroup,

    /// 统一的“图片集合” provider：由 ImageQuery 定义
    All {
        query: ImageQuery,
    },

    /// AllProvider 的 range 子节点
    Range {
        query: ImageQuery,
        offset: usize,
        count: usize,
        depth: usize,
    },
}
