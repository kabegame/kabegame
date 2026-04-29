//! 共享 provider：sort。
//!
//! `sort_provider` 是路径解析栈的"基础积木"——order flip。
//! 命名 (注册为 namespace=`kabegame`):
//! - `sort_provider`: order.global = Revert (翻转上游 ORDER 方向)
//!
//! 7b S1e: page_size_provider / query_page_provider 已彻底由 DSL 接管
//! ([dsl/shared/page_size_provider.json5] / [dsl/shared/query_page_provider.json5])。

use std::sync::Arc;

use pathql_rs::ast::OrderDirection;
use pathql_rs::compose::ProviderQuery;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

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
