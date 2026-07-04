//! Embedded V8 (deno_core) plugin runtime.
//!
//! Platform gate: desktop only. Android keeps the Rhai backend.

use deno_core::{
    anyhow::{anyhow, Result as AnyhowResult},
    extension, resolve_url, serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions,
};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::plugin::Plugin;
use super::PluginScript;

mod ops;
pub use ops::KabegameOpState;

extension!(
    kabegame_v8,
    ops = [
        ops::op_kabegame_to,
        ops::op_kabegame_back,
        ops::op_kabegame_fetch_json,
        ops::op_kabegame_current_url,
        ops::op_kabegame_current_html,
        ops::op_kabegame_current_headers,
        ops::op_kabegame_plugin_data,
        ops::op_kabegame_set_plugin_data,
        ops::op_kabegame_set_header,
        ops::op_kabegame_del_header,
        ops::op_kabegame_warn,
        ops::op_kabegame_log,
        ops::op_kabegame_add_progress,
        ops::op_kabegame_download_image,
        ops::op_kabegame_create_image_metadata,
    ],
    esm_entry_point = "ext:kabegame_v8/prelude.js",
    esm = [ dir "src/plugin/v8", "prelude.js" ],
    options = {
        ctx: KabegameOpState,
    },
    state = |state, options| {
        state.put(options.ctx);
    },
    docs = "Kabegame V8 crawler host ops.",
);

/// Entry module file name for in-memory, self-contained V8 crawler code.
const ENTRY_FILE_NAME: &str = "crawl.v8.js";

/// Embedded V8 plugin runtime.
pub struct JsPluginRuntime {
    runtime: JsRuntime,
}

