//! ProviderRuntime 启动期初始化 (OnceLock 单例)。
//!
//! 7c 起: 全部 provider 由 DSL (`dsl_loader::register_embedded_dsl`, 35+ 个 .json5) 提供。
//! 6c 时期的 programmatic 模块已删除。
//!
//! 运行期 SqlExecutor 通过 `Storage::global().db` 注入, 让 DSL 动态 SQL list 能跑真实 sqlite。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use pathql_rs::provider::SqlExecutor;
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::ProviderRuntime;

use super::dsl_loader::{register_embedded_dsl, validate_dsl};
use super::programmatic::plugin_resource::register_plugin_resource_provider;
use super::sql_executor::KabegameSqlExecutor;

static RUNTIME: OnceLock<Arc<ProviderRuntime>> = OnceLock::new();

/// 全局 ProviderRuntime 引用。首次调用时初始化 (注册 + 实例化 root + 注入 executor)。
pub fn provider_runtime() -> &'static Arc<ProviderRuntime> {
    if let Some(runtime) = RUNTIME.get() {
        return runtime;
    }
    RUNTIME.get_or_init(init_runtime)
}

pub fn provider_template_context() -> TemplateContext {
    let mut ctx = TemplateContext::default();
    ctx.globals = provider_runtime().globals().clone();
    ctx
}

fn init_runtime() -> Arc<ProviderRuntime> {
    // executor 必填; ProviderRuntime::new 接 Arc<dyn SqlExecutor>。
    let executor: Arc<dyn SqlExecutor> = Arc::new(KabegameSqlExecutor::new(
        crate::storage::Storage::global().db.clone(),
    ));
    let mut globals = HashMap::from([
        (
            "favorite_album_id".to_string(),
            TemplateValue::Text(crate::storage::FAVORITE_ALBUM_ID.to_string()),
        ),
        (
            "hidden_album_id".to_string(),
            TemplateValue::Text(crate::storage::HIDDEN_ALBUM_ID.to_string()),
        ),
    ]);
    for (key, label) in [
        ("01", "January"),
        ("02", "February"),
        ("03", "March"),
        ("04", "April"),
        ("05", "May"),
        ("06", "June"),
        ("07", "July"),
        ("08", "August"),
        ("09", "September"),
        ("10", "October"),
        ("11", "November"),
        ("12", "December"),
    ] {
        globals.insert(
            format!("vd_en_US_month.{}", key),
            TemplateValue::Text(label.to_string()),
        );
    }
    for day in 1..=31 {
        let suffix = match day {
            11 | 12 | 13 => "th",
            _ if day % 10 == 1 => "st",
            _ if day % 10 == 2 => "nd",
            _ if day % 10 == 3 => "rd",
            _ => "th",
        };
        globals.insert(
            format!("vd_en_US_day.{:02}", day),
            TemplateValue::Text(format!("{}{}", day, suffix)),
        );
    }
    let runtime = ProviderRuntime::new(executor, globals);
    register_embedded_dsl(&runtime);
    validate_dsl(&runtime);
    runtime
        .register_schema("images", "images", "kabegame", "images_root_provider")
        .unwrap_or_else(|e| panic!("register `images` schema failed: {}", e));
    runtime
        .register_schema("albums", "albums", "kabegame", "albums_root_provider")
        .unwrap_or_else(|e| panic!("register `albums` schema failed: {}", e));
    runtime
        .register_schema("tasks", "tasks", "kabegame", "tasks_root_provider")
        .unwrap_or_else(|e| panic!("register `tasks` schema failed: {}", e));
    runtime
        .register_schema(
            "fail-images",
            "task_failed_images",
            "kabegame",
            "fail_images_root_provider",
        )
        .unwrap_or_else(|e| panic!("register `fail-images` schema failed: {}", e));
    runtime
        .register_schema(
            "surf_records",
            "surf_records",
            "kabegame",
            "surf_records_root_provider",
        )
        .unwrap_or_else(|e| panic!("register `surf_records` schema failed: {}", e));
    register_plugin_resource_provider(&runtime)
        .unwrap_or_else(|e| panic!("register `plugin` provider failed: {}", e));
    runtime
        .register_schema(
            "plugin",
            "(SELECT 1)",
            "kabegame",
            "plugin_resource_root_provider",
        )
        .unwrap_or_else(|e| panic!("register `plugin` schema failed: {}", e));
    runtime
}
