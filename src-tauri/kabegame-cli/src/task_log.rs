//! 任务日志的 i18n 载荷渲染。
//!
//! core 的非插件日志不存文本，而是 `{"_i18n":{"k":"taskLogXxx","p":{...}}}`（见
//! `kabegame_core::crawler::task_log_i18n`），由界面按语言翻译。CLI 在这里做同样的事：
//! 文案唯一来源是前端 `packages/kabegame-i18n/src/locales/<lang>/tasks.json`，编译期嵌入，
//! 不在 Rust 侧另抄一份。语义对齐 `TaskLogDialog.vue` 的 `formatTaskLogLine`：
//! 不是载荷、解析失败或找不到 key 时原样返回；当前语言缺 key 时回退 en（同前端 fallbackLocale）。

use serde_json::Value;
use std::sync::OnceLock;

macro_rules! tasks_json {
    ($lang:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/kabegame-i18n/src/locales/",
            $lang,
            "/tasks.json"
        ))
    };
}

fn locale_source(lang: &str) -> &'static str {
    match lang {
        "zh" => tasks_json!("zh"),
        "zhtw" => tasks_json!("zhtw"),
        "ja" => tasks_json!("ja"),
        "ko" => tasks_json!("ko"),
        _ => tasks_json!("en"),
    }
}

static LANGUAGE: OnceLock<String> = OnceLock::new();

/// 设置渲染语言（应用设置里的界面语言）：app 模式经 `SettingsGetLanguage` IPC 取主程序的值，
/// local 模式读本进程已初始化的 `Settings`。须在第一条日志渲染前调用；未设置时按 en 渲染。
pub fn set_language(lang: String) {
    let _ = LANGUAGE.set(lang);
}

/// [应用设置的语言, en]；两者相同时只有一项。
fn tables() -> &'static [Value] {
    static TABLES: OnceLock<Vec<Value>> = OnceLock::new();
    TABLES.get_or_init(|| {
        let lang = LANGUAGE.get().map(String::as_str).unwrap_or("en");
        let mut langs = vec![lang];
        if lang != "en" {
            langs.push("en");
        }
        langs
            .into_iter()
            .filter_map(|lang| serde_json::from_str(locale_source(lang)).ok())
            .collect()
    })
}

/// 把一条任务日志渲染成可读文本；非 i18n 载荷原样返回。
pub fn render(message: &str) -> String {
    render_with(tables(), message).unwrap_or_else(|| message.to_string())
}

fn render_with(tables: &[Value], message: &str) -> Option<String> {
    let trimmed = message.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let payload: Value = serde_json::from_str(trimmed).ok()?;
    let i18n = payload.get("_i18n")?;
    let key = i18n.get("k")?.as_str()?;
    let template = tables.iter().find_map(|table| lookup(table, key))?;
    Some(interpolate(template, i18n.get("p")))
}

/// `tasks.json` 里的 key 可能是点分路径（前端以 `tasks.<k>` 取值）。
fn lookup<'a>(table: &'a Value, key: &str) -> Option<&'a str> {
    key.split('.')
        .try_fold(table, |node, segment| node.get(segment))?
        .as_str()
}

/// 替换 `{name}` 占位符；参数缺失时保留占位符原文。
fn interpolate(template: &str, params: Option<&Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match params.and_then(|p| p.get(name)) {
            Some(Value::String(s)) => out.push_str(s),
            Some(Value::Null) | None => out.push_str(&rest[start..start + end + 2]),
            Some(other) => out.push_str(&other.to_string()),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zh_en() -> Vec<Value> {
        ["zh", "en"]
            .into_iter()
            .map(|lang| serde_json::from_str(locale_source(lang)).unwrap())
            .collect()
    }

    #[test]
    fn renders_known_key_with_params() {
        let msg = r#"{"_i18n":{"k":"taskLogDownloadRetry","p":{"attempt":1,"max":3,"detail":"Native download failed"}}}"#;
        assert_eq!(
            render_with(&zh_en(), msg).as_deref(),
            Some("下载失败，正在重试（1/3）: Native download failed")
        );
    }

    #[test]
    fn falls_back_to_en_table_when_key_missing_in_first() {
        let only_en_has = serde_json::json!({});
        let en: Value = serde_json::from_str(locale_source("en")).unwrap();
        let msg = r#"{"_i18n":{"k":"taskLogWebpageNone","p":{}}}"#;
        let rendered = render_with(&[only_en_has, en.clone()], msg).unwrap();
        assert_eq!(Some(rendered.as_str()), lookup(&en, "taskLogWebpageNone"));
    }

    #[test]
    fn leaves_plain_and_unknown_messages_untouched() {
        let tables = zh_en();
        assert_eq!(render_with(&tables, "[konachan] 打开页面 1/1"), None);
        assert_eq!(render_with(&tables, "{not json"), None);
        assert_eq!(
            render_with(&tables, r#"{"_i18n":{"k":"noSuchKey","p":{}}}"#),
            None
        );
    }

    #[test]
    fn keeps_placeholder_when_param_missing() {
        assert_eq!(
            interpolate("a {x} b {y}", Some(&serde_json::json!({"x": 1}))),
            "a 1 b {y}"
        );
    }
}
