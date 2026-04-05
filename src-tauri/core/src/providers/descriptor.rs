//! Provider 描述符（可持久化到 RocksDB，用于重建 Provider）。

use serde::{Deserialize, Serialize};

use crate::storage::gallery::ImageQuery;

/// 统一 Provider 树使用的分组类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderGroupKind {
    Plugin,
    Date,
    DateRange,
    Album,
    Task,
    Surf,
    MediaType,
}

/// Main 日期「大目录」scoped 层级（年 / 月）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum DateScopedTier {
    Year { year: String },
    YearMonth { year_month: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderDescriptor {
    /// 统一根：`/gallery` + `/vd`
    UnifiedRoot,
    /// 画廊根（canonical 名称）
    GalleryRoot,
    /// VD 根（locale 列表）
    VdRoot,
    /// 统一 Group 变体（替代旧 main/vd 分裂）
    Group {
        kind: ProviderGroupKind,
    },

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
    /// Main `date/YYYY`、`date/YYYY-MM`：贪心分解 + 子时间目录 + `desc`（与 CommonProvider 贪心语义一致）
    DateScoped {
        query: ImageQuery,
        tier: DateScopedTier,
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
