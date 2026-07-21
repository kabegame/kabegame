use deno_core::{resolve_url, serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions};

use super::Plugin;
use crate::emitter::GlobalEmitter;
use crate::storage::Storage;

pub fn spawn_metadata_migrations_for_plugin(plugin: Plugin) {
    if plugin.metadata_migration.is_none() {
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

/// 单一脚本 + packed 插件版本门控：选出 `plugin_version < 当前插件 packed 版本` 的
/// metadata 行，逐行调用 `migrate(input)`，成功后把行的 plugin_version 盖为 packed。
/// 行级失败只记录并跳过（版本不动，下次触发重试）；脚本装载失败整体报错。
pub fn run_metadata_migrations_for_plugin(plugin: &Plugin) -> Result<bool, String> {
    let Some(script) = plugin.metadata_migration.as_deref() else {
        return Ok(false);
    };
    let target = plugin.version_packed;

    let rows = Storage::global().metadata_rows_below_plugin_version(&plugin.id, target)?;
    if rows.is_empty() {
        return Ok(false);
    }

    let plugin_id = plugin.id.clone();
    let script = script.to_string();
    // The migration engine owns a single-threaded `JsRuntime`, so the async body
    // is driven with `block_on` on the current thread. Both entry points reach
    // here from a `spawn_blocking` worker, where `Handle::current()` is valid and
    // `block_on` is permitted.
    let changed = tokio::runtime::Handle::current().block_on(async move {
        let mut engine = MigrationEngine::new();
        let func = engine
            .load_script(&script)
            .await
            .map_err(|e| format!("迁移脚本装载失败: {e}"))?;

        let mut changed = false;
        for (row_id, data, _row_version) in rows {
            match engine.call_migrate(&func, data).await {
                Ok(migrated) => {
                    if Storage::global()
                        .writeback_migrated_metadata_row(row_id, &plugin_id, target, &migrated)?
                    {
                        changed = true;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[metadata-migration] plugin `{}` row {} migrate failed: {}",
                        plugin_id, row_id, e
                    );
                }
            }
        }

        Ok::<bool, String>(changed)
    })?;

    if changed {
        if let Some(emitter) = GlobalEmitter::try_global() {
            let plugin_ids = vec![plugin.id.clone()];
            emitter.emit_images_change("metadata-migrate", &[], None, None, Some(&plugin_ids));
        }
    }
    Ok(changed)
}

/// CLI 本地测试入口：对 `input` JSON 跑一次 `migrate(input)` 并返回结果。
pub fn test_metadata_migration(input: String, script: String) -> Result<String, String> {
    tokio::runtime::Handle::current().block_on(async move {
        let mut engine = MigrationEngine::new();
        let func = engine
            .load_script(&script)
            .await
            .map_err(|e| format!("迁移脚本装载失败: {e}"))?;
        engine
            .call_migrate(&func, input)
            .await
            .map_err(|e| format!("迁移脚本执行失败: {e}"))
    })
}

/// Bare `deno_core` runtime for the metadata migration script.
///
/// The migration script is a self-contained ES module exporting
/// `export function migrate(input) { return output; }` (async is allowed). The
/// runtime registers no extensions, no ops and no snapshot: native
/// `JSON`/`RegExp`/`Date`/`String` cover everything the old Rhai engine exposed
/// via `parse_json`/`to_json`/`re_*`/chrono. `module_loader` is `None`, so any
/// `import` inside a migration script fails — scripts must be self-contained.
struct MigrationEngine {
    runtime: JsRuntime,
}

impl MigrationEngine {
    fn new() -> Self {
        Self {
            runtime: JsRuntime::new(RuntimeOptions::default()),
        }
    }

    /// Load the migration script (`metadata_migrations/migrate.js`) as a side
    /// module and return its `migrate` export.
    async fn load_script(&mut self, source: &str) -> Result<v8::Global<v8::Function>, String> {
        let specifier = resolve_url("file:///metadata_migrations/migrate.js")
            .map_err(|e| format!("解析模块地址失败: {e}"))?;
        let mod_id = self
            .runtime
            .load_side_es_module_from_code(&specifier, source.to_string())
            .await
            .map_err(|e| e.to_string())?;
        let eval = self.runtime.mod_evaluate(mod_id);
        self.runtime
            .run_event_loop(PollEventLoopOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        eval.await.map_err(|e| e.to_string())?;

        let namespace = self
            .runtime
            .get_module_namespace(mod_id)
            .map_err(|e| e.to_string())?;
        deno_core::scope!(scope, &mut self.runtime);
        let ns = v8::Local::new(scope, namespace);
        let key =
            v8::String::new(scope, "migrate").ok_or_else(|| "无法分配 `migrate` 键".to_string())?;
        let value = ns
            .get(scope, key.into())
            .ok_or_else(|| "迁移脚本缺少 `migrate` 导出".to_string())?;
        let func = v8::Local::<v8::Function>::try_from(value)
            .map_err(|_| "迁移脚本的 `migrate` 导出不是函数".to_string())?;
        Ok(v8::Global::new(scope, func))
    }

    /// Call `migrate(input) -> String`. `migrate` may be async; the returned
    /// promise is driven by `with_event_loop_promise`.
    async fn call_migrate(
        &mut self,
        func: &v8::Global<v8::Function>,
        input: String,
    ) -> Result<String, String> {
        let arg: v8::Global<v8::Value> = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = serde_v8::to_v8(scope, input).map_err(|e| e.to_string())?;
            v8::Global::new(scope, local)
        };
        let call = self.runtime.call_with_args(func, &[arg]);
        let result = self
            .runtime
            .with_event_loop_promise(call, PollEventLoopOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        deno_core::scope!(scope, &mut self.runtime);
        let local = v8::Local::new(scope, result);
        serde_v8::from_v8::<String>(scope, local)
            .map_err(|_| "migrate() 必须返回 JSON 字符串".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Migration engines drive their `JsRuntime` with `block_on`, which panics on
    /// an async worker thread. Run each case on a blocking-pool thread, mirroring
    /// the `spawn_blocking` production callers.
    fn run_blocking<F, T>(f: F) -> T
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async { tokio::task::spawn_blocking(f).await.unwrap() })
    }

    #[test]
    fn js_migration_regexp_named_captures() {
        let script = r#"
export function migrate(text) {
  const re = /(?<name>[a-z]+):(\d+)/g;
  const out = [...text.matchAll(re)].map((m) => ({
    "0": m[0], "1": m[1], "2": m[2], name: m.groups.name,
  }));
  return JSON.stringify(out);
}
"#
        .to_string();
        let output =
            run_blocking(move || test_metadata_migration("alpha:12 beta:34".to_string(), script))
                .expect("js migration should run");
        let value: serde_json::Value =
            serde_json::from_str(&output).expect("captures should serialize to JSON");
        assert_eq!(value[0]["0"], "alpha:12");
        assert_eq!(value[0]["1"], "alpha");
        assert_eq!(value[0]["2"], "12");
        assert_eq!(value[0]["name"], "alpha");
        assert_eq!(value[1]["name"], "beta");
    }

    #[test]
    fn js_migration_schema_branch_and_passthrough() {
        // 单一脚本按 metadata 内 schema 自检：老结构迁移，新结构原样返回（幂等）。
        let script = r#"
export function migrate(input) {
  const m = JSON.parse(input);
  if (m.schema === 2) return input;
  return JSON.stringify({ schema: 2, title: m.legacyTitle ?? m.title ?? "" });
}
"#
        .to_string();
        let script2 = script.clone();

        let migrated = run_blocking(move || {
            test_metadata_migration(r#"{"legacyTitle":"old"}"#.to_string(), script)
        })
        .expect("legacy input should migrate");
        let value: serde_json::Value = serde_json::from_str(&migrated).unwrap();
        assert_eq!(value["schema"], 2);
        assert_eq!(value["title"], "old");

        let current = r#"{"schema":2,"title":"new"}"#.to_string();
        let passthrough = run_blocking(move || test_metadata_migration(current.clone(), script2))
            .expect("current input should pass through");
        assert_eq!(passthrough, r#"{"schema":2,"title":"new"}"#);
    }

    #[test]
    fn js_migration_async_migrate() {
        let script = r#"
export async function migrate(input) {
  const m = JSON.parse(input);
  m.done = await Promise.resolve(true);
  return JSON.stringify(m);
}
"#
        .to_string();
        let output = run_blocking(move || test_metadata_migration("{}".to_string(), script))
            .expect("async migrate should run");
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["done"], true);
    }

    #[test]
    fn js_migration_missing_export_errors() {
        let script = "export const notMigrate = 1;".to_string();
        let err = run_blocking(move || test_metadata_migration("{}".to_string(), script))
            .expect_err("missing migrate export should error");
        assert!(err.contains("migrate"), "unexpected error: {err}");
    }

    #[test]
    fn js_migration_non_string_return_errors() {
        let script = "export function migrate(_input) { return 42; }".to_string();
        let err = run_blocking(move || test_metadata_migration("{}".to_string(), script))
            .expect_err("non-string return should error");
        assert!(err.contains("字符串"), "unexpected error: {err}");
    }
}
