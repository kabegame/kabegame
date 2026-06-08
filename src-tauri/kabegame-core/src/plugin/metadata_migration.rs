use std::collections::BTreeMap;

use rhai::packages::Package;
use rhai::{Array, Dynamic, Engine, Map, Scope, AST};
use rhai_chrono::ChronoPackage;

use super::rhai::{json_value_to_rhai_dynamic, rhai_dynamic_to_json_value};
use super::Plugin;
use crate::emitter::GlobalEmitter;
use crate::storage::Storage;

pub fn spawn_metadata_migrations_for_plugin(plugin: Plugin) {
    if plugin.metadata_migrations.is_empty() {
        return;
    }
    tokio::task::spawn_blocking(move || {
        if let Err(e) = run_metadata_migrations_for_plugin(&plugin) {
            eprintln!(
                "[metadata-migration] plugin `{}` migration runner failed: {}",
                plugin.id, e
            );
        }
    });
}

pub fn run_metadata_migrations_for_plugin(plugin: &Plugin) -> Result<bool, String> {
    let scripts = migration_script_map(plugin);
    let latest = latest_continuous_version(&scripts);
    if latest == 0 {
        return Ok(false);
    }

    let mut engine = migration_engine();
    let compiled = compile_migrations(&engine, &scripts, latest);
    let rows = Storage::global().metadata_rows_below_version(&plugin.id, latest)?;
    if rows.is_empty() {
        return Ok(false);
    }

    let mut changed = false;
    for (row_id, original_data, row_version) in rows {
        let mut data = original_data;
        let mut cur = row_version;
        for version in (row_version + 1)..=latest {
            let Some(compiled_script) = compiled.get(&version) else {
                break;
            };
            let ast = match compiled_script {
                Ok(ast) => ast,
                Err(e) => {
                    eprintln!(
                        "[metadata-migration] plugin `{}` v{} compile failed: {}",
                        plugin.id, version, e
                    );
                    break;
                }
            };
            match call_migrate(&mut engine, ast, data.clone()) {
                Ok(next_data) => {
                    data = next_data;
                    cur = version;
                }
                Err(e) => {
                    eprintln!(
                        "[metadata-migration] plugin `{}` row {} stopped at v{} -> v{}: {}",
                        plugin.id, row_id, cur, version, e
                    );
                    break;
                }
            }
        }

        if cur > row_version
            && Storage::global().writeback_migrated_metadata_row(row_id, &plugin.id, cur, &data)?
        {
            changed = true;
        }
    }

    if changed {
        if let Some(emitter) = GlobalEmitter::try_global() {
            let plugin_ids = vec![plugin.id.clone()];
            emitter.emit_images_change("metadata-migrate", &[], None, None, Some(&plugin_ids));
        }
    }
    Ok(changed)
}

pub fn test_metadata_migrations(
    input: String,
    scripts: BTreeMap<u32, String>,
) -> Result<String, String> {
    let latest = latest_continuous_version(&scripts);
    if latest == 0 {
        return Err("未找到连续迁移脚本：需要 v1.rhai".to_string());
    }

    let mut engine = migration_engine();
    let compiled = compile_migrations(&engine, &scripts, latest);
    let mut data = input;
    for version in 1..=latest {
        let compiled_script = compiled
            .get(&version)
            .ok_or_else(|| format!("缺少已计划的迁移脚本 v{version}.rhai"))?;
        let ast = compiled_script
            .as_ref()
            .map_err(|e| format!("v{version} 编译失败: {e}"))?;
        data = call_migrate(&mut engine, ast, data)
            .map_err(|e| format!("v{version} 执行失败: {e}"))?;
    }
    Ok(data)
}

