//! Embedded V8 (deno_core) plugin runtime.
//!
//! Platform gate: desktop + Android (only iOS is excluded).

use deno_core::{
    Extension, ExtensionArguments, JsRuntime, PollEventLoopOptions, RuntimeOptions,
    anyhow::{Result as AnyhowResult, anyhow},
    extension, resolve_url, serde_v8, v8,
};
use deno_fs::FileSystemRc;
use deno_web::{BlobStore, InMemoryBroadcastChannel};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use super::PluginScript;
use crate::crawler::task_scheduler::{Task, TaskError, TaskResult};
use crate::plugin::Plugin;

mod ops;
pub(crate) mod snapshot;
pub use ops::KabegameOpState;

extension!(
    kabegame_v8,
    ops = [
        ops::op_kabegame_to,
        ops::op_kabegame_back,
        ops::op_kabegame_current_url,
        ops::op_kabegame_current_html,
        ops::op_kabegame_current_headers,
        ops::op_kabegame_fetch,
        ops::op_kabegame_fs_root,
        ops::op_kabegame_plugin_data,
        ops::op_kabegame_set_plugin_data,
        ops::op_kabegame_set_header,
        ops::op_kabegame_require_cookie,
        ops::op_kabegame_del_header,
        ops::op_kabegame_warn,
        ops::op_kabegame_log,
        ops::op_kabegame_add_progress,
        ops::op_kabegame_download_image,
        ops::op_kabegame_create_image_metadata,
    ],
    esm_entry_point = "ext:kabegame_v8/prelude.js",
    esm = [ dir "src/plugin/v8", "deno_dom_wasm_noinit.js", "prelude.js" ],
    options = {
        ctx: KabegameOpState,
    },
    state = |state, options| {
        let parser = Arc::new(deno_permissions::RuntimePermissionDescriptorParser::new(
            sys_traits::impls::RealSys,
        ));
        state.put(deno_permissions::PermissionsContainer::allow_all(parser));
        state.put(Arc::new(deno_features::FeatureChecker::default()));
        state.put(options.ctx);
    },
    docs = "Kabegame V8 crawler host ops.",
);

/// Entry module file name for in-memory, self-contained V8 crawler code.
const ENTRY_FILE_NAME: &str = "crawl.v8.js";

// deno_crypto creates cppgc objects which cannot be serialized into a V8
// startup snapshot. Both fresh and restored runtimes attach these globals only
// after their isolate has a live CppHeap.
const CRYPTO_INIT_SCRIPT: &str = r#"const _cm = Deno.core.loadExtScript("ext:deno_crypto/00_crypto.js");
Object.assign(globalThis, {
  Crypto: _cm.Crypto,
  crypto: _cm.crypto,
  CryptoKey: _cm.CryptoKey,
  SubtleCrypto: _cm.SubtleCrypto,
});"#;

/// Full initialization used by fresh runtimes and baseline snapshot creation.
///
/// INVARIANT: this list, `lazy_extensions`, and `lazy_extension_args` must keep
/// identical names/order, with `kabegame_v8` last. Snapshot sidecar validation
/// and V8 external-reference indexing both depend on it.
pub(crate) fn base_extensions(ctx: KabegameOpState, fs: FileSystemRc) -> Vec<Extension> {
    let blob_store = BlobStore::default_arc();
    vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(blob_store, None, false, InMemoryBroadcastChannel::default()),
        deno_crypto::deno_crypto::init(None),
        deno_io::deno_io::init(None),
        deno_fs::deno_fs::init(fs),
        kabegame_v8::init(ctx),
    ]
}

fn lazy_extensions() -> Vec<Extension> {
    vec![
        deno_webidl::deno_webidl::lazy_init(),
        deno_web::deno_web::lazy_init(),
        deno_crypto::deno_crypto::lazy_init(),
        deno_io::deno_io::lazy_init(),
        deno_fs::deno_fs::lazy_init(),
        kabegame_v8::lazy_init(),
    ]
}

fn lazy_extension_args(ctx: KabegameOpState, fs: FileSystemRc) -> Vec<ExtensionArguments> {
    let blob_store = BlobStore::default_arc();
    vec![
        deno_webidl::deno_webidl::args(),
        deno_web::deno_web::args(blob_store, None, false, InMemoryBroadcastChannel::default()),
        deno_crypto::deno_crypto::args(None),
        deno_io::deno_io::args(None),
        deno_fs::deno_fs::args(fs),
        kabegame_v8::args(ctx),
    ]
}

