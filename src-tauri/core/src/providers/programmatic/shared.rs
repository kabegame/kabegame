//! 共享 provider：sort / page_size / query_page。
//!
//! 这些是路径解析栈的"基础积木"——pagination chain 与 sort flip 由这里实现。
//! 命名 (注册为 namespace=`kabegame`):
//! - `sort_provider`: order.global = Revert (翻转上游 ORDER 方向)
//! - `page_size_provider`: stateless 路由壳，仅 list 出页码 1..N（基于 composed COUNT）
//! - `query_page_provider`: 终端节点，apply_query 设置 offset + limit (来自 `page_size` / `page_num` properties)

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{NumberOrTemplate, OrderDirection, TemplateExpr};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

use super::helpers::{child, count_for, instantiate_with, prop_i64};

// ── sort_provider ────────────────────────────────────────────────────────────

/// `desc/`: 翻转上游所有 ORDER 方向。
pub struct SortProvider;

impl Provider for SortProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
        q.order.global = Some(OrderDirection::Revert);
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

// ── page_size_provider ───────────────────────────────────────────────────────

/// `page_size_provider`: 给定 `page_size` 属性，列出页码 1..N（按 composed COUNT 计算）。
/// 子节点是 `query_page_provider` 实例（带 page_size + page_num）。
pub struct PageSizeProvider {
    pub page_size: i64,
}

impl Provider for PageSizeProvider {
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let total = count_for(composed).unwrap_or(0);
        if total == 0 || self.page_size <= 0 {
            return Ok(Vec::new());
        }
        let ps = self.page_size as usize;
        let total_pages = total.div_ceil(ps);
        let mut out = Vec::with_capacity(total_pages);
        for n in 1..=total_pages {
            let mut props = HashMap::new();
            props.insert("page_size".into(), TemplateValue::Int(self.page_size));
            props.insert("page_num".into(), TemplateValue::Int(n as i64));
            let provider = instantiate_with("query_page_provider", props, ctx);
            out.push(child(n.to_string(), provider));
        }
        Ok(out)
    }

    fn resolve(
        &self,
        name: &str,
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
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

// ── query_page_provider ──────────────────────────────────────────────────────

/// `query_page_provider`: 终端节点。apply_query 设置 limit + offset。
/// offset = page_size * (page_num - 1) ；limit = page_size。
pub struct QueryPageProvider {
    pub page_size: i64,
    pub page_num: i64,
}

impl Provider for QueryPageProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        let mut q = current;
        // 渲染时计算 offset = page_size * (page_num - 1)
        let offset_expr = format!(
            "{} * ({} - 1)",
            self.page_size,
            self.page_num.max(1)
        );
        q.offset_terms
            .push(NumberOrTemplate::Template(TemplateExpr(offset_expr)));
        q.limit = Some(NumberOrTemplate::Number(self.page_size as f64));
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

impl QueryPageProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let page_size = prop_i64(props, "page_size")?;
        let page_num = prop_i64(props, "page_num")?;
        Ok(Self { page_size, page_num })
    }
}

impl PageSizeProvider {
    pub fn from_props(props: &HashMap<String, TemplateValue>) -> Result<Self, EngineError> {
        let page_size = prop_i64(props, "page_size")?;
        Ok(Self { page_size })
    }
}
