use crate::crawler::task_scheduler::PageStackEntry;
use crate::crawler::TaskScheduler;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Clone)]
pub struct KabegameOpState {
    pub download_queue: Arc<crate::crawler::DownloadQueue>,
    pub images_dir: PathBuf,
    pub plugin_id: String,
    pub task_id: String,
    pub output_album_id: Option<String>,
    pub headers: HashMap<String, String>,
    pub progress: f64,
    pub cancel: CancellationToken,
}

#[op2]
#[string]
pub async fn op_kabegame_to(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
) -> Result<String, JsErrorBox> {
    let (task_id, headers, cancel) = state_snapshot(&state, |s| {
        (s.task_id.clone(), s.headers.clone(), s.cancel.clone())
    });
    check_cancelled(&cancel)?;

    let resolved_url = resolve_url_for_task_async(&task_id, &url).await?;
    emit_http_info(&task_id, format!("[to] 打开页面：{resolved_url}"));
    let (final_url, html, resp_headers) =
        http_get_text_with_retry(&task_id, &resolved_url, "to", &headers, &cancel).await?;

    let stack = get_page_stack_async(&task_id).await?;
    let mut stack_guard = stack
        .lock()
        .map_err(|e| JsErrorBox::generic(format!("Lock error: {e}")))?;
    stack_guard.push(PageStackEntry {
        url: final_url.clone(),
        html,
        headers: resp_headers,
        page_label: String::new(),
        page_state: JsonValue::Null,
    });
    emit_http_info(
        &task_id,
        format!(
            "[to] 页面已入栈：{}（stack_depth={}）",
            final_url,
            stack_guard.len()
        ),
    );
    Ok(final_url)
}

#[op2]
pub async fn op_kabegame_back(state: Rc<RefCell<OpState>>) -> Result<(), JsErrorBox> {
    let task_id = state_snapshot(&state, |s| s.task_id.clone());
    let stack = get_page_stack_async(&task_id).await?;
    let mut stack_guard = stack
        .lock()
        .map_err(|e| JsErrorBox::generic(format!("Lock error: {e}")))?;
    if stack_guard.is_empty() {
        return Err(JsErrorBox::generic("Page stack is empty, cannot go back"));
    }
    stack_guard.pop();
    Ok(())
}

#[op2]
#[serde]
pub async fn op_kabegame_fetch_json(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
) -> Result<JsonValue, JsErrorBox> {
    let (task_id, headers, cancel) = state_snapshot(&state, |s| {
        (s.task_id.clone(), s.headers.clone(), s.cancel.clone())
    });
    check_cancelled(&cancel)?;

    let resolved_url = resolve_url_for_task_async(&task_id, &url).await?;
    emit_http_info(&task_id, format!("[fetch_json] 请求 JSON：{resolved_url}"));
    let (final_url, text, _) =
        http_get_text_with_retry(&task_id, &resolved_url, "fetch_json", &headers, &cancel).await?;
    let json = serde_json::from_str::<JsonValue>(&text).map_err(|e| {
        let msg = format!("[fetch_json] JSON 解析失败：{e}");
        eprintln!("{msg} URL: {final_url}");
        emit_http_error(&task_id, format!("{msg}，URL: {final_url}"));
        JsErrorBox::generic(format!("Failed to parse JSON: {e}"))
    })?;
    let json_kind = match &json {
        JsonValue::Object(_) => "object",
        JsonValue::Array(_) => "array",
        JsonValue::String(_) => "string",
        JsonValue::Number(_) => "number",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Null => "null",
    };
    emit_http_info(
        &task_id,
        format!("[fetch_json] JSON 请求成功：{final_url}（type={json_kind}）"),
    );
    Ok(wrap_non_object_json(json))
}

#[op2]
#[string]
pub async fn op_kabegame_current_url(state: Rc<RefCell<OpState>>) -> Result<String, JsErrorBox> {
    current_page_value_async(state, |entry| entry.url.clone()).await
}

#[op2]
#[string]
pub async fn op_kabegame_current_html(state: Rc<RefCell<OpState>>) -> Result<String, JsErrorBox> {
    current_page_value_async(state, |entry| entry.html.clone()).await
}

#[op2]
#[serde]
pub async fn op_kabegame_current_headers(
    state: Rc<RefCell<OpState>>,
) -> Result<HashMap<String, String>, JsErrorBox> {
    current_page_value_async(state, |entry| entry.headers.clone()).await
}

