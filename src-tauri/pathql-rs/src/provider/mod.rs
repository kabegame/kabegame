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
use crate::template::eval::TemplateValue;
use crate::ProviderRegistry;
use std::sync::Arc;
use thiserror::Error;

/// SQL 方言标注。executor 通过 `dialect()` 暴露; build_sql 渲染期据此选 placeholder。
/// 6d 仅 Sqlite 完整覆盖; Postgres 用 `$N`; Mysql 同 Sqlite (`?`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Sqlite,
    Postgres,
    Mysql,
}

/// SQL 执行能力的注入抽象。pathql-rs 不绑驱动; 终端注入实现 (rusqlite / sqlx / 等)。
///
/// 输入: SQL 字符串 + bind 参数序列
/// 输出: 每行 = JSON 对象 (列名 → 值); 用作 `${data_var.col}` 求值上下文
///
/// 错误统一为 [`EngineError`] (含驱动错误转换; 推荐用 `EngineError::FactoryFailed`
/// 把驱动 error 转字符串)。
pub trait SqlExecutor: Send + Sync + 'static {
    /// 当前 executor 服务的 SQL 方言。build_sql 依此选 placeholder 与方言差异语法。
    fn dialect(&self) -> SqlDialect;

    /// 真正的执行入口。
    fn execute(
        &self,
        sql: &str,
        params: &[TemplateValue],
    ) -> Result<Vec<serde_json::Value>, EngineError>;
}

/// 方便测试 / 简单 backend 的闭包桥: `ClosureExecutor::new(dialect, |sql, params| ...)`。
/// 持 connection state 的正式 backend 应该自定义 struct + impl SqlExecutor。
pub struct ClosureExecutor<F> {
    dialect: SqlDialect,
    f: F,
}

impl<F> ClosureExecutor<F>
where
    F: Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
        + Send
        + Sync
        + 'static,
{
    pub fn new(dialect: SqlDialect, f: F) -> Self {
        Self { dialect, f }
    }
}

impl<F> SqlExecutor for ClosureExecutor<F>
where
    F: Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
        + Send
        + Sync
        + 'static,
{
    fn dialect(&self) -> SqlDialect {
        self.dialect
    }
    fn execute(
        &self,
        sql: &str,
        params: &[TemplateValue],
    ) -> Result<Vec<serde_json::Value>, EngineError> {
        (self.f)(sql, params)
    }
}

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
    }

    #[test]
    fn closure_executor_dialect_returned_unchanged() {
        let exec = ClosureExecutor::new(SqlDialect::Sqlite, |_sql, _params| Ok(Vec::new()));
        assert_eq!(exec.dialect(), SqlDialect::Sqlite);

        let exec_pg = ClosureExecutor::new(SqlDialect::Postgres, |_sql, _params| Ok(Vec::new()));
        assert_eq!(exec_pg.dialect(), SqlDialect::Postgres);
    }

    #[test]
    fn closure_executor_execute_calls_inner_fn() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = count.clone();
        let exec = ClosureExecutor::new(SqlDialect::Sqlite, move |sql, _params| {
            count_clone.fetch_add(1, Ordering::SeqCst);
            assert_eq!(sql, "SELECT 1");
            Ok(vec![serde_json::json!({"x": 1})])
        });
        let rows = exec.execute("SELECT 1", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
