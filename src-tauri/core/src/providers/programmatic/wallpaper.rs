use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{NumberOrTemplate, OrderDirection};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use super::helpers::{instantiate_with, prop_i64, prop_string};

pub struct GallerySequentialRouter;

impl Provider for GallerySequentialRouter {
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
        let mut props = HashMap::new();
        let current_id = if name == "-" { "" } else { name.trim() };
        props.insert("current_id".into(), TemplateValue::Text(current_id.into()));
        instantiate_with("gallery_sequential_current_provider", props, ctx)
    }
}

pub struct GallerySequentialCurrentProvider {
    current_id: Option<String>,
}

impl GallerySequentialCurrentProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let current_id = prop_string(props, "current_id")?;
        Ok(Self {
            current_id: if current_id.trim().is_empty() {
                None
            } else {
                Some(current_id)
            },
        })
    }
}

impl Provider for GallerySequentialCurrentProvider {
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
        let limit = name.parse::<i64>().ok()?.clamp(1, 1000);
        let mut props = HashMap::new();
        props.insert("limit".into(), TemplateValue::Int(limit));
        props.insert(
            "current_id".into(),
            TemplateValue::Text(self.current_id.clone().unwrap_or_default()),
        );
        instantiate_with("gallery_sequential_provider", props, ctx)
    }
}

pub struct GallerySequentialProvider {
    current_id: Option<String>,
    limit: i64,
}

impl GallerySequentialProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let current_id = prop_string(props, "current_id")?;
        Ok(Self {
            current_id: if current_id.trim().is_empty() {
                None
            } else {
                Some(current_id)
            },
            limit: prop_i64(props, "limit")?.clamp(1, 1000),
        })
    }
}

impl Provider for GallerySequentialProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
        if let Some(id) = &self.current_id {
            q = q.with_where_raw("images.id > ?", &[TemplateValue::Text(id.clone())]);
        }
        q.order
            .entries
            .insert(0, ("images.id".into(), OrderDirection::Asc));
        q.limit = Some(NumberOrTemplate::Number(self.limit as f64));
        q
    }

    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())
    }

    fn resolve(
        &self,
        _name: &str,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        None
    }
}