#[op2]
#[serde]
pub fn op_kabegame_plugin_data(state: &mut OpState) -> Result<JsonValue, JsErrorBox> {
    let plugin_id = state.borrow::<KabegameOpState>().plugin_id.clone();
    Storage::global()
        .plugin_data()
        .get(&plugin_id)
        .map(|value| value.unwrap_or_else(|| JsonValue::Object(Default::default())))
        .map_err(|e| JsErrorBox::generic(format!("plugin_data get: {e}")))
}

#[op2]
pub fn op_kabegame_set_plugin_data(
    state: &mut OpState,
    #[serde] value: JsonValue,
) -> Result<(), JsErrorBox> {
    if !value.is_object() {
        return Err(JsErrorBox::generic("set_plugin_data: value must be an object"));
    }
    let plugin_id = state.borrow::<KabegameOpState>().plugin_id.clone();
    Storage::global()
        .plugin_data()
        .set(&plugin_id, &value)
        .map_err(|e| JsErrorBox::generic(format!("plugin_data set: {e}")))
}

#[op2(fast)]
pub fn op_kabegame_set_header(
    state: &mut OpState,
    #[string] key: String,
    #[string] value: String,
) {
    let k = key.trim();
    if k.is_empty() {
        return;
    }
    let task_id = state.borrow::<KabegameOpState>().task_id.clone();
    if let Err(e) = HeaderName::from_bytes(k.as_bytes()) {
        emit_http_warn(&task_id, format!("[headers] 跳过无效 header 名：{k} ({e})"));
        return;
    }
    if let Err(e) = HeaderValue::from_str(&value) {
        emit_http_warn(&task_id, format!("[headers] 跳过无效 header 值：{k} ({e})"));
        return;
    }
    state
        .borrow_mut::<KabegameOpState>()
        .headers
        .insert(k.to_string(), value);
}

#[op2(fast)]
pub fn op_kabegame_del_header(state: &mut OpState, #[string] key: String) {
    let k = key.trim();
    if !k.is_empty() {
        state.borrow_mut::<KabegameOpState>().headers.remove(k);
    }
}

#[op2(fast)]
pub fn op_kabegame_warn(state: &mut OpState, #[string] msg: String) {
    let task_id = state.borrow::<KabegameOpState>().task_id.clone();
    emit_http_warn(&task_id, msg);
}

#[op2(fast)]
pub fn op_kabegame_add_progress(
    state: &mut OpState,
    percentage: f64,
) -> Result<f64, JsErrorBox> {
    {
        let state = state.borrow::<KabegameOpState>();
        check_cancelled(&state.cancel)?;
    }

    let (task_id, final_progress) = {
        let state = state.borrow_mut::<KabegameOpState>();
        state.progress = (state.progress + percentage).clamp(0.0, 99.9);
        (state.task_id.clone(), state.progress)
    };
    GlobalEmitter::global().emit_task_progress(&task_id, final_progress);
    Ok(final_progress)
}

#[op2]
pub async fn op_kabegame_download_image(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
    #[serde] opts: Option<JsonValue>,
) -> Result<(), JsErrorBox> {
    let (download_queue, images_dir, plugin_id, task_id, output_album_id, headers, cancel) =
        state_snapshot(&state, |s| {
            (
                s.download_queue.clone(),
                s.images_dir.clone(),
                s.plugin_id.clone(),
                s.task_id.clone(),
                s.output_album_id.clone(),
                s.headers.clone(),
                s.cancel.clone(),
            )
        });
    check_cancelled(&cancel)?;

    let (custom_name, metadata_id) = parse_download_opts(opts, &plugin_id)?;
    let parsed_url =
        Url::parse(&url).map_err(|e| JsErrorBox::generic(format!("Invalid URL: {e}")))?;
    let download_start_time = now_ms();
    let fut = download_queue.download_image(
        parsed_url,
        images_dir,
        plugin_id,
        task_id,
        download_start_time,
        output_album_id,
        headers,
        custom_name,
        metadata_id,
    );
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(JsErrorBox::generic("Task canceled")),
        result = fut => result.map_err(|e| JsErrorBox::generic(format!("Failed to download image: {e}"))),
    }
}

