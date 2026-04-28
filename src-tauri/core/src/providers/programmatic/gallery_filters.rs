//! Gallery 过滤维度路由壳：
//! - plugins / plugin
//! - tasks / task
//! - surfs / surf
//! - media_type
//! - hide
//! - search / display_name
//! - wallpaper_order
//! - date_range

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::OrderDirection;
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use crate::plugin::PluginManager;
use crate::providers::provider::{wrap_typed_meta_json, MetaEntityKind};
use crate::storage::Storage;

use super::helpers::{child, child_with_meta, instantiate_named, instantiate_with, prop_string};

// ── plugins ──────────────────────────────────────────────────────────────────

pub struct GalleryPluginsRouter;

impl Provider for GalleryPluginsRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let groups = Storage::global()
            .get_gallery_plugin_groups()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "plugins".into(), e))?;
        Ok(groups
            .into_iter()
            .map(|g| {
                let pid = g.plugin_id.clone();
                let mut props = HashMap::new();
                props.insert("plugin_id".into(), TemplateValue::Text(pid.clone()));
                let provider = instantiate_with("gallery_plugin_provider", props, ctx);
                let meta = wrap_typed_meta_json(&pid, MetaEntityKind::Plugin)
                    .unwrap_or(serde_json::Value::Null);
                child_with_meta(pid, provider, meta)
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let pid = name.trim();
        if pid.is_empty() {
            return None;
        }
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        if !groups.iter().any(|g| g.plugin_id.eq_ignore_ascii_case(pid)) {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("plugin_id".into(), TemplateValue::Text(pid.into()));
        instantiate_with("gallery_plugin_provider", props, ctx)
    }
}

pub struct GalleryPluginProvider {
    pub plugin_id: String,
}

impl GalleryPluginProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            plugin_id: prop_string(props, "plugin_id")?,
        })
    }
}

impl Provider for GalleryPluginProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw(
            "images.plugin_id = ?",
            &[TemplateValue::Text(self.plugin_id.clone())],
        );
        q.limit = None;
        q
    }

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

    fn get_note(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Option<String> {
        let pm = PluginManager::global();
        pm.get_sync(&self.plugin_id).map(|p| {
            serde_json::json!({
                "title": p.id.clone(),
                "content": format!("Plugin {}", p.id),
            })
            .to_string()
        })
    }
}

// ── tasks ────────────────────────────────────────────────────────────────────

pub struct GalleryTasksRouter;

impl Provider for GalleryTasksRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let tasks = Storage::global()
            .get_tasks_with_images()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "tasks".into(), e))?;
        let ids: Vec<String> = tasks.iter().map(|(id, _)| id.clone()).collect();
        let mut meta_map = Storage::global()
            .get_tasks_by_ids(&ids)
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "tasks".into(), e))?;
        Ok(tasks
            .into_iter()
            .map(|(id, _)| {
                let mut props = HashMap::new();
                props.insert("task_id".into(), TemplateValue::Text(id.clone()));
                let provider = instantiate_with("gallery_task_provider", props, ctx);
                let meta_json = meta_map
                    .remove(&id)
                    .and_then(|t| serde_json::to_value(t).ok())
                    .map(|v| serde_json::json!({"kind": "task", "data": v}));
                match meta_json {
                    Some(m) => child_with_meta(id, provider, m),
                    None => child(id, provider),
                }
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let tid = name.trim();
        if tid.is_empty() {
            return None;
        }
        if Storage::global().get_task(tid).ok()?.is_none() {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("task_id".into(), TemplateValue::Text(tid.into()));
        instantiate_with("gallery_task_provider", props, ctx)
    }
}

pub struct GalleryTaskProvider {
    pub task_id: String,
}

impl GalleryTaskProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            task_id: prop_string(props, "task_id")?,
        })
    }
}

impl Provider for GalleryTaskProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw(
            "images.task_id = ?",
            &[TemplateValue::Text(self.task_id.clone())],
        );
        q.limit = None;
        q
    }

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

// ── surfs ────────────────────────────────────────────────────────────────────

pub struct GallerySurfsRouter;