/// Embedded V8 plugin runtime.
pub struct JsPluginRuntime {
    runtime: JsRuntime,
}

impl JsPluginRuntime {
    /// Assemble a runtime with Kabegame host ops wired into OpState.
    pub fn new(ctx: KabegameOpState, fs: FileSystemRc) -> AnyhowResult<Self> {
        if let Some(blob) = snapshot::try_load() {
            match Self::with_snapshot(ctx.clone(), fs.clone(), blob) {
                Ok(runtime) => return Ok(runtime),
                Err(error) => {
                    eprintln!("[v8-snapshot] restore failed, falling back to fresh init: {error}");
                    snapshot::disable_and_invalidate();
                }
            }
        } else {
            // Do not add snapshot generation latency to the first task.
            snapshot::spawn_generate_if_missing();
        }

        Self::fresh(ctx, fs)
    }

    /// Restore extension ESM from the shared baseline snapshot, then inject
    /// per-task native state and initialize crypto in the new isolate's CppHeap.
    fn with_snapshot(
        ctx: KabegameOpState,
        fs: FileSystemRc,
        blob: &'static [u8],
    ) -> AnyhowResult<Self> {
        let started = std::time::Instant::now();
        let mut runtime = JsRuntime::try_new(RuntimeOptions {
            module_loader: None,
            startup_snapshot: Some(blob),
            extensions: lazy_extensions(),
            ..Default::default()
        })?;
        runtime.lazy_init_extensions(lazy_extension_args(ctx, fs))?;
        runtime.execute_script("<kabegame_crypto_init>", CRYPTO_INIT_SCRIPT)?;
        eprintln!(
            "[v8-snapshot] restored runtime in {} ms",
            started.elapsed().as_millis()
        );
        Ok(Self { runtime })
    }

    /// Build a runtime without a snapshot. This retains the previous eager
    /// extension initialization behavior as the compatibility fallback.
    fn fresh(ctx: KabegameOpState, fs: FileSystemRc) -> AnyhowResult<Self> {
        let started = std::time::Instant::now();
        // No V8 startup snapshot: extensions are initialized eagerly with `init(...)`,
        // which registers their lazy_loaded_js and evaluates their ESM — including the
        // kabegame_v8 prelude — during `JsRuntime::new`. The prelude's
        // `Deno.core.loadExtScript` calls resolve against those normally-registered
        // sources, so no separate `residual_lazy_js_sources` table is needed.
        // `kabegame_v8` stays LAST so deno_web/deno_crypto/deno_io/deno_fs are
        // registered before the prelude runs. Networking is host-side
        // (op_kabegame_fetch), so there is no
        // deno_fetch: Headers/Response are implemented in prelude.js.
        let mut runtime = JsRuntime::new(RuntimeOptions {
            module_loader: None,
            startup_snapshot: None,
            extensions: base_extensions(ctx, fs),
            ..Default::default()
        });
        // deno_crypto ships 00_crypto.js as lazy_loaded_js (not auto-attached). Load
        // it now that the isolate exists and attach the crypto globals the prelude
        // deliberately omits.
        runtime.execute_script("<kabegame_crypto_init>", CRYPTO_INIT_SCRIPT)?;
        eprintln!(
            "[v8-snapshot] fresh runtime initialized in {} ms",
            started.elapsed().as_millis()
        );
        Ok(Self { runtime })
    }

    /// Mutable access for the scheduling boundary that owns cancellation
    /// watchers. `JsRuntime` remains single-threaded and must not be moved into
    /// spawned tasks.
    pub fn runtime_mut(&mut self) -> &mut JsRuntime {
        &mut self.runtime
    }

