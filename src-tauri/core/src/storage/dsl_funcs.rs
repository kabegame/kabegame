//! 主机 SQL 函数 (sqlite scalar functions): 把业务侧元数据 (PluginManager / albums / tasks
//! 等) 暴露给 DSL 的 SQL 上下文。注册由 [`super::Storage::new`] 在打开 connection +
//! schema migration 完成后调用。
//!
//! 当前提供:
//! - [`get_plugin`](plugin_id [, locale]) → JSON_TEXT
//!   返回 `{"id","name","description","baseUrl"}`; plugin 不存在 → `"null"`。
//!   name / description 按 locale 解析 (locale 缺省走 [`kabegame_i18n::current_vd_locale`])。
//! - `get_album(album_id)` → JSON_TEXT
//!   返回 `{"kind":"album","data":{<Album camelCase fields>}}` (与
//!   [`crate::providers::provider::wrap_typed_meta_json`] 输出对齐); album 不存在 → `"null"`。
//!   配合 DSL meta `{"$json": "${get_album(...)}"}` directive 把 JSON 文本直接注入 meta。
//!
//! 扩展模式: `get_<entity>(id [, locale]) -> JSON_TEXT`, 调用方在 DSL 里用
//! `json_extract(get_<entity>(...), '$.<field>')` 拆字段, 或用 `$json` directive 整体注入 meta。

use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

use crate::plugin::PluginManager;
use crate::storage::Storage;

/// 在给定 connection 上注册所有 DSL 主机 SQL 函数。
/// connection-scoped — 每个连接需独立注册。kabegame 当前单连接架构, 一次即可。
pub(crate) fn register_dsl_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    register_get_plugin(conn)?;
    register_get_album(conn)?;
    register_get_task(conn)?;
    register_get_surf_record(conn)?;
    register_crawled_at_seconds(conn)?;
    Ok(())
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

fn register_get_surf_record(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "get_surf_record",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let id: String = ctx.get(0)?;
            Ok(get_surf_record_json(&id))
        },
    )
}

fn register_get_album(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "get_album",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let id: String = ctx.get(0)?;
            Ok(get_album_json(&id))
        },
    )
}

fn register_get_task(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "get_task",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let id: String = ctx.get(0)?;
            Ok(get_task_json(&id))
        },
    )
}

/// 返回 album typed meta JSON 字符串, 与 wrap_typed_meta_json(Album) 一致;
/// album 不存在时返回 `"null"`。
fn get_album_json(album_id: &str) -> String {
    let Ok(Some(album)) = Storage::global().get_album_by_id(album_id) else {
        return "null".into();
    };
    let Ok(data) = serde_json::to_value(&album) else {
        return "null".into();
    };
    serde_json::json!({ "kind": "album", "data": data }).to_string()
}

/// 返回 task typed meta JSON 字符串, 与 wrap_typed_meta_json(Task) 一致;
/// task 不存在时返回 `"null"`。
fn get_task_json(task_id: &str) -> String {
    let Ok(Some(task)) = Storage::global().get_task(task_id) else {
        return "null".into();
    };
    let Ok(data) = serde_json::to_value(&task) else {
        return "null".into();
    };
    serde_json::json!({ "kind": "task", "data": data }).to_string()
}

/// 返回 surf_record typed meta JSON 字符串, 与 wrap_typed_meta_json(SurfRecord) 一致
/// (kind="surfRecord"); 记录不存在时返回 `"null"`。
fn get_surf_record_json(record_id: &str) -> String {
    let Ok(Some(record)) = Storage::global().get_surf_record(record_id) else {
        return "null".into();
    };
    let Ok(data) = serde_json::to_value(&record) else {
        return "null".into();
    };
    serde_json::json!({ "kind": "surfRecord", "data": data }).to_string()
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
            Ok(get_plugin_json(&plugin_id, locale.as_deref()))
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
