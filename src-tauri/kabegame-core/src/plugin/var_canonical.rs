use super::{VarDefinition, VarOption};
use serde_json::{Map, Value};
use std::collections::HashMap;

fn option_variables(def: &VarDefinition) -> Vec<String> {
    def.options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|option| match option {
            VarOption::String(value) => value.clone(),
            VarOption::Item { variable, .. } => variable.clone(),
        })
        .collect()
}

/// 将历史任务/配置里后端曾接受的宽松空值转换为当前规范值。
pub(crate) fn canonicalize_legacy_value(def: Option<&VarDefinition>, value: Value) -> Value {
    let Some(def) = def else {
        return match value {
            Value::Array(items) if items.is_empty() => Value::Null,
            Value::Object(ref object)
                if !object.is_empty()
                    && object.values().all(|value| value.as_bool() == Some(false)) =>
            {
                Value::Null
            }
            value => value,
        };
    };

    match def.var_type.as_str() {
        "string" | "date" | "path" | "file" | "folder" | "file_or_folder" => match value {
            Value::String(text) if text.trim().is_empty() => Value::Null,
            value => value,
        },
        "options" => match value {
            Value::String(text)
                if text.is_empty()
                    && !option_variables(def)
                        .iter()
                        .any(|variable| variable.is_empty()) =>
            {
                Value::Null
            }
            value => value,
        },
        "int" => match value {
            Value::String(text) if text.trim().is_empty() => Value::Null,
            Value::String(text) => text
                .trim()
                .parse::<i64>()
                .map(Value::from)
                .unwrap_or(Value::String(text)),
            value => value,
        },
        "float" => match value {
            Value::String(text) if text.trim().is_empty() => Value::Null,
            Value::String(text) => text
                .trim()
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::String(text)),
            value => value,
        },
        "list" => match value {
            Value::Array(items) if items.is_empty() => Value::Null,
            value => value,
        },
        "checkbox" => {
            let variables = option_variables(def);
            let selected = match value {
                Value::Array(items) => items
                    .into_iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect::<Vec<_>>(),
                Value::Object(object) => variables
                    .iter()
                    .filter(|variable| object.get(*variable).and_then(Value::as_bool) == Some(true))
                    .cloned()
                    .collect::<Vec<_>>(),
                value => return value,
            };
            if selected.is_empty() {
                Value::Null
            } else {
                Value::Object(
                    variables
                        .into_iter()
                        .map(|variable| {
                            let checked = selected.contains(&variable);
                            (variable, Value::Bool(checked))
                        })
                        .collect(),
                )
            }
        }
        _ => value,
    }
}

pub(crate) fn canonicalize_user_config_value(value: Value, defs: &[VarDefinition]) -> Value {
    let mut object = match value {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    let def_map = defs
        .iter()
        .map(|def| (def.key.as_str(), def))
        .collect::<HashMap<_, _>>();
    for (key, item) in object.iter_mut() {
        *item = canonicalize_legacy_value(def_map.get(key.as_str()).copied(), item.take());
    }
    object.retain(|key, item| {
        !(item.is_null()
            && def_map
                .get(key.as_str())
                .is_some_and(|def| def.var_type == "boolean"))
    });
    Value::Object(object)
}

/// 推荐预设导入判定的唯一 user_config 比较口径：先按插件变量定义规范化，再把 null 当作缺键。
pub(crate) fn canonical_user_config_for_compare(value: Value, defs: &[VarDefinition]) -> Value {
    let mut canonical = canonicalize_user_config_value(value, defs);
    if let Some(object) = canonical.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    canonical
}