#[op2]
#[bigint]
pub fn op_kabegame_create_image_metadata(
    state: &mut OpState,
    #[serde] value: JsonValue,
    #[serde] opts: Option<JsonValue>,
) -> Result<i64, JsErrorBox> {
    let plugin_id = state.borrow::<KabegameOpState>().plugin_id.clone();
    let version = parse_create_image_metadata_version(opts)?;
    Storage::global()
        .insert_image_metadata_row(&value, &plugin_id, version)
        .map_err(|e| JsErrorBox::generic(format!("create_image_metadata: {e}")))
}

fn state_snapshot<T>(state: &Rc<RefCell<OpState>>, f: impl FnOnce(&KabegameOpState) -> T) -> T {
    let state = state.borrow();
    f(state.borrow::<KabegameOpState>())
}

fn check_cancelled(cancel: &CancellationToken) -> Result<(), JsErrorBox> {
    if cancel.is_cancelled() {
        Err(JsErrorBox::generic("Task canceled"))
    } else {
        Ok(())
    }
}

async fn get_page_stack_async(
    task_id: &str,
) -> Result<crate::crawler::task_scheduler::PageStack, JsErrorBox> {
    TaskScheduler::global()
        .page_stacks()
        .get_stack(task_id)
        .await
        .ok_or_else(|| JsErrorBox::generic(format!("Page stack not found for task {task_id}")))
}

async fn current_page_value_async<T>(
    state: Rc<RefCell<OpState>>,
    f: impl FnOnce(&PageStackEntry) -> T,
) -> Result<T, JsErrorBox> {
    let task_id = state_snapshot(&state, |s| s.task_id.clone());
    let stack = get_page_stack_async(&task_id).await?;
    let stack_guard = stack
        .lock()
        .map_err(|e| JsErrorBox::generic(format!("Lock error: {e}")))?;
    let entry = stack_guard
        .last()
        .ok_or_else(|| JsErrorBox::generic("Page stack is empty"))?;
    Ok(f(entry))
}

async fn resolve_url_for_task_async(task_id: &str, url: &str) -> Result<String, JsErrorBox> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(url.to_string());
    }

    let stack = get_page_stack_async(task_id).await?;
    let base_url = {
        let stack_guard = stack
            .lock()
            .map_err(|e| JsErrorBox::generic(format!("Lock error: {e}")))?;
        stack_guard
            .last()
            .map(|entry| entry.url.clone())
            .unwrap_or_else(|| url.to_string())
    };
    let base =
        Url::parse(&base_url).map_err(|e| JsErrorBox::generic(format!("Invalid base URL: {e}")))?;
    base.join(url)
        .map(|url| url.to_string())
        .map_err(|e| JsErrorBox::generic(format!("Failed to resolve URL: {e}")))
}

fn wrap_non_object_json(value: JsonValue) -> JsonValue {
    if value.is_object() {
        value
    } else {
        let mut map = serde_json::Map::new();
        map.insert("data".to_string(), value);
        JsonValue::Object(map)
    }
}

fn parse_download_opts(
    opts: Option<JsonValue>,
    plugin_id: &str,
) -> Result<(Option<String>, Option<i64>), JsErrorBox> {
    let Some(opts) = opts else {
        return Ok((None, None));
    };
    let opts = opts
        .as_object()
        .ok_or_else(|| JsErrorBox::generic("download_image opts must be an object"))?;

    let custom_name = optional_string(opts, "name", "download_image")?;
    let metadata_id = optional_i64(opts, "metadata_id", "download_image")?;
    let metadata = opts.get("metadata").filter(|v| !v.is_null()).cloned();
    let metadata_version = optional_u32(opts, "metadata_version", "download_image")?.unwrap_or(0);
    let metadata_id = if let Some(id) = metadata_id {
        Some(id)
    } else if let Some(value) = metadata {
        Some(
            Storage::global()
                .insert_image_metadata_row(&value, plugin_id, metadata_version)
                .map_err(JsErrorBox::generic)?,
        )
    } else {
        None
    };

    Ok((custom_name, metadata_id))
}

fn parse_create_image_metadata_version(opts: Option<JsonValue>) -> Result<u32, JsErrorBox> {
    let Some(opts) = opts else {
        return Ok(0);
    };
    let opts = opts
        .as_object()
        .ok_or_else(|| JsErrorBox::generic("create_image_metadata opts must be an object"))?;
    optional_u32(opts, "version", "create_image_metadata").map(|v| v.unwrap_or(0))
}