impl JsPluginRuntime {
    /// Assemble a runtime with Kabegame host ops wired into OpState.
    pub fn new(ctx: KabegameOpState) -> AnyhowResult<Self> {
        let runtime = JsRuntime::new(RuntimeOptions {
            module_loader: None,
            extensions: vec![kabegame_v8::init(ctx)],
            ..Default::default()
        });
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
}

/// V8 backend scheduling entry. Its shape mirrors
/// `rhai::execute_crawler_script_with_runtime` so Phase 4 can wire it into the
/// existing task worker with minimal dispatch changes.
pub fn execute_crawler_script_v8(
    download_queue: Arc<crate::crawler::DownloadQueue>,
    plugin: &Plugin,
    images_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    script_content: &str,
    merged_config: HashMap<String, serde_json::Value>,
    output_album_id: Option<String>,
    http_headers: Option<HashMap<String, String>>,
    cancel: CancellationToken,
) -> std::result::Result<(), String> {
    let (common, custom) = build_crawl_configs(plugin, merged_config);
    let images_dir = images_dir.to_path_buf();
    let plugin_id = plugin_id.to_string();
    let task_id = task_id.to_string();
    let script_content = script_content.to_string();
    let cancel_for_ctx = cancel.clone();
    let cancel_for_watcher = cancel.clone();

    tokio::runtime::Handle::current().block_on(async move {
        let ctx = KabegameOpState {
            download_queue,
            images_dir,
            plugin_id: plugin_id.clone(),
            task_id,
            output_album_id,
            headers: http_headers.unwrap_or_default(),
            progress: 0.0,
            cancel: cancel_for_ctx,
        };
        let mut rt = JsPluginRuntime::new(ctx).map_err(|e| e.to_string())?;
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

fn normalize_cancel_error(
    result: AnyhowResult<()>,
    cancel: &CancellationToken,
) -> std::result::Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if cancel.is_cancelled()
                || msg.contains("execution terminated")
                || msg.contains("Task canceled")
            {
                Err("Task canceled".to_string())
            } else {
                Err(msg)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::crawler::{DownloadQueue, TaskScheduler};
    use crate::settings::Settings;
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
    use tokio_util::sync::CancellationToken;

    static INIT_SCHEDULER: Once = Once::new();

    fn init_scheduler() {
        INIT_SCHEDULER.call_once(|| {
            std::env::remove_var("HTTP_PROXY");
            std::env::remove_var("http_proxy");
            std::env::remove_var("HTTPS_PROXY");
            std::env::remove_var("https_proxy");
            std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
            std::env::set_var("no_proxy", "127.0.0.1,localhost");
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
            });
            let _ = Settings::init_global();
            let _ = TaskScheduler::init_global(Arc::new(DownloadQueue::new()));
        });
    }

    fn test_state(task_id: &str) -> KabegameOpState {
        KabegameOpState {
            download_queue: Arc::new(DownloadQueue::new()),
            images_dir: PathBuf::new(),
            plugin_id: "plugin.test".to_string(),
            task_id: task_id.to_string(),
            output_album_id: None,
            headers: HashMap::new(),
            progress: 0.0,
            cancel: CancellationToken::new(),
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
            file_path: None,
            doc: None,
            icon_png_base64: None,
            description_template: None,
            recommended_configs: Vec::new(),
            var_defs: Vec::new(),
            script: PluginScript::V2 {
                rhai: None,
                js: None,
            },
            doc_resources: None,
            providers: Vec::new(),
            metadata_migrations: Vec::new(),
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
                __kabegame_set_header("x-test", "ok");
                __kabegame_del_header("x-missing");
                const progress = __kabegame_add_progress(0.5);
                if (progress !== 0.5) {
                    throw new Error("bad progress: " + progress);
                }
                __kabegame_warn("hello");
                console.log({ a: 1 }, undefined);
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new(test_state("v8-sync-ops")).expect("runtime init");
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
        let mut rt = JsPluginRuntime::new(test_state("v8-missing-export")).expect("runtime init");
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
        let mut rt = JsPluginRuntime::new(test_state("v8-import-rejected")).expect("runtime init");
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("imports must be rejected");

        let msg = err.to_string();
        assert!(msg.contains("module") || msg.contains("import") || msg.contains("loader"));
    }

    #[tokio::test]
    async fn fetch_json_wraps_non_object_without_updating_stack() {
        init_scheduler();
        let task_id = "v8-fetch-json";
        TaskScheduler::global()
            .page_stacks()
            .create_stack(task_id)
            .await;
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 7\r\n\r\n[1,2,3]",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const value = await __kabegame_fetch_json("{server}/data");
                if (JSON.stringify(value) !== '{{"data":[1,2,3]}}') {{
                    throw new Error("bad wrapped json: " + JSON.stringify(value));
                }}
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(test_state(task_id)).expect("runtime init");
        rt.run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("fetch_json should resolve");

        let stack = TaskScheduler::global()
            .page_stacks()
            .get_stack(task_id)
            .await
            .expect("stack");
        assert!(stack.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn to_updates_page_stack_and_current_page_ops_read_it() {
        init_scheduler();
        let task_id = "v8-to-stack";
        TaskScheduler::global()
            .page_stacks()
            .create_stack(task_id)
            .await;
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-seen: yes\r\ncontent-length: 15\r\n\r\n<html>ok</html>",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const finalUrl = await __kabegame_to("{server}/page");
                const currentUrl = await __kabegame_current_url();
                const html = await __kabegame_current_html();
                const headers = await __kabegame_current_headers();
                if (finalUrl !== "{server}/page") throw new Error("bad finalUrl: " + finalUrl);
                if (currentUrl !== "{server}/page") throw new Error("bad currentUrl: " + currentUrl);
                if (html !== "<html>ok</html>") throw new Error("bad html: " + html);
                if (headers["x-seen"] !== "yes") throw new Error("bad header");
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(test_state(task_id)).expect("runtime init");
        rt.run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect("to should resolve");
    }

    #[tokio::test]
    async fn cancellation_interrupts_async_ops() {
        init_scheduler();
        let task_id = "v8-cancel-to";
        TaskScheduler::global()
            .page_stacks()
            .create_stack(task_id)
            .await;
        let server = spawn_hanging_http_server();
        let state = test_state(task_id);
        let cancel = state.cancel.clone();
        let entry = format!(
            r#"
            export async function crawl() {{
                await __kabegame_to("{server}/slow");
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(state).expect("runtime init");
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
        let state = test_state("v8-cancel-download");
        state.cancel.cancel();
        let entry = r#"
            export async function crawl() {
                while (true) {
                    await __kabegame_download_image("https://example.com/a.png", null);
                }
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new(state).expect("runtime init");
        let err = rt
            .run_crawl("plugin.test", entry, json!({}), json!({}))
            .await
            .expect_err("cancelled download should reject");

        assert!(err.to_string().contains("Task canceled"));
    }

    #[tokio::test]
    async fn execute_entry_normalizes_hard_interrupt_to_task_canceled() {
        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        let join = tokio::task::spawn_blocking(move || {
            execute_crawler_script_v8(
                Arc::new(DownloadQueue::new()),
                &test_plugin(""),
                &PathBuf::new(),
                "plugin.test",
                "v8-hard-cancel",
                "export async function crawl() { for (;;) {} }",
                HashMap::new(),
                None,
                None,
                cancel_for_task,
            )
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let err = join
            .await
            .expect("blocking worker should not panic")
            .expect_err("hard interrupt should fail as canceled");

        assert_eq!(err, "Task canceled");
    }

    #[tokio::test]
    async fn execute_entry_builds_common_and_custom_configs() {
        let mut config = HashMap::new();
        config.insert("page".to_string(), json!(3));
        config.insert("keep".to_string(), JsonValue::Null);
        let join = tokio::task::spawn_blocking(move || {
            execute_crawler_script_v8(
                Arc::new(DownloadQueue::new()),
                &test_plugin("https://example.test"),
                &PathBuf::new(),
                "plugin.test",
                "v8-execute-config",
                r#"
                    export async function crawl(common, custom) {
                        if (common.base_url !== "https://example.test") throw new Error("bad base");
                        if (custom.page !== 3 || custom.keep !== null) throw new Error("bad custom");
                        await new Promise((resolve) => setTimeout(resolve, 1));
                    }
                "#,
                config,
                None,
                None,
                CancellationToken::new(),
            )
        });

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
