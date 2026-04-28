//! Provider trait 与核心数据类型 — 全部 reexport 自 pathql-rs (6b 起)。
//!
//! 旧 typed `ProviderMeta` enum 已废弃 — meta 现在是 untyped JSON。
//! 前端 wire format 兼容由 [`wrap_typed_meta_json`] helper 提供
//! (序列化为 `{"kind": "...", "data": {...}}` 形态，与旧 ProviderMeta::* 一致)。

pub use pathql_rs::ast::{Namespace, ProviderName, SimpleName};
pub use pathql_rs::compose::ProviderQuery;
pub use pathql_rs::template::eval::TemplateValue;
pub use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext, ResolvedNode};

use serde_json::Value as JsonValue;

use crate::plugin::PluginManager;
use crate::storage::{ImageInfo, Storage};

/// 别名（保留向后兼容）。
pub type ImageEntry = ImageInfo;

// ── 前端 wire format 兼容: typed ProviderMeta 序列化 helper ──
//
// 旧 `ProviderMeta::Album(album)` enum variant 序列化为
// `{"kind": "album", "data": {...}}`。6b 起 `ChildEntry.meta` 是
// `Option<serde_json::Value>` (untyped); 调用方按需调
// `wrap_typed_meta_json(id, kind)` 把 typed 实体包成兼容 JSON。

#[derive(Debug, Clone, Copy)]
pub enum MetaEntityKind {
    Album,
    SurfRecord,
    Task,
    Plugin,
    RunConfig,
}

/// 把 typed 实体包成与旧 ProviderMeta 序列化一致的 JSON。
/// 找不到实体（id 不存在 / DB 错误）返回 None。
pub fn wrap_typed_meta_json(id: &str, kind: MetaEntityKind) -> Option<JsonValue> {
    let (kind_str, data) = match kind {
        MetaEntityKind::Album => {
            let album = Storage::global().get_album_by_id(id).ok()??;
            ("album", serde_json::to_value(album).ok()?)
        }
        MetaEntityKind::SurfRecord => {
            let r = Storage::global().get_surf_record(id).ok()??;
            ("surfRecord", serde_json::to_value(r).ok()?)
        }
        MetaEntityKind::Task => {
            let t = Storage::global().get_task(id).ok()??;
            ("task", serde_json::to_value(t).ok()?)
        }
        MetaEntityKind::Plugin => {
            let p = PluginManager::global().get_sync(id)?;
            ("plugin", serde_json::to_value(p).ok()?)
        }
        MetaEntityKind::RunConfig => {
            let rc = Storage::global().get_run_config(id).ok()??;
            ("runConfig", serde_json::to_value(rc).ok()?)
        }
    };
    Some(serde_json::json!({"kind": kind_str, "data": data}))
}
