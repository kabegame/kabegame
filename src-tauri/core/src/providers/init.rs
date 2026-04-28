//! ProviderRuntime 启动期初始化（OnceLock 单例）。
//!
//! Phase 6b: 仅注册 33 个硬编码 provider，不接 DSL（Phase 6c 启用 include_dir）。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use pathql_rs::ast::{Namespace, ProviderName};
use pathql_rs::{Provider, ProviderRegistry, ProviderRuntime};

use super::programmatic::register_all_hardcoded;

static RUNTIME: OnceLock<Arc<ProviderRuntime>> = OnceLock::new();

/// 全局 ProviderRuntime 引用。首次调用时初始化（注册 + 实例化 root）。
pub fn provider_runtime() -> &'static Arc<ProviderRuntime> {
    RUNTIME.get_or_init(init_runtime)
}

fn init_runtime() -> Arc<ProviderRuntime> {
    let mut registry = ProviderRegistry::new();
    register_all_hardcoded(&mut registry).expect("register_all_hardcoded failed");
    let registry = Arc::new(registry);

    // 通过 lookup → factory 实例化 root_provider
    let entry = registry
        .lookup(
            &Namespace("kabegame".into()),
            &ProviderName("root_provider".into()),
        )
        .expect("root_provider not registered");

    let root: Arc<dyn Provider> = match entry {
        pathql_rs::registry::RegistryEntry::Programmatic(factory) => factory(&HashMap::new())
            .expect("root_provider factory failed"),
        _ => panic!("root_provider must be programmatic in 6b"),
    };

    ProviderRuntime::new(registry, root)
}
