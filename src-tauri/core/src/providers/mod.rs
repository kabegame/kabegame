//! Provider 体系。
//!
//! ## 架构三原则（Provider trait 设计契约）
//!
//! 1. **`apply_query` 内化合并策略**：每个 Provider 实现 `apply_query(current: ImageQuery) -> ImageQuery`，
//!    接受祖先累积的 query，返回本节点转化后的结果。Runtime 只负责把结果原样串到下一层，不做 merge 算法。
//!    合并/翻转/注入策略内化在每个 provider 的 `apply_query` 里——例如：
//!    - `SortProvider` 直接 `current.to_desc()` 翻转所有排序方向；
//!    - `AlbumsProvider` 调 `current.merge(&join_片段)` 注入 JOIN；
//!    - `PluginProvider` 调 `current.with_where(...)` 追加 WHERE 条件。
//! 2. **`list_children` 只返回结构子节点**：不含 images，不含分页虚拟段（"1","2"...）。
//!    Images 由 `Provider::list_images(composed)` / `ProviderRuntime::list_images(path)` 单独枚举。
//!    offset/limit 由终端 provider（`QueryPageProvider`）独占——这是唯一"不能重复贡献"的量。
//! 3. **Runtime 不判断 image 能力**：`list_images(path)` 直接转发到 `provider.list_images(&composed)`。
//!    默认实现按 composed 全量查；需要定制（分页、最后一页）的 provider 自己 override。
//!    顶层纯路由壳不 override——调用侧若真查，会按 composed 拿全表；语义上不鼓励但不拦。
//!
//! ## 术语
//!
//! - **路由壳**：只做路径段路由，`apply_query` 为 noop 或轻量注入，委托 shared 底层。
//! - **shared 底层**：位于 `providers/shared/`，实现具体 `apply_query` 语义，被 VD/Gallery 壳复用。
//! - **终端**：`QueryPageProvider` 等，`list_children` 返回数字段或空，`list_images` override 分页。
//! - **sort 壳**：`SortProvider`，`apply_query = current.to_desc()`，其它方法 delegate 到 inner。
//!
//! ## 模块布局
//!
//! - `provider`:  `Provider` trait + `ChildEntry` + `ResolvedNode`
//! - `runtime`:   `ProviderRuntime`（LRU ResolvedNode 缓存）
//! - `root`:      统一根 `VdNewUnifiedRoot`（gallery + vd）
//! - `shared`:    跨 gallery/vd 共用 provider（QueryPageProvider / …）
//! - `gallery`:   画廊路由壳
//! - `vd`:        虚拟盘路由壳

pub mod provider;
pub mod query;
pub mod runtime;
pub mod root;
pub mod shared;
pub mod gallery;
pub mod vd;

#[cfg(test)]
mod tests;

// vd_ops 保留用于 semantics.rs 的 ensure_note_file（说明文件生成）
#[cfg(kabegame_mode = "standard")]
pub(crate) mod vd_ops;

// ── 公开 re-exports ──────────────────────────────────────────────────────────
pub use query::{
    decode_provider_path_segments, execute_provider_query, execute_provider_query_typed,
    parse_provider_path, provider_query_to_json, ProviderPathQuery, ProviderQueryTyped,
};
pub use runtime::{ProviderCacheConfig, ProviderRuntime};
pub use root::VdNewUnifiedRoot;

/// 虚拟盘专用：从 PluginManager 缓存读取插件显示名（用于"按任务"目录名展示）。
#[cfg(kabegame_mode = "standard")]
pub fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    vd::plugin_names::plugin_display_name_from_manifest(plugin_id)
}
pub use crate::storage::gallery_time::{
    gallery_month_groups_from_days, GalleryTimeFilterPayload, GalleryTimeGroupIndex,
};
