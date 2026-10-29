//! 开发期 debug ingest：把 debug 事件转发到 Vite dev server 的 `/__kabegame_debug/ingest`。
//!
//! 插桩本身只是 tracing 日志：Rust 用 `kabegame_core::kb_debug!`（`kabegame::debug` 的 TRACE 事件），
//! 前端经 tauri-plugin-tracing 打 `kb-debug {json}` 的 trace 日志。这里的 [`layer`] 是订阅它们的
//! tracing 层，攒批后用 NDJSON POST 出去。只在 debug 构建存在。见 `cocs/debug/DEBUG_INGEST.md`。
//!
//! CDP 端口寄存同样只在 dev 生效，也放在这里。

#[cfg(debug_assertions)]
use serde_json::Value;

#[cfg(debug_assertions)]
const DEBUG_INGEST_PATH: &str = "/__kabegame_debug/ingest";

/// `kb_debug!` 使用的 target。
#[cfg(debug_assertions)]
const RUST_TARGET: &str = "kabegame::debug";

/// 前端 debug 日志的消息前缀（`apps/kabegame/src/debugIngest.ts`）。
#[cfg(debug_assertions)]
const FRONTEND_PREFIX: &str = "kb-debug ";

/// 交给 `kabegame_core::logging::init` 的额外层；`KABEGAME_DEBUG_INGEST=false` 或发布版为 None。
#[cfg(debug_assertions)]
pub fn layer() -> Option<kabegame_core::logging::BoxedLayer> {
    use tracing_subscriber::filter::filter_fn;
    use tracing_subscriber::Layer;

    if !debug_ingest_enabled() {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::Builder::new()
        .name("kabegame-debug-ingest".to_string())
        .spawn(move || run_sender(rx))
        .ok()?;
    let filter = filter_fn(|meta| {
        meta.target() == RUST_TARGET
            || (meta.target().is_empty() && *meta.level() == tracing::Level::TRACE)
    });
    Some(Box::new(DebugIngestLayer { tx }.with_filter(filter)))
}

#[cfg(not(debug_assertions))]
pub fn layer() -> Option<kabegame_core::logging::BoxedLayer> {
    None
}

#[cfg(debug_assertions)]
struct DebugIngestLayer {
    tx: std::sync::mpsc::Sender<Value>,
}

#[cfg(debug_assertions)]
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for DebugIngestLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut fields = FieldVisitor::default();
        event.record(&mut fields);
        let ingest = if event.metadata().target() == RUST_TARGET {
            let payload = fields.take("payload");
            serde_json::json!({
                "session_id": fields.take("session_id"),
                "source": "rust",
                "level": "debug",
                "name": fields.take("name"),
                "ts": now_millis(),
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)),
            })
        } else {
            // 前端事件自带 session_id / source / level / name / ts / payload，原样转发
            let message = fields.take("message");
            let Some(json) = message.strip_prefix(FRONTEND_PREFIX) else {
                return;
            };
            match serde_json::from_str::<Value>(json) {
                Ok(value @ Value::Object(_)) => value,
                _ => return,
            }
        };
        let _ = self.tx.send(ingest);
    }
}

#[cfg(debug_assertions)]
#[derive(Default)]
struct FieldVisitor(std::collections::HashMap<&'static str, String>);

#[cfg(debug_assertions)]
impl FieldVisitor {
    fn take(&mut self, name: &str) -> String {
        self.0.remove(name).unwrap_or_default()
    }
}

#[cfg(debug_assertions)]
impl tracing::field::Visit for FieldVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(field.name(), value.to_string());
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name(), format!("{value:?}"));
    }
}

/// 专用线程：取走已到达的事件攒成一批，用 NDJSON 发出。失败只往 stderr 报一次——
/// 这里是日志管线自身，不能再经 tracing 打日志。
#[cfg(debug_assertions)]
fn run_sender(rx: std::sync::mpsc::Receiver<Value>) {
    const MAX_BATCH: usize = 200;

    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    // reqwest 0.11 构造 Client 时需要处在 Tokio runtime 上下文里。
    let _runtime_guard = runtime.enter();
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
    else {
        return;
    };
    let url = debug_ingest_url();
    let mut reported = false;
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(event) => batch.push(event),
                Err(_) => break,
            }
        }
        let body = batch
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let result = runtime.block_on(
            client
                .post(&url)
                .header("Content-Type", "application/x-ndjson")
                .body(body)
                .send(),
        );
        let error = match result {
            Ok(response) if response.status().is_success() => None,
            Ok(response) => Some(format!("debug ingest returned {}", response.status())),
            Err(error) => Some(error.to_string()),
        };
        if let Some(error) = error {
            if !reported {
                reported = true;
                eprintln!("[kabegame-debug] failed to send debug events to {url}: {error}");
            }
        }
    }
}

