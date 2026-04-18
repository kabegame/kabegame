//! Provider trait 与核心数据类型（统一路径解析模型）。
//!
//! 本文件包含新 `Provider` trait 及相关数据类型。
//! LegacyProvider（旧 trait）已在 Phase 5 删除；所有路由壳均已迁移到新 trait。

use std::sync::Arc;

use serde::Serialize;

use crate::plugin::{Plugin, PluginManager};
use crate::storage::gallery::ImageQuery;
use crate::storage::run_configs::RunConfig;
use crate::storage::tasks::TaskInfo;
use crate::storage::{Album, ImageInfo, Storage, SurfRecord};

// ── 图片 / 列表条目 ──────────────────────────────────────────

/// Provider 列表中的图片条目——直接复用 `ImageInfo`，由 storage 层单次 SQL 组装
/// （含 favorite JOIN、thumbnail_path、尺寸等完整字段），避免前端层再按 id 逐条回查。
pub type ImageEntry = ImageInfo;

// ── ProviderMeta：实体元数据 ──────────────────────────────────

/// Provider 节点关联的存储实体。始终动态查 DB / PluginManager，不缓存。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum ProviderMeta {
    Album(Album),
    SurfRecord(SurfRecord),
    Task(TaskInfo),
    Plugin(Plugin),
    RunConfig(RunConfig),
}

/// 实体类型标识，供 [`fetch_provider_meta`] 分发。
#[derive(Debug, Clone, Copy)]
pub enum MetaEntityKind {
    Album,
    SurfRecord,
    Task,
    Plugin,
    RunConfig,
}

/// 统一的实体元数据获取入口 — 新增实体类型时只需维护此函数。
pub fn fetch_provider_meta(id: &str, kind: MetaEntityKind) -> Option<ProviderMeta> {
    match kind {
        MetaEntityKind::Album => Storage::global()
            .get_album_by_id(id)
            .ok()?
            .map(ProviderMeta::Album),
        MetaEntityKind::SurfRecord => Storage::global()
            .get_surf_record(id)
            .ok()?
            .map(ProviderMeta::SurfRecord),
        MetaEntityKind::Task => Storage::global()
            .get_task(id)
            .ok()?
            .map(ProviderMeta::Task),
        MetaEntityKind::Plugin => PluginManager::global()
            .get_sync(id)
            .map(ProviderMeta::Plugin),
        MetaEntityKind::RunConfig => Storage::global()
            .get_run_config(id)
            .ok()?
            .map(ProviderMeta::RunConfig),
    }
}

// ── 新 Provider trait ────────────────────────────────────────
//
// 路由壳（类型归属：路由壳）—— apply_query 语义：noop（根壳）/ merge / with_where / to_desc
// 共享底层（类型归属：shared 底层）—— apply_query 语义见各文件注释
// 终端（类型归属：终端）—— apply_query: noop；list_images override 取分页

/// Provider trait：结构树 × 查询片段 × 运行时组合。
///
/// 三原则：
/// 1. `apply_query` 内化合并策略——接受祖先累积的 query，返回本节点转化后结果。Runtime 只原样串下去。
/// 2. `list_children` 只返回结构子节点；images 由 `Provider::list_images` / `ProviderRuntime::list_images` 单独枚举。
/// 3. Runtime 不判断 image 能力——`list_images(composed)` 直接转发 provider；默认实现按 composed 全量查。
pub trait Provider: Send + Sync {
    /// 接受当前累积 query，返回本节点转化后的 query。
    /// 纯函数，不读 DB。合并/翻转/注入策略内化在实现里。
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
    }

    /// 列结构子节点；**不含** images，**不含**分页虚拟段。
    /// `composed` 是 runtime 传入的"本节点 apply_query 之后"的 query。
    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String>;

    /// 结构子节点 + meta 批量版（VD 目录读取一次带出元数据）。
    /// 默认实现：转发 list_children，每个 child 调一次 get_meta。
    fn list_children_with_meta(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children = self.list_children(composed)?;
        Ok(children
            .into_iter()
            .map(|mut c| {
                if c.meta.is_none() {
                    c.meta = c.provider.get_meta();
                }
                c
            })
            .collect())
    }

    /// 解析子节点。可根据 composed 校验目标实际存在。
    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>>;

    /// 列 images。Runtime 只传 composed，offset/limit 由 provider 自身字段决定。
    ///
    /// 默认实现：空（容器 provider 只有子目录，无图片）。
    /// 需要实际列图片的 provider（`QueryPageProvider` / VD 的 `all`/`albums` 等）必须 override。
    /// 历史陷阱：默认返回全量是错误的——VD 读目录时会对每个容器 provider 调 `list_images`，
    /// 全量查会导致 Explorer 卡死 / 系统资源耗尽。
    fn list_images(&self, _composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        Ok(Vec::new())
    }

    /// 可选：VD 说明文件。
    fn get_note(&self) -> Option<(String, String)> {
        None
    }

    /// 可选：meta。
    fn get_meta(&self) -> Option<ProviderMeta> {
        None
    }
}

// ── ChildEntry（新 trait 用）────────────────────────────────

/// Provider 的结构子节点条目。
pub struct ChildEntry {
    pub name: String,
    pub provider: Arc<dyn Provider>,
    pub meta: Option<ProviderMeta>,
}

impl ChildEntry {
    pub fn new(name: impl Into<String>, provider: Arc<dyn Provider>) -> Self {
        Self { name: name.into(), provider, meta: None }
    }

    pub fn with_meta(name: impl Into<String>, provider: Arc<dyn Provider>, meta: ProviderMeta) -> Self {
        Self { name: name.into(), provider, meta: Some(meta) }
    }
}

// ── ResolvedNode（runtime 用）───────────────────────────────

/// Runtime resolve 的结果：provider + 该节点 apply_query 后的 composed query。
pub struct ResolvedNode {
    pub provider: Arc<dyn Provider>,
    pub composed: ImageQuery,
}

impl Clone for ResolvedNode {
    fn clone(&self) -> Self {
        Self {
            provider: self.provider.clone(),
            composed: self.composed.clone(),
        }
    }
}
