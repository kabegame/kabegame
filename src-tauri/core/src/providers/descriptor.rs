//! Provider 描述符（可持久化到 RocksDB，用于重建 Provider）。

use serde::{Deserialize, Serialize};

use crate::storage::gallery::ImageQuery;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MainGroupKind {
    Plugin,
    Date,
    DateRange,
    Album,
    Task,
    Surf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderDescriptor {
    Root,

    Albums,
    Album {
        album_id: String,
    },

    PluginGroup,
    DateGroup,
    /// “按时间/范围” 根目录（子目录为动态范围：YYYY-MM-DD~YYYY-MM-DD）
    DateRangeRoot,
    TaskGroup,
    SurfGroup,

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

    /// 新增：MainProvider 体系（简单分页）
    MainRoot,
    MainGroup {
        kind: MainGroupKind,
    },
    /// SimplePage 模式的 CommonProvider（直接分页，无贪心分解）
    SimpleAll {
        query: ImageQuery,
    },
    /// 叶子页：直接返回 offset=(page-1)*100, count=100 的图片
    SimplePage {
        query: ImageQuery,
        page: usize,
    },
}
