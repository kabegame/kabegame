#[cfg(debug_assertions)]
use serde_json::Value;

#[cfg(debug_assertions)]
const DEBUG_INGEST_PATH: &str = "/__kabegame_debug/ingest";

#[cfg(debug_assertions)]
#[derive(serde::Serialize)]
struct DebugIngestEvent {
    session_id: String,
    source: &'static str,
    level: String,
    name: String,
    ts: u128,
    payload: Value,
}

#[cfg(debug_assertions)]
pub fn spawn_debug_event(session_id: impl Into<String>, name: impl Into<String>, payload: Value) {
    spawn_debug_event_with_level(session_id, "debug", name, payload);
}

#[cfg(not(debug_assertions))]
pub fn spawn_debug_event(
    _session_id: impl Into<String>,
    _name: impl Into<String>,
    _payload: serde_json::Value,
) {
}

#[cfg(debug_assertions)]
pub fn spawn_debug_event_with_level(
    session_id: impl Into<String>,
    level: impl Into<String>,
    name: impl Into<String>,
    payload: Value,
) {
    if !debug_ingest_enabled() {
        return;
    }

    let session_id = session_id.into();
    let level = level.into();
    let name = name.into();

    spawn_task(async move {
        if let Err(error) = send_debug_event_with_level(session_id, level, name, payload).await {
            eprintln!("[kabegame-debug] failed to send debug event: {error}");
        }
    });
}

#[cfg(not(debug_assertions))]
pub fn spawn_debug_event_with_level(
    _session_id: impl Into<String>,
    _level: impl Into<String>,
    _name: impl Into<String>,
    _payload: serde_json::Value,
) {
}

#[cfg(debug_assertions)]
#[allow(dead_code)]
pub async fn send_debug_event(
    session_id: impl Into<String>,
    name: impl Into<String>,
    payload: Value,
) -> Result<(), String> {
    send_debug_event_with_level(session_id, "debug", name, payload).await
}

#[cfg(not(debug_assertions))]
pub async fn send_debug_event(
    _session_id: impl Into<String>,
    _name: impl Into<String>,
    _payload: serde_json::Value,
) -> Result<(), String> {
    Ok(())
}

#[cfg(debug_assertions)]
pub async fn send_debug_event_with_level(
    session_id: impl Into<String>,
    level: impl Into<String>,
    name: impl Into<String>,
    payload: Value,
) -> Result<(), String> {
    if !debug_ingest_enabled() {
        return Ok(());
    }

    let event = DebugIngestEvent {
        session_id: session_id.into(),
        source: "rust",
        level: level.into(),
        name: name.into(),
        ts: now_millis(),
        payload,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(debug_ingest_url())
        .json(&event)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("debug ingest returned {}", response.status()))
    }
}

#[cfg(not(debug_assertions))]
pub async fn send_debug_event_with_level(
    _session_id: impl Into<String>,
    _level: impl Into<String>,
    _name: impl Into<String>,
    _payload: serde_json::Value,
) -> Result<(), String> {
    Ok(())
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
            eprintln!("[kabegame-cdp] failed to publish CDP port {port} to dev server: {error}");
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
    eprintln!("[kabegame-cdp] CDP ready on 127.0.0.1:{port}, published to dev server");
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

#[cfg(all(debug_assertions, not(feature = "web")))]
fn spawn_task<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(future);
}

#[cfg(all(debug_assertions, feature = "web"))]
fn spawn_task<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(future);
}