fn optional_string(
    opts: &serde_json::Map<String, JsonValue>,
    key: &str,
    label: &str,
) -> Result<Option<String>, JsErrorBox> {
    match opts.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(s)) => Ok(if s.trim().is_empty() {
            None
        } else {
            Some(s.clone())
        }),
        Some(_) => Err(JsErrorBox::generic(format!(
            "{label} opts: `{key}` must be a string if present"
        ))),
    }
}

fn optional_i64(
    opts: &serde_json::Map<String, JsonValue>,
    key: &str,
    label: &str,
) -> Result<Option<i64>, JsErrorBox> {
    match opts.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Number(n)) => n.as_i64().map(Some).ok_or_else(|| {
            JsErrorBox::generic(format!("{label} opts: `{key}` must be an integer if present"))
        }),
        Some(_) => Err(JsErrorBox::generic(format!(
            "{label} opts: `{key}` must be an integer if present"
        ))),
    }
}

fn optional_u32(
    opts: &serde_json::Map<String, JsonValue>,
    key: &str,
    label: &str,
) -> Result<Option<u32>, JsErrorBox> {
    match optional_i64(opts, key, label)? {
        None => Ok(None),
        Some(v) if v < 0 => Err(JsErrorBox::generic(format!("{label} opts: `{key}` must be >= 0"))),
        Some(v) => u32::try_from(v)
            .map(Some)
            .map_err(|_| JsErrorBox::generic(format!("{label} opts: `{key}` is too large"))),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn backoff_ms_for_attempt(attempt: u32) -> u64 {
    (500u64)
        .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
        .min(5000)
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error()
}

fn emit_http_warn(task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "warn", &message.into());
}

fn emit_http_info(task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "info", &message.into());
}

fn emit_http_error(task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "error", &message.into());
}

fn response_headers_to_map(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in headers.iter() {
        let key = name.as_str().to_lowercase();
        let val = value.to_str().unwrap_or("").to_string();
        out.entry(key)
            .and_modify(|e: &mut String| {
                e.push_str(", ");
                e.push_str(&val);
            })
            .or_insert(val);
    }
    out
}

async fn http_get_text_with_retry(
    task_id: &str,
    url: &str,
    label: &str,
    headers: &HashMap<String, String>,
    cancel: &CancellationToken,
) -> Result<(String, String, HashMap<String, String>), JsErrorBox> {
    let client = create_async_client()?;
    let header_map = build_reqwest_header_map(task_id, headers);
    let retry_count = Settings::global().get_network_retry_count();
    let max_attempts = retry_count.saturating_add(1).max(1);

    for attempt in 1..=max_attempts {
        let mut current_url = url.to_string();
        let mut redirect_count = 0;

        let response = loop {
            check_cancelled(cancel)?;
            let mut req = client.get(&current_url);
            if !header_map.is_empty() {
                req = req.headers(header_map.clone());
            }
            let resp = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(JsErrorBox::generic("Task canceled")),
                result = req.send() => result.map_err(|e| format!("Failed to fetch: {e}")),
            };

            let resp = match resp {
                Ok(resp) => resp,
                Err(e) => break Err(e),
            };
            let status = resp.status();
            if status.is_redirection() {
                if redirect_count >= 10 {
                    let msg = format!("[{label}] 重定向次数过多（>10）");
                    eprintln!("{msg} URL: {current_url}");
                    emit_http_error(task_id, format!("{msg}，URL: {current_url}"));
                    break Err("Too many redirects".to_string());
                }
                if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                    if let Ok(loc_str) = loc.to_str() {
                        let next_url =
                            if loc_str.starts_with("http://") || loc_str.starts_with("https://") {
                                loc_str.to_string()
                            } else {
                                match Url::parse(&current_url).and_then(|u| u.join(loc_str)) {
                                    Ok(u) => u.to_string(),
                                    Err(e) => {
                                        let msg = format!("[{label}] 重定向 URL 解析失败：{e}");
                                        eprintln!("{msg} URL: {current_url}");
                                        emit_http_error(
                                            task_id,
                                            format!("{msg}，URL: {current_url}"),
                                        );
                                        break Err(format!("Redirect parse error: {e}"));
                                    }
                                }
                            };

                        redirect_count += 1;
                        emit_http_warn(
                            task_id,
                            format!("[{label}] HTTP {} 跳转到：{next_url}", status.as_u16()),
                        );
                        current_url = next_url;
                        continue;
                    }
                }
            }

            break Ok(resp);
        };

        let response = match response {
            Ok(r) => r,
            Err(e) => {
                if attempt < max_attempts {
                    sleep_before_retry(task_id, label, attempt, max_attempts, &e, cancel).await?;
                    continue;
                }
                let msg = format!("[{label}] 请求失败：{e}");
                eprintln!("{msg} URL: {url}");
                emit_http_error(task_id, format!("{msg}，URL: {url}"));
                return Err(JsErrorBox::generic(e));
            }
        };

        let status = response.status();
        if !status.is_success() {
            let retryable = is_retryable_status(status);
            if retryable && attempt < max_attempts {
                let backoff_ms = backoff_ms_for_attempt(attempt);
                emit_http_warn(
                    task_id,
                    format!(
                        "[{label}] HTTP {status}，将于 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})，URL: {current_url}"
                    ),
                );
                cancellable_sleep(Duration::from_millis(backoff_ms), cancel).await?;
                continue;
            }
            let msg = format!("[{label}] HTTP 错误：{status}");
            eprintln!("{msg} URL: {current_url}");
            emit_http_error(task_id, format!("{msg}，URL: {current_url}"));
            return Err(JsErrorBox::generic(format!("HTTP error: {status}")));
        }

        let final_url = current_url;
        let resp_headers = response_headers_to_map(response.headers());
        let text = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(JsErrorBox::generic("Task canceled")),
            result = response.text() => result,
        };
        match text {
            Ok(text) => return Ok((final_url, text, resp_headers)),
            Err(e) => {
                if attempt < max_attempts {
                    let message = format!("Failed to fetch: {e}");
                    sleep_before_retry(task_id, label, attempt, max_attempts, &message, cancel)
                        .await?;
                    continue;
                }
                let msg = format!("[{label}] 读取响应失败：{e}");
                eprintln!("{msg} URL: {final_url}");
                emit_http_error(task_id, format!("{msg}，URL: {final_url}"));
                return Err(JsErrorBox::generic(format!("Failed to fetch: {e}")));
            }
        }
    }

    Err(JsErrorBox::generic("Unreachable"))
}

