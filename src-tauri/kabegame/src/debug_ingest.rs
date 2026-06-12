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
