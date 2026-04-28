//! 共用 helper：ChildEntry 构造、path resolution wrapper 等。

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{Namespace, ProviderName};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext, ProviderRegistry};

/// 默认命名空间。
pub fn ns_kabegame() -> Namespace {
    Namespace("kabegame".into())
}

/// 实例化命名 provider（无 properties / 无 meta）。
pub fn instantiate_named(
    name: &str,
    ctx: &ProviderContext,
) -> Option<Arc<dyn Provider>> {
    ctx.registry.instantiate(
        &ns_kabegame(),
        &ProviderName(name.into()),
        &HashMap::new(),
        ctx,
    )
}

/// 实例化命名 provider 并注入 properties。
pub fn instantiate_with(
    name: &str,
    props: HashMap<String, TemplateValue>,
    ctx: &ProviderContext,
) -> Option<Arc<dyn Provider>> {
    ctx.registry.instantiate(
        &ns_kabegame(),
        &ProviderName(name.into()),
        &props,
        ctx,
    )
}

/// 构造 ChildEntry，meta 字段为 None。
pub fn child(name: impl Into<String>, provider: Option<Arc<dyn Provider>>) -> ChildEntry {
    ChildEntry {
        name: name.into(),
        provider,
        meta: None,
    }
}

/// 构造 ChildEntry，meta 由 wrap_typed_meta_json helper 提供。
pub fn child_with_meta(
    name: impl Into<String>,
    provider: Option<Arc<dyn Provider>>,
    meta: serde_json::Value,
) -> ChildEntry {
    ChildEntry {
        name: name.into(),
        provider,
        meta: Some(meta),
    }
}

/// 在 registry 注册一个 provider 工厂；常见模式：register(reg, "name", |_props| Ok(Arc::new(SomeProvider))).
pub fn register<F>(
    reg: &mut ProviderRegistry,
    name: &str,
    factory: F,
) -> Result<(), pathql_rs::RegistryError>
where
    F: Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
        + Send
        + Sync
        + 'static,
{
    reg.register_provider(
        ns_kabegame(),
        pathql_rs::ast::SimpleName(name.into()),
        factory,
    )
}

/// 从 properties 取一个 String 值。
pub fn prop_string(
    props: &HashMap<String, TemplateValue>,
    key: &str,
) -> Result<String, EngineError> {
    match props.get(key) {
        Some(TemplateValue::Text(s)) => Ok(s.clone()),
        Some(other) => Err(EngineError::FactoryFailed(
            "kabegame".into(),
            key.into(),
            format!("expected Text, got {:?}", other),
        )),
        None => Err(EngineError::FactoryFailed(
            "kabegame".into(),
            key.into(),
            "missing property".into(),
        )),
    }
}

/// 从 properties 取一个 i64 值（接受 Int/Real/Text 自动转）。
pub fn prop_i64(
    props: &HashMap<String, TemplateValue>,
    key: &str,
) -> Result<i64, EngineError> {
    match props.get(key) {
        Some(TemplateValue::Int(i)) => Ok(*i),
        Some(TemplateValue::Real(f)) => Ok(*f as i64),
        Some(TemplateValue::Text(s)) => s.parse().map_err(|_| {
            EngineError::FactoryFailed(
                "kabegame".into(),
                key.into(),
                format!("non-numeric `{}`", s),
            )
        }),
        Some(other) => Err(EngineError::FactoryFailed(
            "kabegame".into(),
            key.into(),
            format!("expected number, got {:?}", other),
        )),
        None => Err(EngineError::FactoryFailed(
            "kabegame".into(),
            key.into(),
            "missing property".into(),
        )),
    }
}

/// 把 ProviderQuery 折叠后的 composed 喂给 storage 求 count。
pub fn count_for(composed: &ProviderQuery) -> Result<usize, String> {
    crate::storage::Storage::global().get_images_count_by_query(composed)
}
