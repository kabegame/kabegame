//! VD provider 树（虚拟盘）。
//! - `vd_root_router`: i18n 入口（按 locale 翻译显示名）
//! - `vd_all_provider`: 扁平分页（id ASC）
//! - `vd_albums_provider` + `vd_album_entry_provider`
//! - `vd_plugins_provider` + 委派 `gallery_plugin_provider`（共享叶子）
//! - `vd_tasks_provider` + 委派 `gallery_task_provider`
//! - `vd_surfs_provider` + 委派 `gallery_surf_provider`
//! - `vd_dates_provider`（年→月→日，借用 gallery 日期 provider）
//! - `vd_media_type_provider`

use std::collections::HashMap;
use std::sync::Arc;

use kabegame_i18n::vd_display_name;
use pathql_rs::ast::OrderDirection;
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use crate::providers::provider::{wrap_typed_meta_json, MetaEntityKind};
use crate::storage::{Storage, HIDDEN_ALBUM_ID};

use super::gallery_filters::{default_pagination_children, default_pagination_resolve};
use super::helpers::{
    child, child_with_meta, instantiate_named, instantiate_with, prop_string,
};

// ── vd_root_router ───────────────────────────────────────────────────────────

const VD_TOP_CANONICALS: &[(&str, &str, &str)] = &[
    ("all", "all", "vd_all_provider"),
    ("byTask", "task", "vd_tasks_provider"),
    ("byPlugin", "plugin", "vd_plugins_provider"),
    ("byTime", "date", "vd_dates_provider"),
    ("bySurf", "surf", "vd_surfs_provider"),
    ("byType", "mediaType", "vd_media_type_provider"),
    ("albums", "album", "vd_albums_provider"),
];

pub struct VdRootRouter;

impl Provider for VdRootRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
        // 替换排序为 id ASC（VD 兜底稳定排序）
        q.order.entries.clear();
        q.order
            .entries
            .push(("images.id".into(), OrderDirection::Asc));
        q.limit = None;
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(VD_TOP_CANONICALS
            .iter()
            .map(|(_, i18n_key, target)| {
                child(vd_display_name(i18n_key), instantiate_named(target, ctx))
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let target = VD_TOP_CANONICALS
            .iter()
            .find(|(_, i18n_key, _)| vd_display_name(i18n_key) == name)
            .map(|(_, _, t)| *t)
            .or_else(|| {
                // canonical 直名 fallback（按 segment 匹配）
                VD_TOP_CANONICALS
                    .iter()
                    .find(|(seg, _, _)| *seg == name)
                    .map(|(_, _, t)| *t)
            })?;
        instantiate_named(target, ctx)
    }

    fn get_note(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Option<String> {
        Some(
            serde_json::json!({
                "title": "在这里你可以自由查看图片.txt",
                "content": "在这里你可以自由查看图片.txt",
            })
            .to_string(),
        )
    }
}

// ── vd_all_provider ──────────────────────────────────────────────────────────

pub struct VdAllProvider;

impl Provider for VdAllProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(default_pagination_children(ctx))
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        default_pagination_resolve(name, ctx)
    }
}

// ── vd_albums_provider ───────────────────────────────────────────────────────

pub struct VdAlbumsProvider;

impl Provider for VdAlbumsProvider {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery {
        // 委派 gallery_albums_router 的 apply_query (JOIN album_images)
        if let Some(p) = instantiate_named("gallery_albums_router", ctx) {
            return p.apply_query(current, ctx);
        }
        current
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let albums = Storage::global()
            .get_albums(None)
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "albums".into(), e))?;
        Ok(albums
            .into_iter()
            .map(|a| {
                let display = if a.id == HIDDEN_ALBUM_ID {
                    vd_display_name("hidden-album")
                } else {
                    a.name.clone()
                };
                let mut props = HashMap::new();
                props.insert("album_id".into(), TemplateValue::Text(a.id.clone()));
                let provider = instantiate_with("vd_album_entry_provider", props, ctx);
                let meta = wrap_typed_meta_json(&a.id, MetaEntityKind::Album)
                    .unwrap_or(serde_json::Value::Null);
                child_with_meta(display, provider, meta)
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let n = name.trim();
        if n.is_empty() {
            return None;
        }
        let id = if n == vd_display_name("hidden-album") {
            HIDDEN_ALBUM_ID.to_string()
        } else {
            Storage::global().find_child_album_by_name_ci(None, n).ok()??
        };
        let mut props = HashMap::new();
        props.insert("album_id".into(), TemplateValue::Text(id));
        instantiate_with("vd_album_entry_provider", props, ctx)
    }
}

// ── vd_album_entry_provider ──────────────────────────────────────────────────

pub struct VdAlbumEntryProvider {
    pub album_id: String,
}

impl VdAlbumEntryProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            album_id: prop_string(props, "album_id")?,
        })
    }
}

