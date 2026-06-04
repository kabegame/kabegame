use std::collections::BTreeMap;

use rhai::packages::Package;
use rhai::{Dynamic, Engine, Scope, AST};
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
