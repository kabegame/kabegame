//! pathql Provider 体系内核 (RULES §12)。
//!
//! - [`Provider`] trait + [`ChildEntry`] + [`EngineError`] 在本 mod
//! - [`DslProvider`] 在 [`dsl_provider`] 子模块
//! - [`ProviderRuntime`] 在 [`runtime`] 子模块

pub mod dsl_provider;
pub mod runtime;

pub use dsl_provider::{DslProvider, EmptyDslProvider};
pub use runtime::{ProviderRuntime, ResolvedNode};

use crate::compose::{BuildError, FoldError, ProviderQuery, RenderError};
use crate::ProviderRegistry;
use std::sync::Arc;
use thiserror::Error;

/// 调用 Provider 方法时由 runtime 在入口构造并向下传递。
/// 同一 ctx 在路径解析的整个 fold loop 中复用; 方法返回后 drop。
pub struct ProviderContext {
    pub registry: Arc<ProviderRegistry>,
    /// 由 runtime 内部 `Weak<Self>` 在入口 upgrade 而来。
    pub runtime: Arc<ProviderRuntime>,
}

#[derive(Clone)]
pub struct ChildEntry {
    pub name: String,
    pub provider: Option<Arc<dyn Provider>>,
    pub meta: Option<serde_json::Value>,
}

impl std::fmt::Debug for ChildEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChildEntry")
            .field("name", &self.name)
            .field("provider", &self.provider.as_ref().map(|_| "<Provider>"))
            .field("meta", &self.meta)
            .finish()
    }
}

pub trait Provider: Send + Sync {
    /// 折叠 ProviderQuery。
    /// DelegateQuery 通过 ctx.runtime 重定向; ContribQuery 走 fold_contrib。
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        current
    }

    /// 枚举所有可见子节点。
    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError>;

    /// 给定段名定位单个子 provider。语义按 §5.2 (regex resolve → 静态 list 字面 → 动态反查)。
    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>>;

    /// 自描述文本 (§12.2; note: 字段, 支持 ${properties.X} 等模板)。
    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> {
        None
    }

    /// EmptyInvocation 占位识别 (§12.3 + §4.4 缓存契约)。
    /// runtime 见 true 时跳过缓存写入。
    fn is_empty(&self) -> bool {
        false
    }
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("path not found: `{0}`")]
    PathNotFound(String),
    #[error("provider `{0}.{1}` not registered")]
    ProviderNotRegistered(String, String),
    #[error("fold error: {0}")]
    Fold(#[from] FoldError),
    #[error("render error: {0}")]
    Render(#[from] RenderError),
    #[error("build error: {0}")]
    Build(#[from] BuildError),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("factory failed for `{0}.{1}`: {2}")]
    FactoryFailed(String, String, String),
    #[error("executor not provided in runtime; dynamic SQL requires SqlExecutor injection")]
    ExecutorMissing,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::SqlExpr;

    struct Mock;
    impl Provider for Mock {
        fn apply_query(&self, mut q: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
            q.from = Some(SqlExpr("mock_table".into()));
            q
        }
        fn list(
            &self,
            _composed: &ProviderQuery,
            _ctx: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(vec![ChildEntry {
                name: "child".into(),
                provider: None,
                meta: None,
            }])
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

    #[test]
    fn mock_provider_compiles_and_works_without_ctx_use() {
        let m: Arc<dyn Provider> = Arc::new(Mock);
        // is_empty default = false
        assert!(!m.is_empty());
    }

    #[test]
    fn child_entry_clone_and_construct() {
        let c = ChildEntry {
            name: "x".into(),
            provider: None,
            meta: Some(serde_json::json!({"k": "v"})),
        };
        let c2 = c.clone();
        assert_eq!(c2.name, "x");
        assert_eq!(c2.meta.as_ref().unwrap(), &serde_json::json!({"k": "v"}));
    }

    #[test]
    fn engine_error_display() {
        let e = EngineError::PathNotFound("/a/b".into());
        assert!(format!("{}", e).contains("/a/b"));
        let e = EngineError::ProviderNotRegistered("ns".into(), "name".into());
        assert!(format!("{}", e).contains("ns"));
        assert!(format!("{}", e).contains("name"));
        let e = EngineError::FactoryFailed("ns".into(), "x".into(), "missing prop".into());
        assert!(format!("{}", e).contains("missing prop"));
        let e = EngineError::ExecutorMissing;
        assert!(format!("{}", e).contains("executor"));
    }
}
