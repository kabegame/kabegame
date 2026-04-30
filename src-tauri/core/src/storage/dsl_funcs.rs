//! 主机 SQL 函数 (sqlite scalar functions): 把业务侧元数据 (PluginManager / albums / tasks
//! 等) 暴露给 DSL 的 SQL 上下文。注册由 [`super::Storage::new`] 在打开 connection +
//! schema migration 完成后调用。
//!
//! 当前提供:
//! - [`get_plugin`](plugin_id [, locale]) → JSON_TEXT
//!   返回 `{"id","name","description","baseUrl"}`; plugin 不存在 → `"null"`。
//!   name / description 按 locale 解析 (locale 缺省走 [`kabegame_i18n::current_vd_locale`])。
//! - `vd_display_name(canonical)` → 当前 VD locale 下的路径显示名。
//! - `crawled_at_seconds(timestamp)` → 规整秒/毫秒时间戳。
//!
//! 约束: host SQL function 不得访问当前 Storage/SQLite 连接。数据库中可查的数据应直接写
//! SQL；否则会在 `KabegameSqlExecutor` 持有连接 mutex 期间重入同一把锁。

use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::plugin::PluginManager;

static GET_PLUGIN_PROFILE_CALLS: AtomicU64 = AtomicU64::new(0);
static GET_PLUGIN_PROFILE_MICROS: AtomicU64 = AtomicU64::new(0);

fn get_plugin_profile_enabled() -> bool {
    let Ok(filter) = std::env::var("PATHQL_PROFILE") else {
        return false;
    };
    let filter = filter.trim();
    if filter.is_empty() || matches!(filter, "0" | "false" | "off") {
        return false;
    }
    matches!(filter, "1" | "true" | "all")
        || filter.contains("plugin")
        || filter.contains("get_plugin")
}

fn profile_get_plugin_call(plugin_id: &str, locale: Option<&str>, started: Instant, result: &str) {
    if !get_plugin_profile_enabled() {
        return;
    }

    let last_us = started.elapsed().as_micros() as u64;
    let calls = GET_PLUGIN_PROFILE_CALLS.fetch_add(1, Ordering::Relaxed) + 1;
    let total_us = GET_PLUGIN_PROFILE_MICROS.fetch_add(last_us, Ordering::Relaxed) + last_us;
    if calls <= 20 || calls % 100 == 0 {
        eprintln!(
            "[pathql-profile] host_fn=get_plugin calls={calls} last_us={last_us} total_ms={} plugin_id={plugin_id:?} locale={locale:?} result_null={}",
            total_us / 1000,
            result == "null",
        );
    }
}

/// 在给定 connection 上注册所有 DSL 主机 SQL 函数。
/// connection-scoped — 每个连接需独立注册。kabegame 当前单连接架构, 一次即可。
pub(crate) fn register_dsl_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    register_get_plugin(conn)?;
    register_crawled_at_seconds(conn)?;
    register_vd_display_name(conn)?;
    Ok(())
}

/// `vd_display_name(canonical)` — 当前全局 locale 下 canonical 段名 (如
/// `'subAlbums'` / `'hidden-album'` / `'image'`) 的本地化字符串。读取 thread-local
/// `current_vd_locale()`, 与 programmatic 的 `kabegame_i18n::vd_display_name` 等价。
fn register_vd_display_name(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "vd_display_name",
        1,
        FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let canonical: String = ctx.get(0)?;
            Ok(kabegame_i18n::vd_display_name(&canonical))
        },
    )
}

/// `crawled_at_seconds(t)` — 把 `images.crawled_at` (可能 ms 或 s 时间戳) 规整为秒。
/// 阈值 253402300799 (= 9999-12-31 23:59:59 unix epoch seconds): 大于此值视作毫秒
/// (除以 1000), 否则原样。用于替换全工程 4 处重复的 `CASE WHEN crawled_at > 253402300799 ...`
/// 表达式 (date 函数 / time filter / 等)。
fn register_crawled_at_seconds(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "crawled_at_seconds",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let v: i64 = ctx.get(0)?;
            Ok(if v > 253_402_300_799 { v / 1000 } else { v })
        },
    )
}

fn register_get_plugin(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "get_plugin",
        -1, // 1-2 参数 (id, [locale])
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let argc = ctx.len();
            if argc == 0 {
                return Err(rusqlite::Error::UserFunctionError(
                    "get_plugin: expected at least 1 argument (plugin_id)".into(),
                ));
            }
            let plugin_id: String = ctx.get(0)?;
            let locale: Option<String> = if argc >= 2 {
                let raw: rusqlite::types::Value = ctx.get(1)?;
                match raw {
                    rusqlite::types::Value::Text(s) => Some(s),
                    rusqlite::types::Value::Null => None,
                    _ => None,
                }
            } else {
                None
            };
            let started = Instant::now();
            let result = get_plugin_json(&plugin_id, locale.as_deref());
            profile_get_plugin_call(&plugin_id, locale.as_deref(), started, &result);
            Ok(result)
        },
    )
}