impl Provider for GallerySurfsRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let records = Storage::global()
            .get_surf_records_with_images()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "surfs".into(), e))?;
        let ids: Vec<String> = records.iter().map(|(id, _)| id.clone()).collect();
        let mut meta_map = Storage::global()
            .get_surf_records_by_ids(&ids)
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "surfs".into(), e))?;
        Ok(records
            .into_iter()
            .map(|(id, host)| {
                let mut props = HashMap::new();
                props.insert("record_id".into(), TemplateValue::Text(id.clone()));
                let provider = instantiate_with("gallery_surf_provider", props, ctx);
                let meta_json = meta_map
                    .remove(&id)
                    .and_then(|r| serde_json::to_value(r).ok())
                    .map(|v| serde_json::json!({"kind": "surfRecord", "data": v}));
                match meta_json {
                    Some(m) => child_with_meta(host, provider, m),
                    None => child(host, provider),
                }
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let host = name.trim().to_lowercase();
        if host.is_empty() {
            return None;
        }
        let record = Storage::global().get_surf_record_by_host(&host).ok()??;
        let mut props = HashMap::new();
        props.insert("record_id".into(), TemplateValue::Text(record.id));
        instantiate_with("gallery_surf_provider", props, ctx)
    }
}

pub struct GallerySurfProvider {
    pub record_id: String,
}

impl GallerySurfProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            record_id: prop_string(props, "record_id")?,
        })
    }
}

impl Provider for GallerySurfProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw(
            "images.surf_record_id = ?",
            &[TemplateValue::Text(self.record_id.clone())],
        );
        q.limit = None;
        q
    }

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

// ── media_type ───────────────────────────────────────────────────────────────

pub struct GalleryMediaTypeRouter;

impl Provider for GalleryMediaTypeRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            child("image", instantiate_media_type("image", ctx)),
            child("video", instantiate_media_type("video", ctx)),
        ])
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        match name {
            "image" | "video" => instantiate_media_type(name, ctx),
            _ => None,
        }
    }
}

fn instantiate_media_type(kind: &str, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
    let mut props = HashMap::new();
    props.insert("kind".into(), TemplateValue::Text(kind.into()));
    instantiate_with("gallery_media_type_provider", props, ctx)
}

pub struct GalleryMediaTypeProvider {
    pub kind: String,
}

impl GalleryMediaTypeProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            kind: prop_string(props, "kind")?,
        })
    }
}

impl Provider for GalleryMediaTypeProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let sql = if self.kind == "video" {
            "(LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%')"
        } else {
            "NOT (LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%')"
        };
        let mut q = current.with_where_raw(sql, &[]);
        q.limit = None;
        q
    }

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

// ── hide ─────────────────────────────────────────────────────────────────────

/// `gallery/hide/`：注入 HIDE WHERE，下游树委派回 gallery_route。
pub struct GalleryHideRouter;

impl Provider for GalleryHideRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // `/*HIDE*/` 标记：HiddenAlbum 详情页面的 GalleryAlbumProvider 会剥除含此标记的 WHERE。
        let mut q = current.with_where_raw(
            "/*HIDE*/ NOT EXISTS (SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ?)",
            &[TemplateValue::Text(crate::storage::HIDDEN_ALBUM_ID.into())],
        );
        q.limit = None;
        q
    }

    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // 委派 gallery_route.list：下游再次暴露完整 gallery 树。
        if let Some(p) = instantiate_named("gallery_route", ctx) {
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
        instantiate_named("gallery_route", ctx)?.resolve(name, composed, ctx)
    }
}

// ── search ───────────────────────────────────────────────────────────────────

pub struct GallerySearchRouter;

impl Provider for GallerySearchRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![child(
            "display-name",
            instantiate_named("gallery_search_display_name_router", ctx),
        )])
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        match name {
            "display-name" => instantiate_named("gallery_search_display_name_router", ctx),
            _ => None,
        }
    }
}

pub struct GallerySearchDisplayNameRouter;

impl Provider for GallerySearchDisplayNameRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let q = name.trim();
        if q.is_empty() {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("query".into(), TemplateValue::Text(q.into()));
        instantiate_with("gallery_search_display_name_query_provider", props, ctx)
    }
}

