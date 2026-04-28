//! ProviderRuntime 启动期初始化 (OnceLock 单例)。
//!
//! 6c 起: registry 同时持有
//! - 程序化 provider (`programmatic::register_all_hardcoded`, ~31 个非 DSL 名)
//! - DSL provider (`dsl_loader::load_dsl_into`, 9 个 .json5)
//!
//! root 由 DslProvider 包装 root_provider 的 ProviderDef 担任。运行期 SqlExecutor
//! 通过 `Storage::global().db` 注入, 让 DSL 动态 SQL list 能跑真实 sqlite。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use pathql_rs::provider::{DslProvider, SqlExecutor};
use pathql_rs::{Provider, ProviderRegistry, ProviderRuntime};

use super::dsl_loader::{load_dsl_into, validate_dsl};
use super::programmatic::register_all_hardcoded;
use super::sql_executor::KabegameSqlExecutor;

static RUNTIME: OnceLock<Arc<ProviderRuntime>> = OnceLock::new();

/// 全局 ProviderRuntime 引用。首次调用时初始化 (注册 + 实例化 root + 注入 executor)。
pub fn provider_runtime() -> &'static Arc<ProviderRuntime> {
    RUNTIME.get_or_init(init_runtime)
}

fn init_runtime() -> Arc<ProviderRuntime> {
    let mut registry = ProviderRegistry::new();
    register_all_hardcoded(&mut registry).expect("register_all_hardcoded failed");
    let root_def = load_dsl_into(&mut registry);
    validate_dsl(&registry);

    let registry = Arc::new(registry);

    let root: Arc<dyn Provider> = Arc::new(DslProvider {
        def: Arc::new(root_def),
        properties: HashMap::new(),
    });

    // 6d: executor 必填; ProviderRuntime::new 接 Arc<dyn SqlExecutor>。
    let executor: Arc<dyn SqlExecutor> = Arc::new(KabegameSqlExecutor::new(
        crate::storage::Storage::global().db.clone(),
    ));
    ProviderRuntime::new(registry, root, executor)
}