    /// Load a self-contained `crawl.v8.js` module and call
    /// `export async function crawl(common, custom)`.
    ///
    /// Runtime contract:
    /// - The module specifier is `file:///{plugin_id}/crawl.v8.js` for readable
    ///   stack traces.
    /// - The file must be self-contained. `module_loader = None`, so any
    ///   runtime `import` fails instead of resolving SDK or node_modules files.
    /// - `crawl` may be sync or async. Top-level await is supported.
    /// - `common` contains host-owned stable config such as `base_url`; `custom`
    ///   is the plugin's merged user config and preserves JSON `null`.
    /// - The return value is ignored. Effects are produced through host ops.
    pub async fn run_crawl(
        &mut self,
        plugin_id: &str,
        entry_code: String,
        common: JsonValue,
        custom: JsonValue,
    ) -> AnyhowResult<()> {
        self.ensure_dom_parser_ready().await?;

        let specifier = resolve_url(&format!("file:///{plugin_id}/{ENTRY_FILE_NAME}"))?;
        let mod_id = self
            .runtime
            .load_main_es_module_from_code(&specifier, entry_code)
            .await?;
        let eval = self.runtime.mod_evaluate(mod_id);
        self.runtime.run_event_loop(Default::default()).await?;
        eval.await?;

        let namespace = self.runtime.get_module_namespace(mod_id)?;
        let crawl_fn: v8::Global<v8::Function> = {
            deno_core::scope!(scope, &mut self.runtime);
            let ns = v8::Local::new(scope, namespace);
            let key = v8::String::new(scope, "crawl")
                .ok_or_else(|| anyhow!("failed to allocate `crawl` key"))?;
            let value = ns
                .get(scope, key.into())
                .ok_or_else(|| anyhow!("module has no `crawl` export"))?;
            let func = v8::Local::<v8::Function>::try_from(value)
                .map_err(|_| anyhow!("`crawl` export is not a function"))?;
            v8::Global::new(scope, func)
        };

        let common_arg: v8::Global<v8::Value> = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = serde_v8::to_v8(scope, common)?;
            v8::Global::new(scope, local)
        };
        let custom_arg: v8::Global<v8::Value> = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = serde_v8::to_v8(scope, custom)?;
            v8::Global::new(scope, local)
        };

        let call = self
            .runtime
            .call_with_args(&crawl_fn, &[common_arg, custom_arg]);
        self.runtime
            .with_event_loop_promise(call, PollEventLoopOptions::default())
            .await?;

        Ok(())
    }

    async fn ensure_dom_parser_ready(&mut self) -> AnyhowResult<()> {
        let ready_fn = self
            .runtime
            .execute_script(
                "<kabegame_dom_ready>",
                "globalThis[Symbol.for('kabegame.domReady')]",
            )
            .map_err(|e| anyhow!(e))?;
        let ready_fn = {
            deno_core::scope!(scope, &mut self.runtime);
            let value = v8::Local::new(scope, ready_fn);
            let function = v8::Local::<v8::Function>::try_from(value)
                .map_err(|_| anyhow!("Kabegame DOM ready hook is not a function"))?;
            v8::Global::new(scope, function)
        };
        let call = self.runtime.call(&ready_fn);
        self.runtime
            .with_event_loop_promise(call, PollEventLoopOptions::default())
            .await?;
        Ok(())
    }
}

/// V8 backend scheduling entry, wired into the task worker dispatch in
/// `task_scheduler::run_task`.
pub fn execute_crawler_script_v8(run: Arc<Task>) -> TaskResult {
    let plugin = &run.params.plugin;
    let script_content = plugin
        .script
        .v8_source()
        .ok_or_else(|| TaskError::Other(format!("插件 {} 没有提供 V8 脚本", plugin.id)))?
        .to_string();
    let (common, custom) = build_crawl_configs(plugin, run.params.config.clone());
    let plugin_id = run.params.plugin.id.clone();
    let task_id = run.task_id.clone();
    let cancel = run.cancel.clone();
    let fs: FileSystemRc = run.vfs.clone();
    let cancel_for_ctx = cancel.clone();
    let cancel_for_watcher = cancel.clone();

    tokio::runtime::Handle::current().block_on(async move {
        let ctx = KabegameOpState {
            task_id,
            cancel: cancel_for_ctx,
        };
        let mut rt =
            JsPluginRuntime::new(ctx, fs).map_err(|e| TaskError::Other(e.to_string()))?;
        let isolate_handle = rt.runtime_mut().v8_isolate().thread_safe_handle();
        let watcher = tokio::spawn(async move {
            cancel_for_watcher.cancelled().await;
            isolate_handle.terminate_execution();
        });
        let result = rt
            .run_crawl(&plugin_id, script_content, common, custom)
            .await;
        watcher.abort();
        normalize_cancel_error(result, &cancel)
    })
}

