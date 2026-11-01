//! 只读加载 Wallpaper Engine 安装目录中的界面词表（`locale\ui_<语言码>.json`），给属性面板的
//! `ui_` 词条做本地化。只读文件，不写、不复制 WPE 目录下的任何东西，也不把词表带进仓库。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// 语言码 → 整张词表；读不到（没装 WPE、语言文件缺失、JSON 坏）也缓存为空表，进程内只读一次。
static TABLES: OnceLock<Mutex<HashMap<String, HashMap<String, String>>>> = OnceLock::new();

/// WPE 内置词条的译文：只认 `ui_` 开头的键，非 Windows 或找不到时返回 None。
pub fn builtin_term(language: &str, key: &str) -> Option<String> {
    if !key.starts_with("ui_") || !super::discover::platform_supported() {
        return None;
    }
    let tables = TABLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut tables = tables.lock().ok()?;
    let table = tables.entry(language.to_owned()).or_insert_with(|| {
        for engine in super::discover::engine_dirs() {
            let file = engine.join("locale").join(format!("ui_{language}.json"));
            let Ok(content) = std::fs::read_to_string(file) else {
                continue;
            };
            let Ok(Value::Object(values)) = serde_json::from_str::<Value>(&content) else {
                continue;
            };
            return values
                .into_iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key, text.to_owned())))
                .collect();
        }
        HashMap::new()
    });
    table.get(key).cloned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn ignores_non_builtin_keys() {
        assert_eq!(super::builtin_term("zh-chs", "plain"), None);
    }
}
