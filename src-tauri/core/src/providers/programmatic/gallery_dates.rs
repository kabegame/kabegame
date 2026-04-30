//! Gallery 日期分组（年→月→日）。
//! - `gallery_dates_router`: 列年份；每个年份子节点
//! - `gallery_date_year_provider` (with `year`): 列月份
//! - `gallery_date_month_provider` (with `year_month`): 列日期
//! - `gallery_date_day_provider` (with `ymd`): 终端，挂分页

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::OrderDirection;
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use crate::storage::Storage;

use super::gallery_filters::{default_pagination_children, default_pagination_resolve};
use super::helpers::{child, instantiate_named, instantiate_with, prop_string};

// ── gallery_dates_router ─────────────────────────────────────────────────────

pub struct GalleryDatesRouter;

impl Provider for GalleryDatesRouter {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
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
        let groups = Storage::global()
            .get_gallery_date_groups()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "dates".into(), e))?;
        let years: BTreeSet<String> = groups
            .into_iter()
            .filter_map(|g| {
                if g.year_month.len() >= 4 {
                    Some(g.year_month[..4].to_string())
                } else {
                    None
                }
            })
            .collect();
        Ok(years
            .into_iter()
            .map(|y| {
                let mut props = HashMap::new();
                props.insert("year".into(), TemplateValue::Text(y.clone()));
                let provider = instantiate_with("gallery_date_year_provider", props, ctx);
                child(format!("{y}y"), provider)
            })
            .collect())
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let s = name.trim();
        if s.len() != 5 || !s.ends_with('y') {
            return None;
        }
        let y = &s[..4];
        if !y.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mut props = HashMap::new();
        props.insert("year".into(), TemplateValue::Text(y.into()));
        instantiate_with("gallery_date_year_provider", props, ctx)
    }
}

// ── gallery_date_year_provider ───────────────────────────────────────────────

pub struct GalleryDateYearProvider {
    pub year: String,
}

impl GalleryDateYearProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            year: prop_string(props, "year")?,
        })
    }
}

impl Provider for GalleryDateYearProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let sql = "strftime('%Y', crawled_at_seconds(images.crawled_at), 'unixepoch') = ?";
        let mut q = current.with_where_raw(sql, &[TemplateValue::Text(self.year.clone())]);
        q.limit = None;
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let mut out = vec![child("desc", instantiate_named("sort_provider", ctx))];
        let groups = Storage::global()
            .get_gallery_date_groups()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "dates".into(), e))?;
        let prefix = format!("{}-", self.year);
        for g in groups {
            if g.year_month.len() == 7 && g.year_month.starts_with(&prefix) {
                let mm = g.year_month[5..7].to_string();
                let mut props = HashMap::new();
                props.insert(
                    "year_month".into(),
                    TemplateValue::Text(g.year_month.clone()),
                );
                out.push(child(
                    format!("{mm}m"),
                    instantiate_with("gallery_date_month_provider", props, ctx),
                ));
            }
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
        // MMm format
        let s = name.trim();
        if s.len() == 3 && s.ends_with('m') {
            let mm = &s[..2];
            if mm.chars().all(|c| c.is_ascii_digit()) {
                let year_month = format!("{}-{}", self.year, mm);
                let mut props = HashMap::new();
                props.insert("year_month".into(), TemplateValue::Text(year_month));
                return instantiate_with("gallery_date_month_provider", props, ctx);
            }
        }
        // 直接分页（全年）
        default_pagination_resolve(name, ctx)
    }
}

// ── gallery_date_month_provider ──────────────────────────────────────────────

pub struct GalleryDateMonthProvider {
    pub year_month: String,
}

impl GalleryDateMonthProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            year_month: prop_string(props, "year_month")?,
        })
    }
}

impl Provider for GalleryDateMonthProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let sql = "strftime('%Y-%m', crawled_at_seconds(images.crawled_at), 'unixepoch') = ?";
        let mut q = current.with_where_raw(sql, &[TemplateValue::Text(self.year_month.clone())]);
        q.limit = None;
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let mut out = vec![child("desc", instantiate_named("sort_provider", ctx))];
        let prefix = format!("{}-", self.year_month);
        let days = Storage::global()
            .get_gallery_day_groups()
            .map_err(|e| EngineError::FactoryFailed("kabegame".into(), "days".into(), e))?;
        for d in days {
            if d.ymd.len() == 10 && d.ymd.starts_with(&prefix) {
                let dd = d.ymd[8..10].to_string();
                let mut props = HashMap::new();
                props.insert("ymd".into(), TemplateValue::Text(d.ymd.clone()));
                out.push(child(
                    format!("{dd}d"),
                    instantiate_with("gallery_date_day_provider", props, ctx),
                ));
            }
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
        let s = name.trim();
        if s.len() == 3 && s.ends_with('d') {
            let dd = &s[..2];
            if dd.chars().all(|c| c.is_ascii_digit()) {
                let ymd = format!("{}-{}", self.year_month, dd);
                let mut props = HashMap::new();
                props.insert("ymd".into(), TemplateValue::Text(ymd));
                return instantiate_with("gallery_date_day_provider", props, ctx);
            }
        }
        default_pagination_resolve(name, ctx)
    }
}

// ── gallery_date_day_provider ────────────────────────────────────────────────

pub struct GalleryDateDayProvider {
    pub ymd: String,
}

impl GalleryDateDayProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        Ok(Self {
            ymd: prop_string(props, "ymd")?,
        })
    }
}

impl Provider for GalleryDateDayProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let sql = "strftime('%Y-%m-%d', crawled_at_seconds(images.crawled_at), 'unixepoch') = ?";
        let mut q = current.with_where_raw(sql, &[TemplateValue::Text(self.ymd.clone())]);
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