/// 返回 plugin 基础元数据 JSON 对象字符串; plugin 不存在时返回 `"null"`。
/// PluginManager 未初始化也走这个路径 — 测试期常见。
fn get_plugin_json(plugin_id: &str, locale: Option<&str>) -> String {
    let Some(pm) = PluginManager::global_opt() else {
        return "null".into();
    };
    let Some(plugin) = pm.get_sync(plugin_id) else {
        return "null".into();
    };
    let locale_owned;
    let locale_str: &str = match locale {
        Some(l) => l,
        None => {
            locale_owned = kabegame_i18n::current_vd_locale().to_string();
            locale_owned.as_str()
        }
    };
    let name = resolve_i18n_text(&plugin.name, locale_str);
    let description = resolve_i18n_text(&plugin.description, locale_str);
    serde_json::json!({
        "id": plugin.id,
        "name": name,
        "description": description,
        "baseUrl": plugin.base_url,
    })
    .to_string()
}

/// 解析多语言对象 (`{default, zh, en, ja, zhtw, ...}`) 为单字符串。
/// 优先级: 完整 locale → 前缀 (按 `_` 切) → `default` → `en` → 空串。
/// 标量字符串直接透传。
fn resolve_i18n_text(value: &serde_json::Value, locale: &str) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    let Some(obj) = value.as_object() else {
        return String::new();
    };
    if let Some(s) = obj.get(locale).and_then(|v| v.as_str()) {
        return s.into();
    }
    if let Some(prefix) = locale.split('_').next() {
        if !prefix.is_empty() && prefix != locale {
            if let Some(s) = obj.get(prefix).and_then(|v| v.as_str()) {
                return s.into();
            }
        }
    }
    if let Some(s) = obj.get("default").and_then(|v| v.as_str()) {
        return s.into();
    }
    if let Some(s) = obj.get("en").and_then(|v| v.as_str()) {
        return s.into();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_i18n_text_exact_locale_match() {
        let v = json!({"default":"foo","zh":"中文","en":"english"});
        assert_eq!(resolve_i18n_text(&v, "zh"), "中文");
        assert_eq!(resolve_i18n_text(&v, "en"), "english");
    }

    #[test]
    fn resolve_i18n_text_prefix_match() {
        let v = json!({"default":"foo","zh":"中文","en":"english"});
        assert_eq!(resolve_i18n_text(&v, "zh_CN"), "中文");
        assert_eq!(resolve_i18n_text(&v, "en_US"), "english");
    }

    #[test]
    fn resolve_i18n_text_falls_back_to_default() {
        let v = json!({"default":"foo","zh":"中文"});
        // "ja" not present + no "ja_" prefix collision → default
        assert_eq!(resolve_i18n_text(&v, "ja"), "foo");
    }

    #[test]
    fn resolve_i18n_text_falls_back_to_en_then_empty() {
        let v = json!({"en":"english"});
        assert_eq!(resolve_i18n_text(&v, "fr"), "english");

        let v2 = json!({"only-some-key":"x"});
        assert_eq!(resolve_i18n_text(&v2, "fr"), "");
    }

    #[test]
    fn resolve_i18n_text_string_passthrough() {
        let v = json!("plain string");
        assert_eq!(resolve_i18n_text(&v, "zh"), "plain string");
    }

    #[test]
    fn resolve_i18n_text_nonobject_nonstring_returns_empty() {
        let v = json!(42);
        assert_eq!(resolve_i18n_text(&v, "zh"), "");
        let v = json!(null);
        assert_eq!(resolve_i18n_text(&v, "zh"), "");
    }

    #[test]
    fn get_plugin_returns_null_for_unknown_id() {
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let result: String = conn
            .query_row("SELECT get_plugin('nonexistent_xyz')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(result, "null");
    }

    #[test]
    fn get_plugin_returns_null_when_plugin_manager_uninit() {
        // 测试期 PluginManager::global_opt() 通常 None → "null"
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let result: String = conn
            .query_row("SELECT get_plugin('pixiv', 'en_US')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(result, "null");
    }

    #[test]
    fn get_plugin_zero_args_errors() {
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let r: Result<String, _> = conn.query_row("SELECT get_plugin()", [], |r| r.get(0));
        assert!(r.is_err());
    }
}