impl Provider for VdAlbumEntryProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw(
            "ai.album_id = ?",
            &[TemplateValue::Text(self.album_id.clone())],
        );
        if self.album_id == HIDDEN_ALBUM_ID {
            q.wheres.retain(|w| !w.0.contains("/*HIDE*/"));
        }
        q.limit = None;
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let mut out = Vec::new();
        // sub-albums (under VD-style "subAlbums" gate group)
        let has_sub = !Storage::global()
            .get_albums(Some(&self.album_id))
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "albums".into(), e))?
            .is_empty();
        if has_sub {
            let mut props = HashMap::new();
            props.insert(
                "parent_album_id".into(),
                TemplateValue::Text(self.album_id.clone()),
            );
            out.push(child(
                vd_display_name("subAlbums"),
                instantiate_with("vd_sub_album_gate_provider", props, ctx),
            ));
        }
        out.extend(default_pagination_children(ctx));
        Ok(out)
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        if name == vd_display_name("subAlbums") {
            let mut props = HashMap::new();
            props.insert(
                "parent_album_id".into(),
                TemplateValue::Text(self.album_id.clone()),
            );
            return instantiate_with("vd_sub_album_gate_provider", props, ctx);
        }
        default_pagination_resolve(name, ctx)
    }
}

// ── vd_sub_album_gate_provider ───────────────────────────────────────────────

pub struct VdSubAlbumGateProvider {
    pub parent_album_id: String,
}

impl VdSubAlbumGateProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            parent_album_id: prop_string(props, "parent_album_id")?,
        })
    }
}

impl Provider for VdSubAlbumGateProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // 剥除父链注入的 ai.album_id WHERE，让子 VdAlbumEntryProvider 自己注入新的
        let mut q = current;
        q.wheres.retain(|w| !w.0.contains("ai.album_id"));
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let children = Storage::global()
            .get_albums(Some(&self.parent_album_id))
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "albums".into(), e))?;
        Ok(children
            .into_iter()
            .map(|a| {
                let mut props = HashMap::new();
                props.insert("album_id".into(), TemplateValue::Text(a.id.clone()));
                let provider = instantiate_with("vd_album_entry_provider", props, ctx);
                let meta = wrap_typed_meta_json(&a.id, MetaEntityKind::Album)
                    .unwrap_or(serde_json::Value::Null);
                child_with_meta(a.name.clone(), provider, meta)
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let n = name.trim();
        if n.is_empty() {
            return None;
        }
        let child_id = Storage::global()
            .find_child_album_by_name_ci(Some(&self.parent_album_id), n)
            .ok()??;
        let mut props = HashMap::new();
        props.insert("album_id".into(), TemplateValue::Text(child_id));
        instantiate_with("vd_album_entry_provider", props, ctx)
    }
}

// ── vd_plugins_provider / vd_tasks_provider / vd_surfs_provider ─────────────

pub struct VdPluginsProvider;
impl Provider for VdPluginsProvider {
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // 委派 gallery_plugins_router
        if let Some(p) = instantiate_named("gallery_plugins_router", ctx) {
            return p.list(composed, ctx);
        }
        Ok(Vec::new())
    }

    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        instantiate_named("gallery_plugins_router", ctx)?.resolve(name, composed, ctx)
    }
}

pub struct VdTasksProvider;
impl Provider for VdTasksProvider {
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        instantiate_named("gallery_tasks_router", ctx)
            .map(|p| p.list(composed, ctx))
            .unwrap_or(Ok(Vec::new()))
    }

    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        instantiate_named("gallery_tasks_router", ctx)?.resolve(name, composed, ctx)
    }
}

pub struct VdSurfsProvider;
impl Provider for VdSurfsProvider {
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        instantiate_named("gallery_surfs_router", ctx)
            .map(|p| p.list(composed, ctx))
            .unwrap_or(Ok(Vec::new()))
    }

    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        instantiate_named("gallery_surfs_router", ctx)?.resolve(name, composed, ctx)
    }
}

// ── vd_media_type_provider ───────────────────────────────────────────────────

pub struct VdMediaTypeProvider;
impl Provider for VdMediaTypeProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            child("image", instantiate_media_type("image", ctx)),
            child("video", instantiate_media_type("video", ctx)),
        ]
        .into_iter()
        .map(|c| ChildEntry {
            name: vd_display_name(if c.name == "image" { "image" } else { "video" }),
            ..c
        })
        .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let canonical = if name == vd_display_name("image") {
            "image"
        } else if name == vd_display_name("video") {
            "video"
        } else {
            return None;
        };
        instantiate_media_type(canonical, ctx)
    }
}

fn instantiate_media_type(kind: &str, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
    let mut props = HashMap::new();
    props.insert("kind".into(), TemplateValue::Text(kind.into()));
    instantiate_with("gallery_media_type_provider", props, ctx)
}

// ── vd_dates_provider ────────────────────────────────────────────────────────

pub struct VdDatesProvider;
impl Provider for VdDatesProvider {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery {
        instantiate_named("gallery_dates_router", ctx)
            .map(|p| p.apply_query(current.clone(), ctx))
            .unwrap_or(current)
    }

    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        instantiate_named("gallery_dates_router", ctx)
            .map(|p| p.list(composed, ctx))
            .unwrap_or(Ok(Vec::new()))
    }

    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        instantiate_named("gallery_dates_router", ctx)?.resolve(name, composed, ctx)
    }
}
