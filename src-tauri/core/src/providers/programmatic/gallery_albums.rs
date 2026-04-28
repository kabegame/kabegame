//! Gallery 画册：
//! - `gallery_albums_router`: 列所有根画册；apply_query 加 INNER JOIN album_images + crawled_at ASC
//! - `gallery_album_provider`: 单画册（按 album_id 过滤）

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{JoinKind, OrderDirection};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use crate::providers::provider::{wrap_typed_meta_json, MetaEntityKind};
use crate::storage::{Storage, HIDDEN_ALBUM_ID};

use super::helpers::{child_with_meta, instantiate_named, instantiate_with, prop_string};

// ── gallery_albums_router ────────────────────────────────────────────────────

pub struct GalleryAlbumsRouter;

impl Provider for GalleryAlbumsRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // INNER JOIN album_images ai ON images.id = ai.image_id
        let from_backup = current.from.clone();
        let mut q = current
            .with_join_raw(
                JoinKind::Inner,
                "album_images",
                "ai",
                Some("images.id = ai.image_id"),
                &[],
            )
            .unwrap_or_else(|_| {
                let mut blank = ProviderQuery::new();
                blank.from = from_backup;
                blank
            });
        // prepend crawled_at ASC
        q.order.entries.insert(
            0,
            ("images.crawled_at".into(), OrderDirection::Asc),
        );
        q.limit = None;
        q
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
                let id = a.id.clone();
                let mut props = HashMap::new();
                props.insert("album_id".into(), TemplateValue::Text(id.clone()));
                let provider = instantiate_with("gallery_album_provider", props, ctx);
                let meta = wrap_typed_meta_json(&id, MetaEntityKind::Album)
                    .unwrap_or(serde_json::Value::Null);
                child_with_meta(id, provider, meta)
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let id = name.trim();
        if id.is_empty() {
            return None;
        }
        if !Storage::global().album_exists(id).ok()? {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("album_id".into(), TemplateValue::Text(id.into()));
        instantiate_with("gallery_album_provider", props, ctx)
    }
}

// ── gallery_album_provider ───────────────────────────────────────────────────

pub struct GalleryAlbumProvider {
    pub album_id: String,
}

impl GalleryAlbumProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let album_id = prop_string(props, "album_id")?;
        Ok(Self { album_id })
    }
}

impl Provider for GalleryAlbumProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current.with_where_raw(
            "ai.album_id = ?",
            &[TemplateValue::Text(self.album_id.clone())],
        );
        // 隐藏画册详情：剥除上游可能注入的 HIDE WHERE 标记
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
        let mut out: Vec<ChildEntry> = Vec::new();
        // sub-albums
        let sub_albums = Storage::global()
            .get_albums(Some(&self.album_id))
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "albums".into(), e))?;
        for a in sub_albums {
            let id = a.id.clone();
            let mut props = HashMap::new();
            props.insert("album_id".into(), TemplateValue::Text(id.clone()));
            let provider = instantiate_with("gallery_album_provider", props, ctx);
            let meta = wrap_typed_meta_json(&id, MetaEntityKind::Album)
                .unwrap_or(serde_json::Value::Null);
            out.push(child_with_meta(id, provider, meta));
        }
        // pagination entries
        out.push(super::helpers::child(
            "desc",
            instantiate_named("sort_provider", ctx),
        ));
        for ps in [100i64, 500, 1000] {
            let mut props = HashMap::new();
            props.insert("page_size".into(), TemplateValue::Int(ps));
            out.push(super::helpers::child(
                format!("x{}x", ps),
                instantiate_with("gallery_paginate_router", props, ctx),
            ));
        }
        Ok(out)
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return instantiate_named("sort_provider", ctx);
        }
        // xNNNx → paginate
        if let Some(inner) = name.strip_prefix('x').and_then(|s| s.strip_suffix('x')) {
            if let Ok(ps) = inner.parse::<i64>() {
                if (10..=1000).contains(&ps) {
                    let mut props = HashMap::new();
                    props.insert("page_size".into(), TemplateValue::Int(ps));
                    return instantiate_with("gallery_paginate_router", props, ctx);
                }
            }
        }
        // 数字段 → 默认 page_size=100
        if let Ok(n) = name.parse::<i64>() {
            if n > 0 {
                let mut props = HashMap::new();
                props.insert("page_size".into(), TemplateValue::Int(100));
                props.insert("page_num".into(), TemplateValue::Int(n));
                return instantiate_with("query_page_provider", props, ctx);
            }
        }
        // sub-album
        let album = Storage::global().get_album_by_id(name).ok()??;
        if album.parent_id.as_deref() != Some(&self.album_id) {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("album_id".into(), TemplateValue::Text(name.into()));
        instantiate_with("gallery_album_provider", props, ctx)
    }

    fn get_note(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Option<String> {
        None
    }
}
