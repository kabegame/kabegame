//! Gallery 根 + 顶级路由：
//! - `root_provider`: 全局根（vd / gallery 两子树）
//! - `gallery_route`: from=images，limit=0；列出 11 个顶级入口
//! - `gallery_all_router`: 全部图片，resolve `desc` / `xNNNx`
//! - `gallery_paginate_router`: 给定 page_size，按 page 数分页
//! - `gallery_page_router`: 给定 page_size + page_num，delegate 到 query_page_provider

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{NumberOrTemplate, SqlExpr};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use super::helpers::{child, instantiate_named, instantiate_with, prop_i64};

// ── root_provider ────────────────────────────────────────────────────────────

pub struct RootProvider;

impl Provider for RootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            child("gallery", instantiate_named("gallery_route", ctx)),
            child("vd", instantiate_named("vd_root_router", ctx)),
        ])
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let target = match name {
            "gallery" => "gallery_route",
            "vd" => "vd_root_router",
            _ => return None,
        };
        instantiate_named(target, ctx)
    }
}

// ── gallery_route ────────────────────────────────────────────────────────────

const GALLERY_TOP_ROUTES: &[(&str, &str)] = &[
    ("all", "gallery_all_router"),
    ("wallpaper-order", "gallery_wallpaper_order_router"),
    ("plugin", "gallery_plugins_router"),
    ("task", "gallery_tasks_router"),
    ("surf", "gallery_surfs_router"),
    ("media-type", "gallery_media_type_router"),
    ("date", "gallery_dates_router"),
    ("date-range", "gallery_date_range_router"),
    ("album", "gallery_albums_router"),
    ("hide", "gallery_hide_router"),
    ("search", "gallery_search_router"),
];

pub struct GalleryRouteProvider;

impl Provider for GalleryRouteProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
        if q.from.is_none() {
            q.from = Some(SqlExpr("images".into()));
        }
        // limit=0 by default — IPC 自行决定是否覆盖（pagination router 会重写）
        if q.limit.is_none() {
            q.limit = Some(NumberOrTemplate::Number(0.0));
        }
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(GALLERY_TOP_ROUTES
            .iter()
            .map(|(name, target)| child(*name, instantiate_named(target, ctx)))
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        for (n, target) in GALLERY_TOP_ROUTES {
            if *n == name {
                return instantiate_named(target, ctx);
            }
        }
        None
    }
}

// ── gallery_all_router ───────────────────────────────────────────────────────

pub struct GalleryAllRouter;

impl Provider for GalleryAllRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // prepend crawled_at ASC（为 all 路径贡献时间排序）
        let mut q = current;
        q.order.entries.insert(
            0,
            ("images.crawled_at".into(), pathql_rs::ast::OrderDirection::Asc),
        );
        // 抹掉 limit=0（gallery_route 设置的）；下游 paginate_router 会重设
        q.limit = None;
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            child("desc", instantiate_named("sort_provider", ctx)),
            // 默认 page_size=100 入口，方便 UI
            child("x100x", instantiate_paginate(100, ctx)),
            child("x500x", instantiate_paginate(500, ctx)),
            child("x1000x", instantiate_paginate(1000, ctx)),
        ])
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
        // xNNNx → paginate_router(page_size=NNN)
        if let Some(inner) = name.strip_prefix('x').and_then(|s| s.strip_suffix('x')) {
            if let Ok(n) = inner.parse::<i64>() {
                if (10..=1000).contains(&n) {
                    return instantiate_paginate(n, ctx);
                }
            }
        }
        // 数字段：默认 page_size=100 路径
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
}

fn instantiate_paginate(page_size: i64, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
    let mut props = HashMap::new();
    props.insert("page_size".into(), TemplateValue::Int(page_size));
    instantiate_with("gallery_paginate_router", props, ctx)
}

// ── gallery_paginate_router ──────────────────────────────────────────────────

/// 给定 page_size，list 出 1..N 页码，每页 → query_page_provider(page_size, page_num)。
pub struct GalleryPaginateRouter {
    pub page_size: i64,
}

impl Provider for GalleryPaginateRouter {
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // delegate to page_size_provider via instantiate
        let mut props = HashMap::new();
        props.insert("page_size".into(), TemplateValue::Int(self.page_size));
        if let Some(p) = instantiate_with("page_size_provider", props, ctx) {
            return p.list(composed, ctx);
        }
        Ok(Vec::new())
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
        let n: i64 = name.parse().ok()?;
        if n <= 0 {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("page_size".into(), TemplateValue::Int(self.page_size));
        props.insert("page_num".into(), TemplateValue::Int(n));
        instantiate_with("query_page_provider", props, ctx)
    }
}

impl GalleryPaginateRouter {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let page_size = prop_i64(props, "page_size")?;
        Ok(Self { page_size })
    }
}
