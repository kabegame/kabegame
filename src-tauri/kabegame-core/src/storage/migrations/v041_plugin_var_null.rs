use crate::plugin::{PluginManager, VarDefinition, VarOption};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;

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
pub(crate) fn canonicalize_legacy_value(
    def: Option<&VarDefinition>,
    value: Value,
) -> Value {
    let Some(def) = def else {
        return match value {
            Value::Array(items) if items.is_empty() => Value::Null,
            Value::Object(ref object)
                if !object.is_empty()
                    && object
                        .values()
                        .all(|value| value.as_bool() == Some(false)) =>
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

fn installed_var_defs() -> HashMap<String, Vec<VarDefinition>> {
    let manager = PluginManager::global_opt();
    let fallback;
    let manager = match manager {
        Some(manager) => manager,
        None => {
            fallback = PluginManager::new();
            &fallback
        }
    };
    let mut all = manager
        .builtin_plugins()
        .into_iter()
        .map(|plugin| (plugin.id.clone(), plugin.var_defs.clone()))
        .collect::<HashMap<_, _>>();
    let plugins_dir = crate::app_paths::AppPaths::global().plugins_dir();
    let Ok(entries) = fs::read_dir(&plugins_dir) else {
        return all;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("kgpg") {
            continue;
        }
        let Some(plugin_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        match manager.get_plugin_vars_from_file(&path) {
            Ok(defs) => {
                all.insert(plugin_id.to_string(), defs);
            }
            Err(error) => eprintln!(
                "[db-migration] v041 读取插件变量失败 {}: {error}",
                path.display()
            ),
        }
    }
    all
}

fn canonicalize_config_json(
    raw: &str,
    defs: Option<&[VarDefinition]>,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("解析 user_config JSON 失败: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "user_config 必须是 JSON 对象".to_string())?;
    let def_map = defs
        .unwrap_or_default()
        .iter()
        .map(|def| (def.key.as_str(), def))
        .collect::<HashMap<_, _>>();
    for (key, item) in object.iter_mut() {
        *item = canonicalize_legacy_value(def_map.get(key.as_str()).copied(), item.take());
    }
    // 旧版默认配置生成器给无 default 的键写过显式 null；boolean 不接受 null，
    // 删掉该键让合并回落到插件 default / 隐式 false。
    object.retain(|key, item| {
        !(item.is_null()
            && def_map
                .get(key.as_str())
                .is_some_and(|def| def.var_type == "boolean"))
    });
    serde_json::to_string(&value).map_err(|error| format!("序列化 user_config JSON 失败: {error}"))
}

fn migrate_table(
    conn: &Connection,
    table: &str,
    defs_by_plugin: &HashMap<String, Vec<VarDefinition>>,
) -> Result<(), String> {
    let sql = format!("SELECT id, plugin_id, user_config FROM {table} WHERE user_config IS NOT NULL");
    let rows = {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|error| format!("v041 查询 {table}: {error}"))?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("v041 读取 {table}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("v041 解析 {table}: {error}"))?;
        rows
    };

    let update_sql = format!("UPDATE {table} SET user_config = ?1 WHERE id = ?2");
    for (id, plugin_id, raw) in rows {
        let canonical = canonicalize_config_json(
            &raw,
            defs_by_plugin.get(&plugin_id).map(Vec::as_slice),
        )?;
        if canonical != raw {
            conn.execute(&update_sql, params![canonical, id])
                .map_err(|error| format!("v041 更新 {table}: {error}"))?;
        }
    }
    Ok(())
}

fn migrate_default_config_files(defs_by_plugin: &HashMap<String, Vec<VarDefinition>>) {
    let dir = crate::app_paths::AppPaths::global().default_configs_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let result = (|| -> Result<(), String> {
            let plugin_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "默认配置文件名不是 UTF-8".to_string())?;
            let raw = fs::read_to_string(&path)
                .map_err(|error| format!("读取默认配置失败: {error}"))?;
            let mut root: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("解析默认配置失败: {error}"))?;
            let Some(user_config) = root.get_mut("userConfig") else {
                return Ok(());
            };
            let canonical = canonicalize_config_json(
                &serde_json::to_string(user_config).map_err(|error| error.to_string())?,
                defs_by_plugin.get(plugin_id).map(Vec::as_slice),
            )?;
            *user_config = serde_json::from_str(&canonical).map_err(|error| error.to_string())?;
            let output = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
            fs::write(&path, output).map_err(|error| format!("写入默认配置失败: {error}"))
        })();
        if let Err(error) = result {
            eprintln!(
                "[db-migration] v041 迁移默认配置失败 {}: {error}",
                path.display()
            );
        }
    }
}

pub fn up(conn: &Connection) -> Result<(), String> {
    let defs_by_plugin = installed_var_defs();
    migrate_table(conn, "run_configs", &defs_by_plugin)?;
    migrate_table(conn, "tasks", &defs_by_plugin)?;
    migrate_default_config_files(&defs_by_plugin);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(value: Value) -> VarDefinition {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn canonicalizes_legacy_values_with_and_without_definition() {
        let string = var(serde_json::json!({"key": "s", "type": "string", "name": "S"}));
        let option = var(serde_json::json!({
            "key": "o", "type": "options", "name": "O",
            "options": [{"name": "Any", "variable": ""}]
        }));
        let list = var(serde_json::json!({"key": "l", "type": "list", "name": "L"}));
        let int = var(serde_json::json!({"key": "i", "type": "int", "name": "I"}));
        let checkbox = var(serde_json::json!({
            "key": "c", "type": "checkbox", "name": "C", "options": ["a", "b"]
        }));

        assert_eq!(canonicalize_legacy_value(Some(&string), serde_json::json!("  ")), Value::Null);
        assert_eq!(canonicalize_legacy_value(Some(&option), serde_json::json!("")), serde_json::json!(""));
        assert_eq!(canonicalize_legacy_value(Some(&list), serde_json::json!([])), Value::Null);
        assert_eq!(canonicalize_legacy_value(Some(&int), serde_json::json!("42")), serde_json::json!(42));
        assert_eq!(
            canonicalize_legacy_value(Some(&checkbox), serde_json::json!(["b"])),
            serde_json::json!({"a": false, "b": true})
        );
        assert_eq!(
            canonicalize_legacy_value(Some(&checkbox), serde_json::json!({"a": false, "b": false})),
            Value::Null
        );
        assert_eq!(canonicalize_legacy_value(None, serde_json::json!("")), serde_json::json!(""));
        assert_eq!(canonicalize_legacy_value(None, serde_json::json!([])), Value::Null);
        assert_eq!(
            canonicalize_legacy_value(None, serde_json::json!({"a": false})),
            Value::Null
        );
    }

    #[test]
    fn drops_null_boolean_written_by_legacy_default_generator() {
        let defs = vec![
            var(serde_json::json!({"key": "flag", "type": "boolean", "name": "F"})),
            var(serde_json::json!({"key": "text", "type": "string", "name": "T"})),
        ];
        let out = canonicalize_config_json(r#"{"flag":null,"text":null}"#, Some(&defs)).unwrap();
        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out, serde_json::json!({"text": null}));
    }
}
