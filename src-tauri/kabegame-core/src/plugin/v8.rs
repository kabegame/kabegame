//! Embedded V8 (deno_core) plugin runtime.
//!
//! Platform gate: desktop only. Android keeps the Rhai backend.

use deno_core::{
    anyhow::{anyhow, Result},
    extension, resolve_url, serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions,
};
use serde_json::Value as JsonValue;

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
        ops::op_kabegame_add_progress,
        ops::op_kabegame_download_image,
        ops::op_kabegame_create_image_metadata,
    ],
    options = {
        ctx: KabegameOpState,
    },
    state = |state, options| {
        state.put(options.ctx);
    },
    docs = "Kabegame V8 crawler host ops.",
);

/// Entry module specifier for in-memory, self-contained V8 crawler code.
const ENTRY_SPECIFIER: &str = "file:///crawl.v8.js";

/// Embedded V8 plugin runtime skeleton. The formal SDK/runtime prelude lands in Phase 2.
pub struct JsPluginRuntime {
    runtime: JsRuntime,
}

impl JsPluginRuntime {
    /// Assemble a runtime with Kabegame host ops wired into OpState.
    pub fn new(ctx: KabegameOpState) -> Result<Self> {
        let runtime = JsRuntime::new(RuntimeOptions {
            module_loader: None,
            extensions: vec![kabegame_v8::init(ctx)],
            ..Default::default()
        });
        Ok(Self { runtime })
    }

    /// Load a self-contained entry module, call exported `crawl(args)`, drive
    /// the event loop until its Promise settles, then deserialize the result.
    pub async fn run_crawl(&mut self, entry_code: String, args: JsonValue) -> Result<JsonValue> {
        let specifier = resolve_url(ENTRY_SPECIFIER)?;
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

        let arg: v8::Global<v8::Value> = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = serde_v8::to_v8(scope, args)?;
            v8::Global::new(scope, local)
        };

        let call = self.runtime.call_with_args(&crawl_fn, &[arg]);
        let result = self
            .runtime
            .with_event_loop_promise(call, PollEventLoopOptions::default())
            .await?;

        let value = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = v8::Local::new(scope, result);
            serde_v8::from_v8(scope, local)?
        };

        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::crawler::{DownloadQueue, TaskScheduler};
    use crate::settings::Settings;
    use serde_json::json;
    use std::fs;
    use std::collections::HashMap;
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
            let root = std::env::temp_dir().join(format!(
                "kabegame-core-v8-tests-{}",
                std::process::id()
            ));
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

    #[tokio::test]
    async fn run_crawl_can_call_sync_host_ops() {
        let entry = r#"
            export async function crawl(input) {
                Deno.core.ops.op_kabegame_set_header("x-test", "ok");
                Deno.core.ops.op_kabegame_del_header("x-missing");
                const progress = Deno.core.ops.op_kabegame_add_progress(input.n);
                Deno.core.ops.op_kabegame_warn("hello");
                return { progress };
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new(test_state("v8-sync-ops")).expect("runtime init");
        let out = rt
            .run_crawl(entry, json!({ "n": 21.5 }))
            .await
            .expect("crawl should resolve");

        assert_eq!(out["progress"], 21.5);
    }

    #[tokio::test]
    async fn run_crawl_errors_when_export_missing() {
        let entry = "export const notCrawl = 1;".to_string();
        let mut rt = JsPluginRuntime::new(test_state("v8-missing-export")).expect("runtime init");
        let err = rt
            .run_crawl(entry, json!({}))
            .await
            .expect_err("missing crawl export must error");

        assert!(err.to_string().contains("crawl"));
    }

    #[tokio::test]
    async fn fetch_json_wraps_non_object_without_updating_stack() {
        init_scheduler();
        let task_id = "v8-fetch-json";
        TaskScheduler::global().page_stacks().create_stack(task_id).await;
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 7\r\n\r\n[1,2,3]",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const value = await Deno.core.ops.op_kabegame_fetch_json("{server}/data");
                return value;
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(test_state(task_id)).expect("runtime init");
        let out = rt
            .run_crawl(entry, json!({}))
            .await
            .expect("fetch_json should resolve");

        assert_eq!(out, json!({ "data": [1, 2, 3] }));
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
        TaskScheduler::global().page_stacks().create_stack(task_id).await;
        let server = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-seen: yes\r\ncontent-length: 15\r\n\r\n<html>ok</html>",
        );
        let entry = format!(
            r#"
            export async function crawl() {{
                const finalUrl = await Deno.core.ops.op_kabegame_to("{server}/page");
                const currentUrl = await Deno.core.ops.op_kabegame_current_url();
                const html = await Deno.core.ops.op_kabegame_current_html();
                const headers = await Deno.core.ops.op_kabegame_current_headers();
                return {{ finalUrl, currentUrl, html, header: headers["x-seen"] }};
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(test_state(task_id)).expect("runtime init");
        let out = rt
            .run_crawl(entry, json!({}))
            .await
            .expect("to should resolve");

        assert_eq!(out["finalUrl"], format!("{server}/page"));
        assert_eq!(out["currentUrl"], format!("{server}/page"));
        assert_eq!(out["html"], "<html>ok</html>");
        assert_eq!(out["header"], "yes");
    }

    #[tokio::test]
    async fn cancellation_interrupts_async_ops() {
        init_scheduler();
        let task_id = "v8-cancel-to";
        TaskScheduler::global().page_stacks().create_stack(task_id).await;
        let server = spawn_hanging_http_server();
        let state = test_state(task_id);
        let cancel = state.cancel.clone();
        let entry = format!(
            r#"
            export async function crawl() {{
                await Deno.core.ops.op_kabegame_to("{server}/slow");
            }}
            "#
        );

        let mut rt = JsPluginRuntime::new(state).expect("runtime init");
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let err = rt
            .run_crawl(entry, json!({}))
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
                await Deno.core.ops.op_kabegame_download_image("https://example.com/a.png", null);
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new(state).expect("runtime init");
        let err = rt
            .run_crawl(entry, json!({}))
            .await
            .expect_err("cancelled download should reject");

        assert!(err.to_string().contains("Task canceled"));
    }

    fn spawn_http_server(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            stream.write_all(response.as_bytes()).expect("write response");
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