async fn sleep_before_retry(
    task_id: &str,
    label: &str,
    attempt: u32,
    max_attempts: u32,
    error: &str,
    cancel: &CancellationToken,
) -> Result<(), JsErrorBox> {
    let backoff_ms = backoff_ms_for_attempt(attempt);
    emit_http_warn(
        task_id,
        format!(
            "[{label}] 请求失败，将在 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})：{error}"
        ),
    );
    cancellable_sleep(Duration::from_millis(backoff_ms), cancel).await
}

async fn cancellable_sleep(
    duration: Duration,
    cancel: &CancellationToken,
) -> Result<(), JsErrorBox> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(JsErrorBox::generic("Task canceled")),
        _ = tokio::time::sleep(duration) => Ok(()),
    }
}

fn create_async_client() -> Result<reqwest::Client, JsErrorBox> {
    let mut client_builder = reqwest::Client::builder();
    let config = crate::crawler::proxy::get_proxy_config();

    if let Some(ref proxy_url) = config.proxy_url {
        match reqwest::Proxy::all(proxy_url) {
            Ok(proxy) => {
                client_builder = client_builder.proxy(proxy);
                eprintln!("网络代理已配置 (async): {proxy_url}");
            }
            Err(e) => {
                eprintln!("代理配置无效 ({proxy_url}), 将使用直连 (async): {e}");
            }
        }
    }

    if let Some(ref no_proxy) = config.no_proxy {
        for domain in no_proxy.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if let Ok(proxy) = reqwest::Proxy::all(format!("direct://{domain}")) {
                client_builder = client_builder.proxy(proxy);
            }
        }
    }

    client_builder = client_builder
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Kabegame/1.0");

    client_builder
        .build()
        .map_err(|e| JsErrorBox::generic(format!("Failed to create async HTTP client: {e}")))
}

fn build_reqwest_header_map(task_id: &str, headers: &HashMap<String, String>) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let name = match HeaderName::from_bytes(key.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                emit_http_warn(
                    task_id,
                    format!("[headers] 跳过无效 header 名：{key} ({e})"),
                );
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(v) => v,
            Err(e) => {
                emit_http_warn(
                    task_id,
                    format!("[headers] 跳过无效 header 值：{key} ({e})"),
                );
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}