fn build_crawl_configs(
    plugin: &Plugin,
    merged_config: HashMap<String, serde_json::Value>,
) -> (JsonValue, JsonValue) {
    let mut common = JsonMap::new();
    let base_url = plugin.base_url.trim();
    common.insert(
        "base_url".to_string(),
        if base_url.is_empty() {
            JsonValue::Null
        } else {
            JsonValue::String(base_url.to_string())
        },
    );
    (
        JsonValue::Object(common),
        JsonValue::Object(merged_config.into_iter().collect()),
    )
}

fn normalize_cancel_error(result: AnyhowResult<()>, cancel: &CancellationToken) -> TaskResult {
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if cancel.is_cancelled()
                || msg.contains("execution terminated")
                || msg.contains("Task canceled")
            {
                Err(TaskError::Canceled)
            } else {
                Err(TaskError::Other(msg))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::crawler::task_scheduler::TaskParams;
    use crate::crawler::{DownloadQueue, TaskScheduler};
    use crate::plugin::PluginBackend;
    use crate::settings::Settings;
    use crate::storage::Storage;
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Once;
    use std::thread;
    use std::time::Duration;

    static INIT_SCHEDULER: Once = Once::new();

    fn init_scheduler() {
        INIT_SCHEDULER.call_once(|| {
            std::env::remove_var("HTTP_PROXY");
            std::env::remove_var("http_proxy");
            std::env::remove_var("HTTPS_PROXY");
            std::env::remove_var("https_proxy");
            std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
            std::env::set_var("no_proxy", "127.0.0.1,localhost");
            // Existing runtime tests exercise the fresh path deterministically;
            // the dedicated snapshot round-trip test calls the restore path
            // directly and is unaffected by this kill switch.
            std::env::set_var("KABEGAME_DISABLE_V8_SNAPSHOT", "1");
            let root =
                std::env::temp_dir().join(format!("kabegame-core-v8-tests-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("create v8 test root");
            let _ = AppPaths::init(AppPaths {
                data_dir: root.join("data"),
                cache_dir: root.join("cache"),
                temp_dir: root.join("tmp"),
                resource_dir: root.join("resources"),
                exe_dir: None,
                external_data_dir: None,
                pictures_dir: Some(root.join("pictures")),
                compatibles_dir_path: root.join("compatibles"),
            });
            let _ = Settings::init_global();
            let _ = Storage::init_global();
            let _ = TaskScheduler::init_global(Arc::new(DownloadQueue::new()));
        });
    }

    fn test_run(task_id: &str, base_url: &str) -> Arc<Task> {
        init_scheduler();
        test_run_with_script(task_id, base_url, PluginScript::default(), HashMap::new())
    }

    fn test_run_with_script(
        task_id: &str,
        base_url: &str,
        script: PluginScript,
        config: HashMap<String, JsonValue>,
    ) -> Arc<Task> {
        init_scheduler();
        let mut plugin = test_plugin(base_url);
        plugin.script = script;
        let run = Arc::new(Task::new(
            task_id.to_string(),
            TaskParams {
                plugin: Arc::new(plugin),
                images_dir: PathBuf::new(),
                output_album_id: None,
                config,
            },
            None,
        ));
        TaskScheduler::global()
            .register_run(Arc::clone(&run))
            .expect("register test run");
        run
    }

    fn test_state(run: &Arc<Task>) -> KabegameOpState {
        KabegameOpState {
            task_id: run.task_id.clone(),
            cancel: run.cancel.clone(),
        }
    }

    fn test_plugin(base_url: &str) -> Plugin {
        Plugin {
            id: "plugin.test".to_string(),
            name: json!("Test Plugin"),
            description: json!("Test plugin"),
            version: "0.0.0".to_string(),
            base_url: base_url.to_string(),
            size_bytes: 0,
            config: HashMap::new(),
            script_type: "v8".to_string(),
            min_app_version: None,
            labels: vec![],
            min_app_incompatible: false,
            file_path: None,
            doc: None,
            icon_png_base64: None,
            description_template: None,
            recommended_configs: Vec::new(),
            var_defs: Vec::new(),
            script: PluginScript::default(),
            doc_resources: None,
            providers: Vec::new(),
            metadata_migration: None,
            version_packed: 0,
        }
    }

    #[tokio::test]
    async fn run_crawl_uses_prelude_common_custom_and_timer() {
        let entry = r#"
            export async function crawl(common, custom) {
                if (common.base_url !== "https://example.test") {
                    throw new Error("bad common base_url: " + common.base_url);
                }
                if (custom.page !== 2 || custom.keep !== null) {
                    throw new Error("bad custom config");
                }
                Kabegame.setHeader("x-test", "ok");
                Kabegame.delHeader("x-missing");
                const progress = Kabegame.addProgress(0.5);
                if (progress !== 0.5) {
                    throw new Error("bad progress: " + progress);
                }
                Kabegame.warn("hello");
                console.log({ a: 1 }, undefined);
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        "#
        .to_string();

        let run = test_run("v8-sync-ops", "https://example.test");
        let mut rt =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        rt.run_crawl(
            "plugin.test",
            entry,
            json!({ "base_url": "https://example.test" }),
            json!({ "page": 2, "keep": null }),
        )
        .await
        .expect("crawl should resolve");
    }

    #[tokio::test]
    async fn run_crawl_errors_when_export_missing() {
        let entry = "export const notCrawl = 1;".to_string();
        let run = test_run("v8-missing-export", "");
        let mut rt =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("missing crawl export must error");

        assert!(err.to_string().contains("crawl"));
    }

    #[tokio::test]
    async fn run_crawl_rejects_runtime_imports() {
        let entry = r#"
            import value from "not-bundled";
            export async function crawl() {
                return value;
            }
        "#
        .to_string();
        let run = test_run("v8-import-rejected", "");
        let mut rt =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("imports must be rejected");

        let msg = err.to_string();
        assert!(msg.contains("module") || msg.contains("import") || msg.contains("loader"));
    }

    #[tokio::test]
    async fn web_globals_and_fetch_work_without_updating_stack() {
        init_scheduler();
        let task_id = "v8-web-fetch";
        let run = test_run(task_id, "");
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 7\r\n\r\n[1,2,3]",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const resolved = new URL("/data", "{server}/base").toString();
                if (resolved !== "{server}/data") {{
                    throw new Error("bad URL: " + resolved);
                }}
                if (new TextEncoder().encode("ok").length !== 2) {{
                    throw new Error("TextEncoder unavailable");
                }}
                const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ok"));
                if (digest.byteLength !== 32) {{
                    throw new Error("bad digest length: " + digest.byteLength);
                }}
                const value = await (await fetch("{server}/data")).json();
                if (JSON.stringify(value) !== '[1,2,3]') {{
                    throw new Error("bad fetched json: " + JSON.stringify(value));
                }}
                const document = new DOMParser().parseFromString('<main><a href="/x">hi</a></main>', 'text/html');
                const anchor = document.querySelector('a');
                if (!anchor || anchor.textContent !== 'hi') {{
                    throw new Error("bad DOMParser result");
                }}
            }}
            "#
        );

        let mut rt =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        rt.run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("fetch should resolve");

        let stack = Arc::clone(&run.page_stack);
        assert!(stack.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn kabegame_fs_uses_task_vfs_without_extending_deno_namespace() {
        let run = test_run("v8-fs", "");
        let entry = r#"
            export async function crawl(common) {
                const fs = Kabegame.fs;
                if (!Object.isFrozen(fs)) throw new Error("Kabegame.fs is not frozen");
                if (fs.getRoot() !== common.root) {
                    throw new Error("bad fs root: " + fs.getRoot());
                }
                if ("readTextFile" in Deno || "writeTextFile" in Deno) {
                    throw new Error("fs leaked onto Deno namespace");
                }
                const path = fs.getRoot() + "/data/runtime.txt";
                await fs.writeTextFile(path, "kabegame-fs");
                if (await fs.readTextFile(path) !== "kabegame-fs") {
                    throw new Error("bad fs round trip");
                }
                const stat = fs.statSync(path);
                if (!stat.isFile || stat.size !== 11) throw new Error("bad statSync result");
            }
        "#
        .to_string();

        let mut runtime =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        runtime
            .run_crawl(
                "plugin.test",
                entry,
                json!({ "root": format!("/{}", run.fs_handle) }),
                json!({}),
            )
            .await
            .expect("Kabegame.fs should use the task VFS");
    }

    #[tokio::test]
    async fn download_image_wraps_and_reads_its_task_vfs_file() {
        let run = test_run("v8-task-vfs-download", "");
        let entry = r#"
            export async function crawl() {
                const path = Kabegame.fs.getRoot() + "/data/x.jpg";
                await Kabegame.fs.writeTextFile(path, "task-vfs-image");
                await Kabegame.downloadImage(path);
            }
        "#
        .to_string();

        let mut runtime =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        runtime
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("downloadImage should accept its task VFS path");

        let download_queue = TaskScheduler::global().download_queue();
        let request = {
            let mut pending = download_queue.pending_queue.lock().await;
            let index = pending
                .iter()
                .position(|request| request.task_id == run.task_id)
                .expect("task VFS download should be queued");
            pending.remove(index).unwrap()
        };
        assert_eq!(request.url.scheme(), "task-vfs");
        let expected_handle = run.fs_handle.to_string();
        assert_eq!(request.url.host_str(), Some(expected_handle.as_str()));
        assert_eq!(request.url.path(), "/data/x.jpg");

        let outcome = crate::crawler::downloader::download_with_retry(
            &download_queue,
            &run.task_id,
            request.url.as_str(),
            &request.http_headers,
            request.id,
            None,
        )
        .await
        .expect("registry downloader should read task VFS bytes");
        match outcome {
            crate::crawler::downloader::DownloadOutcome::Bytes(bytes) => {
                assert_eq!(bytes, b"task-vfs-image")
            }
            crate::crawler::downloader::DownloadOutcome::Path(_) => {
                panic!("small task VFS file should stay in memory")
            }
        }
    }

    #[tokio::test]
    async fn snapshot_round_trip_restores_task_fs() {
        let run = test_run("v8-snapshot-fs", "");
        let blob: &'static [u8] =
            Box::leak(snapshot::generate_snapshot_bytes().expect("generate baseline snapshot"));
        let mut runtime =
            JsPluginRuntime::with_snapshot(test_state(&run), run.vfs.clone(), blob)
                .expect("restore snapshot runtime");
        let entry = r#"
            export async function crawl(common) {
                if (Kabegame.fs.getRoot() !== common.root) {
                    throw new Error("bad restored fs root: " + Kabegame.fs.getRoot());
                }
                const path = Kabegame.fs.getRoot() + "/cache/snapshot-fs.txt";
                await Kabegame.fs.writeTextFile(path, "snapshot-fs");
                if (await Kabegame.fs.readTextFile(path) !== "snapshot-fs") {
                    throw new Error("bad restored fs round trip");
                }
            }
        "#
        .to_string();

        runtime
            .run_crawl(
                "plugin.test",
                entry,
                json!({ "root": format!("/{}", run.fs_handle) }),
                json!({}),
            )
            .await
            .expect("restored runtime should use the task VFS");
    }

    #[tokio::test]
    async fn snapshot_round_trip_restores_crypto_web_dom_timer_fetch_and_fs() {
        init_scheduler();
        let task_id = "v8-snapshot-round-trip";
        let run = test_run(task_id, "");
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}",
        );

        let blob: &'static [u8] =
            Box::leak(snapshot::generate_snapshot_bytes().expect("generate baseline snapshot"));
        let mut runtime =
            JsPluginRuntime::with_snapshot(test_state(&run), run.vfs.clone(), blob)
                .expect("restore snapshot runtime");
        let expected_root = format!("/{}", run.fs_handle);
        let entry = format!(
            r#"
            export async function crawl() {{
                if (typeof Crypto !== "function" || typeof CryptoKey !== "function" ||
                    typeof SubtleCrypto !== "function" || !(crypto instanceof Crypto)) {{
                    throw new Error("crypto globals unavailable after restore");
                }}
                const first = crypto.getRandomValues(new Uint8Array(16));
                const second = crypto.getRandomValues(new Uint8Array(16));
                if (first.every((value, index) => value === second[index])) {{
                    throw new Error("getRandomValues repeated output");
                }}
                const digest = new Uint8Array(await crypto.subtle.digest(
                    "SHA-256", new TextEncoder().encode("abc")
                ));
                const hex = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
                if (hex !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {{
                    throw new Error("bad SHA-256: " + hex);
                }}
                if (new URL("/x", "https://example.test/base").href !== "https://example.test/x") {{
                    throw new Error("URL unavailable");
                }}
                const document = new DOMParser().parseFromString("<main>ok</main>", "text/html");
                if (document.querySelector("main")?.textContent !== "ok") {{
                    throw new Error("DOMParser unavailable");
                }}
                await new Promise(resolve => setTimeout(resolve, 1));
                const response = await (await fetch("{server}/snapshot")).json();
                if (!response.ok) throw new Error("fetch unavailable");
                if (Kabegame.fs.getRoot() !== "{expected_root}") {{
                    throw new Error("fs root unavailable after restore");
                }}
                await Kabegame.fs.writeTextFile("{expected_root}/cache/snapshot.txt", "ok");
                if (await Kabegame.fs.readTextFile("{expected_root}/cache/snapshot.txt") !== "ok") {{
                    throw new Error("fs unavailable after restore");
                }}
            }}
            "#
        );

        runtime
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("restored runtime should execute crawler");
    }

    #[tokio::test]
    async fn to_updates_page_stack_and_current_page_ops_read_it() {
        init_scheduler();
        let task_id = "v8-to-stack";
        let run = test_run(task_id, "");
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-seen: yes\r\ncontent-length: 15\r\n\r\n<html>ok</html>",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const finalUrl = await Kabegame.to("{server}/page");
                const currentUrl = await Kabegame.currentUrl();
                const html = await Kabegame.currentHtml();
                const document = await Kabegame.currentDocument();
                const headers = await Kabegame.currentHeaders();
                if (finalUrl !== "{server}/page") throw new Error("bad finalUrl: " + finalUrl);
                if (currentUrl !== "{server}/page") throw new Error("bad currentUrl: " + currentUrl);
                if (html !== "<html>ok</html>") throw new Error("bad html: " + html);
                if (!document || document.documentElement.tagName !== "HTML") throw new Error("bad document");
                if (headers["x-seen"] !== "yes") throw new Error("bad header");
            }}
            "#
        );

        let mut rt =
            JsPluginRuntime::new(test_state(&run), run.vfs.clone()).expect("runtime init");
        rt.run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("to should resolve");
    }

    #[tokio::test]
    async fn cancellation_interrupts_async_ops() {
        init_scheduler();
        let task_id = "v8-cancel-to";
        let run = test_run(task_id, "");
        let server = spawn_hanging_http_server();
        let state = test_state(&run);
        let cancel = state.cancel.clone();
        let entry = format!(
            r#"
            export async function crawl() {{
                await Kabegame.to("{server}/slow");
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(state, run.vfs.clone()).expect("runtime init");
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("cancelled op should reject");
        cancel_task.await.expect("cancel task");

        assert!(err.to_string().contains("Task canceled"));
    }

    #[tokio::test]
    async fn download_image_checks_cancel_before_queueing() {
        let run = test_run("v8-cancel-download", "");
        let state = test_state(&run);
        state.cancel.cancel();
        let entry = r#"
            export async function crawl() {
                while (true) {
                    await Kabegame.downloadImage("https://example.com/a.png", null);
                }
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new(state, run.vfs.clone()).expect("runtime init");
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("cancelled download should reject");

        assert!(err.to_string().contains("Task canceled"));
    }

    #[tokio::test]
    async fn execute_entry_normalizes_hard_interrupt_to_task_canceled() {
        let run = test_run_with_script(
            "v8-hard-cancel",
            "",
            PluginScript::new(
                PluginBackend::V8,
                "export async function crawl() { for (;;) {} }".to_string(),
            ),
            HashMap::new(),
        );
        let cancel = run.cancel.clone();
        let join = tokio::task::spawn_blocking(move || execute_crawler_script_v8(run));

        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let err = join
            .await
            .expect("blocking worker should not panic")
            .expect_err("hard interrupt should fail as canceled");

        assert_eq!(err, TaskError::Canceled);
    }

    #[tokio::test]
    async fn execute_entry_builds_common_and_custom_configs() {
        let mut config = HashMap::new();
        config.insert("page".to_string(), json!(3));
        config.insert("keep".to_string(), JsonValue::Null);
        let run = test_run_with_script(
            "v8-execute-config",
            "https://example.test",
            PluginScript::new(
                PluginBackend::V8,
                r#"
                    export async function crawl(common, custom) {
                        if (common.base_url !== "https://example.test") throw new Error("bad base");
                        if (custom.page !== 3 || custom.keep !== null) throw new Error("bad custom");
                        await new Promise((resolve) => setTimeout(resolve, 1));
                    }
                "#
                .to_string(),
            ),
            config,
        );
        let join = tokio::task::spawn_blocking(move || execute_crawler_script_v8(run));

        join.await
            .expect("blocking worker should not panic")
            .expect("execute should resolve");
    }

    fn spawn_http_server(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        format!("http://{addr}")
    }

    fn spawn_hanging_http_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            thread::sleep(Duration::from_secs(5));
        });
        format!("http://{addr}")
    }
}