pub struct GallerySearchDisplayNameQueryProvider {
    pub query: String,
}

impl GallerySearchDisplayNameQueryProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            query: prop_string(props, "query")?,
        })
    }
}

impl Provider for GallerySearchDisplayNameQueryProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // 转义 LIKE 元字符
        let escaped = self
            .query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);
        let mut q = current.with_where_raw(
            "LOWER(images.display_name) LIKE LOWER(?) ESCAPE '\\'",
            &[TemplateValue::Text(pattern)],
        );
        q.limit = None;
        q
    }

    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // 委派 gallery_route.list（嵌套支持）。
        if let Some(p) = instantiate_named("gallery_route", ctx) {
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
        instantiate_named("gallery_route", ctx)?.resolve(name, composed, ctx)
    }
}

// ── wallpaper_order ──────────────────────────────────────────────────────────

pub struct GalleryWallpaperOrderRouter;

impl Provider for GalleryWallpaperOrderRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw("images.last_set_wallpaper_at IS NOT NULL", &[]);
        q.order
            .entries
            .insert(0, ("images.last_set_wallpaper_at".into(), OrderDirection::Asc));
        q.limit = None;
        q
    }

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

// ── date_range ───────────────────────────────────────────────────────────────

pub struct GalleryDateRangeRouter;

impl Provider for GalleryDateRangeRouter {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let parts: Vec<&str> = name.split('~').collect();
        if parts.len() != 2 {
            return None;
        }
        let start = parts[0].trim();
        let end = parts[1].trim();
        if start.len() != 10 || end.len() != 10 {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("start".into(), TemplateValue::Text(start.into()));
        props.insert("end".into(), TemplateValue::Text(end.into()));
        instantiate_with("gallery_date_range_entry_provider", props, ctx)
    }
}

pub struct GalleryDateRangeEntryProvider {
    pub start: String,
    pub end: String,
}

impl GalleryDateRangeEntryProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            start: prop_string(props, "start")?,
            end: prop_string(props, "end")?,
        })
    }
}

impl Provider for GalleryDateRangeEntryProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let lo = "date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') >= date(?)";
        let hi = "date(CASE WHEN images.crawled_at > 253402300799 THEN images.crawled_at/1000 ELSE images.crawled_at END, 'unixepoch') <= date(?)";
        let mut q = current
            .with_where_raw(lo, &[TemplateValue::Text(self.start.clone())])
            .with_where_raw(hi, &[TemplateValue::Text(self.end.clone())]);
        q.order
            .entries
            .insert(0, ("images.crawled_at".into(), OrderDirection::Asc));
        q.limit = None;
        q
    }

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

// ── 共用：默认分页 children + resolve（page_size 100/500/1000 + 数字段） ─────

pub fn default_pagination_children(ctx: &ProviderContext) -> Vec<ChildEntry> {
    let mut out = vec![child("desc", instantiate_named("sort_provider", ctx))];
    for ps in [100i64, 500, 1000] {
        let mut props = HashMap::new();
        props.insert("page_size".into(), TemplateValue::Int(ps));
        out.push(child(
            format!("x{}x", ps),
            instantiate_with("gallery_paginate_router", props, ctx),
        ));
    }
    out
}

pub fn default_pagination_resolve(name: &str, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
    if name == "desc" {
        return instantiate_named("sort_provider", ctx);
    }
    if let Some(inner) = name.strip_prefix('x').and_then(|s| s.strip_suffix('x')) {
        if let Ok(ps) = inner.parse::<i64>() {
            if (10..=1000).contains(&ps) {
                let mut props = HashMap::new();
                props.insert("page_size".into(), TemplateValue::Int(ps));
                return instantiate_with("gallery_paginate_router", props, ctx);
            }
        }
    }
    if let Ok(n) = name.parse::<i64>() {
        if n > 0 {
            let mut props = HashMap::new();
            props.insert("page_size".into(), TemplateValue::Int(100));
            props.insert("page_num".into(), TemplateValue::Int(n));
            return instantiate_with("query_page_provider", props, ctx);
        }
    }
    None
}