fn migration_engine() -> Engine {
    let mut engine = Engine::new();
    engine.set_max_expr_depths(128, 64);
    ChronoPackage::new().register_into_engine(&mut engine);
    engine.register_fn(
        "parse_json",
        |text: &str| -> Result<Dynamic, Box<rhai::EvalAltResult>> {
            let value = serde_json::from_str::<serde_json::Value>(text)
                .map_err(|e| format!("parse_json: {e}"))?;
            Ok(json_value_to_rhai_dynamic(&value))
        },
    );
    engine.register_fn(
        "to_json",
        |value: Dynamic| -> Result<String, Box<rhai::EvalAltResult>> {
            let json = rhai_dynamic_to_json_value(&value)
                .map_err(|e| Box::<rhai::EvalAltResult>::from(e.to_string()))?;
            serde_json::to_string(&json)
                .map_err(|e| Box::<rhai::EvalAltResult>::from(format!("to_json: {e}")))
        },
    );
    engine.register_fn("re_is_match", |pattern: &str, text: &str| -> bool {
        regex::Regex::new(pattern)
            .map(|re| re.is_match(text))
            .unwrap_or(false)
    });
    engine.register_fn(
        "re_replace_all",
        |pattern: &str, replacement: &str, text: &str| -> String {
            regex::Regex::new(pattern)
                .map(|re| re.replace_all(text, replacement).into_owned())
                .unwrap_or_else(|_| text.to_string())
        },
    );
    engine.register_fn("re_find_all", |pattern: &str, text: &str| -> Array {
        let Ok(re) = regex::Regex::new(pattern) else {
            return Array::new();
        };
        let capture_names: Vec<String> = re
            .capture_names()
            .flatten()
            .map(|name| name.to_string())
            .collect();
        let mut matches = Array::new();
        for captures in re.captures_iter(text) {
            let mut item = Map::new();
            for index in 0..captures.len() {
                if let Some(matched) = captures.get(index) {
                    item.insert(
                        index.to_string().into(),
                        Dynamic::from(matched.as_str().to_string()),
                    );
                }
            }
            for name in &capture_names {
                if let Some(matched) = captures.name(name) {
                    item.insert(
                        name.as_str().into(),
                        Dynamic::from(matched.as_str().to_string()),
                    );
                }
            }
            matches.push(Dynamic::from_map(item));
        }
        matches
    });
    engine
}

fn migration_script_map(plugin: &Plugin) -> BTreeMap<u32, String> {
    plugin
        .metadata_migrations
        .iter()
        .filter(|(version, _)| *version > 0)
        .map(|(version, source)| (*version, source.clone()))
        .collect()
}

fn latest_continuous_version(scripts: &BTreeMap<u32, String>) -> u32 {
    let mut version = 0;
    loop {
        let next = version + 1;
        if scripts.contains_key(&next) {
            version = next;
        } else {
            return version;
        }
    }
}

fn compile_migrations(
    engine: &Engine,
    scripts: &BTreeMap<u32, String>,
    latest: u32,
) -> BTreeMap<u32, Result<AST, String>> {
    let mut compiled = BTreeMap::new();
    for version in 1..=latest {
        if let Some(source) = scripts.get(&version) {
            compiled.insert(
                version,
                engine
                    .compile(source)
                    .map_err(|e| format!("compile v{version}: {e}")),
            );
        }
    }
    compiled
}

fn call_migrate(engine: &mut Engine, ast: &AST, input: String) -> Result<String, String> {
    let mut scope = Scope::new();
    engine
        .call_fn::<String>(&mut scope, ast, "migrate", (input,))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_engine_re_find_all_returns_capture_maps() {
        let mut engine = migration_engine();
        let ast = engine
            .compile(
                r#"
                fn migrate(text) {
                    let captures = re_find_all("(?P<name>[a-z]+):(\\d+)", text);
                    to_json(captures)
                }
                "#,
            )
            .expect("test migration script should compile");

        let output = call_migrate(&mut engine, &ast, "alpha:12 beta:34".to_string())
            .expect("test migration script should run");
        let value: serde_json::Value =
            serde_json::from_str(&output).expect("captures should serialize to JSON");

        assert_eq!(value[0]["0"], "alpha:12");
        assert_eq!(value[0]["1"], "alpha");
        assert_eq!(value[0]["2"], "12");
        assert_eq!(value[0]["name"], "alpha");
        assert_eq!(value[1]["name"], "beta");
    }
}