/// vite dev server 上的 CDP 端口登记入口(见 `scripts/vite-debug-server.ts`)。
#[cfg(all(
    debug_assertions,
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
const CDP_REGISTER_PATH: &str = "/__kabegame_cdp/register";

/// 把本进程 CEF 的 CDP 端口上报给 vite dev server。
///
/// 为什么要这一步：dev 下 CDP 端口是**随机**的(`KABEGAME_CEF_DEBUG_PORT=random`,
/// 由 ComponentPlugin 注入),`.claude/skills/kabegame-chromium/` 不可能猜到号；而
/// vite 的 1420 是死端口。于是让 app 主动把号"寄存"到 vite,skill 只探 1420 即可。
///
/// 等 `/json/version` 真的应答之后才上报,所以"vite 上有端口"等价于"CDP 已就绪",
/// skill 不必自己轮询 app 启动进度。
#[cfg(all(
    debug_assertions,
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
pub fn spawn_cdp_register() {
    let Some(port) = tauri_runtime_cef::remote_debugging_port() else {
        return;
    };
    spawn_task(async move {
        if let Err(error) = register_cdp_port(port).await {
            tracing::warn!("failed to publish CDP port {port} to dev server: {error}");
        }
    });
}

#[cfg(not(all(
    debug_assertions,
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
)))]
pub fn spawn_cdp_register() {}

#[cfg(all(
    debug_assertions,
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
async fn register_cdp_port(port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .map_err(|error| error.to_string())?;

    // CDP 的 listener 由 cef_initialize 内部起,setup() 跑到时可能还没 bind 上。
    let probe = format!("http://127.0.0.1:{port}/json/version");
    let mut ready = false;
    for _ in 0..60 {
        if let Ok(response) = client.get(&probe).send().await {
            if response.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if !ready {
        return Err(format!("CDP on 127.0.0.1:{port} never became ready"));
    }

    let url = format!(
        "http://{}:{}{}",
        dev_server_host(),
        dev_server_port(),
        CDP_REGISTER_PATH
    );
    let response = client
        .post(url)
        .json(&serde_json::json!({
            "port": port,
            "pid": std::process::id(),
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("dev server returned {}", response.status()));
    }
    tracing::info!("CDP ready on 127.0.0.1:{port}, published to dev server");
    Ok(())
}

#[cfg(debug_assertions)]
fn debug_ingest_enabled() -> bool {
    std::env::var("KABEGAME_DEBUG_INGEST")
        .map(|value| value != "false" && value != "0")
        .unwrap_or(true)
}

#[cfg(debug_assertions)]
fn debug_ingest_url() -> String {
    configured_value(
        "KABEGAME_DEBUG_INGEST_URL",
        option_env!("KABEGAME_DEBUG_INGEST_URL"),
    )
    .unwrap_or_else(|| {
        format!(
            "http://{}:{}{}",
            dev_server_host(),
            dev_server_port(),
            DEBUG_INGEST_PATH
        )
    })
}

#[cfg(debug_assertions)]
fn dev_server_host() -> String {
    configured_value(
        "KABEGAME_DEV_SERVER_HOST",
        option_env!("KABEGAME_DEV_SERVER_HOST"),
    )
    .or_else(|| configured_value("TAURI_DEV_HOST", option_env!("TAURI_DEV_HOST")))
    .or_else(|| configured_value("VITE_DEV_SERVER_HOST", option_env!("VITE_DEV_SERVER_HOST")))
    .unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            "10.0.2.2".to_string()
        } else {
            "127.0.0.1".to_string()
        }
    })
}

#[cfg(debug_assertions)]
fn dev_server_port() -> String {
    configured_value(
        "KABEGAME_DEV_SERVER_PORT",
        option_env!("KABEGAME_DEV_SERVER_PORT"),
    )
    .or_else(|| configured_value("VITE_DEV_SERVER_PORT", option_env!("VITE_DEV_SERVER_PORT")))
    .unwrap_or_else(|| "1420".to_string())
}

#[cfg(debug_assertions)]
fn configured_value(name: &str, compile_time: Option<&'static str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| compile_time.map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(debug_assertions)]
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(all(
    debug_assertions,
    not(feature = "web"),
    any(target_os = "linux", target_os = "windows", target_os = "macos"),
    feature = "standard"
))]
fn spawn_task<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(future);
}
