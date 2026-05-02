use crate::crawler::scheduler::PageStackEntry;
use crate::crawler::xhh_sign;
use crate::crawler::TaskScheduler;
use crate::emitter::GlobalEmitter;
use crate::plugin::Plugin;
use crate::settings::Settings;
use crate::storage::Storage;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rhai::packages::Package;
use rhai::{Dynamic, Engine, Map, Position, Scope};
use rhai_chrono::ChronoPackage;
use scraper::{Html, Selector};
use serde_json::{Map as JsonMap, Number, Value as JsonValue};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;

type Shared<T> = Arc<Mutex<T>>;

fn rhai_dynamic_to_json_value(d: &Dynamic) -> Result<JsonValue, Box<rhai::EvalAltResult>> {
    if d.is_unit() {
        return Ok(JsonValue::Null);
    }
    if d.is_bool() {
        return Ok(JsonValue::Bool(d.as_bool().unwrap()));
    }
    if d.is_int() {
        return Ok(JsonValue::Number(Number::from(d.as_int().unwrap())));
    }
    if d.is_float() {
        let f = d.as_float().unwrap();
        return Ok(Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null));
    }
    if d.is_string() {
        return Ok(JsonValue::String(d.clone().into_string().unwrap()));
    }
    if d.is_array() {
        let arr = d.clone().into_array().unwrap();
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            out.push(rhai_dynamic_to_json_value(&item)?);
        }
        return Ok(JsonValue::Array(out));
    }
    if d.is_map() {
        let m: Map = d.clone().try_cast::<Map>().ok_or_else(|| {
            Box::<rhai::EvalAltResult>::from("download_image opts: metadata map cast failed")
        })?;
        let mut obj = JsonMap::new();
        for (k, v) in m {
            obj.insert(k.to_string(), rhai_dynamic_to_json_value(&v)?);
        }
        return Ok(JsonValue::Object(obj));
    }
    Err("download_image opts: metadata contains unsupported Rhai type".into())
}

fn safe_filename_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.';
        out.push(if ok { ch } else { '_' });
    }
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

fn lock_or_inner<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    }
}

fn get_task_id(task_id_holder: &Shared<String>) -> String {
    lock_or_inner(task_id_holder).clone()
}

/// Rhai `download_image` 系列共用的同步入队逻辑（在 Rhai 引擎线程内 `block_on`）。
fn run_rhai_download_image_sync(
    dq_handle: &crate::crawler::DownloadQueue,
    images_dir: PathBuf,
    plugin_id: String,
    task_id: String,
    output_album_id: Option<String>,
    http_headers: HashMap<String, String>,
    url: &str,
    custom_display_name: Option<String>,
    metadata: Option<serde_json::Value>,
    metadata_id: Option<i64>,
) -> Result<(), Box<rhai::EvalAltResult>> {
    if dq_handle.is_task_canceled_blocking(&task_id) {
        return Err("Task canceled".into());
    }

    // 注意：不在 Rhai 层做「按本地路径已存在就跳过」的短路。
    const MAX_TASK_IMAGES: usize = 10000;
    let storage = Storage::global();
    match storage.get_task_image_ids(&task_id) {
        Ok(image_ids) => {
            if image_ids.len() >= MAX_TASK_IMAGES {
                return Err(format!(
                    "任务图片数量已达到上限（{} 张），无法继续爬取",
                    MAX_TASK_IMAGES
                )
                .into());
            }
        }
        Err(e) => {
            return Err(format!("检查任务图片数量失败: {}", e).into());
        }
    }

    let download_start_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let parsed_url = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let fut = dq_handle.download_image(
        parsed_url,
        images_dir,
        plugin_id,
        task_id,
        download_start_time,
        output_album_id,
        http_headers,
        custom_display_name,
        metadata,
        metadata_id,
    );
    tokio::runtime::Handle::current()
        .block_on(fut)
        .map_err(|e| format!("Failed to download image: {}", e).into())
}

/// 从 Rhai `download_image(url, opts)` 的 `opts` map 解析 `name` / `metadata` / `metadata_id`。
fn parse_download_image_opts_from_map(
    opts: &Map,
) -> Result<(Option<String>, Option<serde_json::Value>, Option<i64>), Box<rhai::EvalAltResult>> {
    let opt_str = |key: &str| -> Result<Option<String>, Box<rhai::EvalAltResult>> {
        match opts.get(key) {
            None => Ok(None),
            Some(d) if d.is_unit() => Ok(None),
            Some(d) if d.is_string() => {
                let s = d.clone().into_string().unwrap();
                Ok(if s.trim().is_empty() { None } else { Some(s) })
            }
            Some(_) => {
                Err(format!("download_image opts: `{key}` must be a string if present").into())
            }
        }
    };
    let metadata_id = match opts.get("metadata_id") {
        None => None,
        Some(d) if d.is_unit() => None,
        Some(d) if d.is_int() => Some(d.as_int().unwrap()),
        Some(_) => {
            return Err("download_image opts: `metadata_id` must be an integer if present".into());
        }
    };
    let metadata = match opts.get("metadata") {
        None => None,
        Some(d) if d.is_unit() => None,
        Some(d) => Some(rhai_dynamic_to_json_value(d)?),
    };
    let metadata = if metadata_id.is_some() {
        None
    } else {
        metadata
    };
    Ok((opt_str("name")?, metadata, metadata_id))
}

fn get_page_stack(
    task_id_holder: &Shared<String>,
) -> Result<crate::crawler::scheduler::PageStack, Box<rhai::EvalAltResult>> {
    let task_id = get_task_id(task_id_holder);
    TaskScheduler::global()
        .page_stacks()
        .get_stack(&task_id)
        .ok_or_else(|| format!("Page stack not found for task {task_id}").into())
}

fn get_network_retry_count(_dq: &crate::crawler::DownloadQueue) -> u32 {
    Settings::global().get_network_retry_count()
}

fn backoff_ms_for_attempt(attempt: u32) -> u64 {
    // 与 download_image 保持一致：500ms * 2^(attempt-1)，上限 5000ms
    (500u64)
        .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
        .min(5000)
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error()
}

fn emit_http_warn(_dq: &crate::crawler::DownloadQueue, task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "warn", &message.into());
}

fn emit_http_info(_dq: &crate::crawler::DownloadQueue, task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "info", &message.into());
}

fn emit_http_error(_dq: &crate::crawler::DownloadQueue, task_id: &str, message: impl Into<String>) {
    GlobalEmitter::global().emit_task_log(task_id, "error", &message.into());
}

/// 将最后一次成功响应的 HeaderMap 转为小写键名；同名多值用 `, ` 拼接。
fn response_headers_to_map(resp: &reqwest::blocking::Response) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (name, value) in resp.headers().iter() {
        let key = name.as_str().to_lowercase();
        let val = value.to_str().unwrap_or("").to_string();
        out.entry(key)
            .and_modify(|e| {
                e.push_str(", ");
                e.push_str(&val);
            })
            .or_insert(val);
    }
    out
}

fn http_get_text_with_retry(
    dq: &crate::crawler::DownloadQueue,
    task_id: &str,
    url: &str,
    label: &str,
    headers: &HashMap<String, String>,
) -> Result<(String, String, HashMap<String, String>), String> {
    let client = create_blocking_client()?;
    let header_map = build_reqwest_header_map(dq, task_id, headers);
    let retry_count = get_network_retry_count(dq);
    let max_attempts = retry_count.saturating_add(1).max(1);

    for attempt in 1..=max_attempts {
        let mut current_url = url.to_string();
        let mut redirect_count = 0;

        let response = loop {
            if dq.is_task_canceled_blocking(task_id) {
                return Err("Task canceled".to_string());
            }

            let mut req = client.get(&current_url);
            if !header_map.is_empty() {
                req = req.headers(header_map.clone());
            }
            let resp = match req.send() {
                Ok(r) => r,
                Err(e) => break Err(format!("Failed to fetch: {}", e)),
            };

            let status = resp.status();
            if status.is_redirection() {
                if redirect_count >= 10 {
                    let msg = format!("[{label}] 重定向次数过多（>10）");
                    eprintln!("{msg} URL: {current_url}");
                    emit_http_error(dq, task_id, format!("{msg}，URL: {current_url}"));
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
                                            dq,
                                            task_id,
                                            format!("{msg}，URL: {current_url}"),
                                        );
                                        break Err(format!("Redirect parse error: {e}"));
                                    }
                                }
                            };

                        redirect_count += 1;
                        emit_http_warn(
                            dq,
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
                    let backoff_ms = backoff_ms_for_attempt(attempt);
                    emit_http_warn(
                        dq,
                        task_id,
                        format!(
                            "[{label}] 请求失败，将在 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})：{e}"
                        ),
                    );
                    std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    continue;
                }
                let msg = format!("[{label}] 请求失败：{e}");
                eprintln!("{msg} URL: {url}");
                emit_http_error(dq, task_id, format!("{msg}，URL: {url}"));
                return Err(e);
            }
        };

        let status = response.status();
        if !status.is_success() {
            let retryable = is_retryable_status(status);
            if retryable && attempt < max_attempts {
                let backoff_ms = backoff_ms_for_attempt(attempt);
                emit_http_warn(
                    dq,
                    task_id,
                    format!(
                        "[{label}] HTTP {status}，将于 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})，URL: {current_url}"
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                continue;
            }
            let msg = format!("[{label}] HTTP 错误：{status}");
            eprintln!("{msg} URL: {current_url}");
            emit_http_error(dq, task_id, format!("{msg}，URL: {current_url}"));
            return Err(format!("HTTP error: {status}"));
        }

        let final_url = current_url;
        let resp_headers = response_headers_to_map(&response);
        match response.text() {
            Ok(text) => return Ok((final_url, text, resp_headers)),
            Err(e) => {
                if attempt < max_attempts {
                    let backoff_ms = backoff_ms_for_attempt(attempt);
                    emit_http_warn(
                        dq,
                        task_id,
                        format!(
                            "[{label}] 读取响应失败，将在 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})：{e}"
                        ),
                    );
                    std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    continue;
                }
                let msg = format!("[{label}] 读取响应失败：{e}");
                eprintln!("{msg} URL: {final_url}");
                emit_http_error(dq, task_id, format!("{msg}，URL: {final_url}"));
                return Err(format!("Failed to fetch: {e}"));
            }
        }
    }

    Err("Unreachable".to_string())
}

fn create_blocking_client() -> Result<reqwest::blocking::Client, String> {
    let mut client_builder = reqwest::blocking::Client::builder();

    let config = crate::crawler::proxy::get_proxy_config();

    if let Some(ref proxy_url) = config.proxy_url {
        match reqwest::Proxy::all(proxy_url) {
            Ok(proxy) => {
                client_builder = client_builder.proxy(proxy);
                eprintln!("网络代理已配置 (blocking): {}", proxy_url);
            }
            Err(e) => {
                eprintln!("代理配置无效 ({}), 将使用直连 (blocking): {}", proxy_url, e);
            }
        }
    }

    if let Some(ref no_proxy) = config.no_proxy {
        let no_proxy_list: Vec<&str> = no_proxy.split(',').map(|s| s.trim()).collect();
        for domain in no_proxy_list {
            if !domain.is_empty() {
                if let Ok(proxy) = reqwest::Proxy::all(&format!("direct://{}", domain)) {
                    client_builder = client_builder.proxy(proxy);
                }
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
        .map_err(|e| format!("Failed to create blocking HTTP client: {}", e))
}

fn build_reqwest_header_map(
    dq: &crate::crawler::DownloadQueue,
    task_id: &str,
    headers: &HashMap<String, String>,
) -> HeaderMap {
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
                    dq,
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
                    dq,
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
/// task worker 线程内可复用的 Rhai runtime（Engine + 可变任务上下文）
///
/// 关键点：
/// - `Engine` 只初始化/注册一次（避免重复 register_fn 导致 overload 叠加）
/// - 每个任务开始前仅更新这些共享 holder，脚本运行期间函数从 holder 读取当前上下文
pub struct RhaiCrawlerRuntime {
    pub(crate) engine: Engine,
    download_queue: Arc<crate::crawler::DownloadQueue>,
    // emitter 现在是全局单例，不需要存储
    images_dir: Shared<PathBuf>,
    plugin_id: Shared<String>,
    task_id: Shared<String>,
    current_progress: Shared<Arc<Mutex<f64>>>,
    output_album_id: Shared<Option<String>>,
    http_headers: Shared<HashMap<String, String>>,
}

impl RhaiCrawlerRuntime {
    pub fn new(download_queue: Arc<crate::crawler::DownloadQueue>) -> Self {
        let mut engine = Engine::new();
        // 提高表达式嵌套深度上限，避免爬虫脚本中嵌套 for/while、模板字符串等触发 "Expression exceeds maximum complexity"
        engine.set_max_expr_depths(128, 64);
        let images_dir: Shared<PathBuf> = Arc::new(Mutex::new(PathBuf::new()));
        let plugin_id: Shared<String> = Arc::new(Mutex::new(String::new()));
        let task_id: Shared<String> = Arc::new(Mutex::new(String::new()));
        let current_progress: Shared<Arc<Mutex<f64>>> =
            Arc::new(Mutex::new(Arc::new(Mutex::new(0.0))));
        let output_album_id: Shared<Option<String>> = Arc::new(Mutex::new(None));
        let http_headers: Shared<HashMap<String, String>> = Arc::new(Mutex::new(HashMap::new()));

        // 将 Rhai 的 print/debug 输出重定向为 task-log 事件，供前端实时展示
        {
            let task_id_for_print = Arc::clone(&task_id);
            engine.on_print(move |s: &str| {
                let tid = match task_id_for_print.lock() {
                    Ok(g) => g.clone(),
                    Err(e) => e.into_inner().clone(),
                };
                GlobalEmitter::global().emit_task_log(&tid, "print", s);
            });
        }
        {
            let task_id_for_debug = Arc::clone(&task_id);
            engine.on_debug(move |s: &str, src: Option<&str>, pos: Position| {
                let tid = match task_id_for_debug.lock() {
                    Ok(g) => g.clone(),
                    Err(e) => e.into_inner().clone(),
                };
                let src = src.unwrap_or("unknown");
                GlobalEmitter::global().emit_task_log(
                    &tid,
                    "debug",
                    &format!("{src} @ {pos:?} > {s}"),
                );
            });
        }

        register_crawler_functions(
            &mut engine,
            Arc::clone(&images_dir),
            Arc::clone(&download_queue),
            Arc::clone(&plugin_id),
            Arc::clone(&task_id),
            Arc::clone(&current_progress),
            Arc::clone(&output_album_id),
            Arc::clone(&http_headers),
        );

        ChronoPackage::new().register_into_engine(&mut engine);

        Self {
            engine,
            download_queue,
            images_dir,
            plugin_id,
            task_id,
            current_progress,
            output_album_id,
            http_headers,
        }
    }

    pub fn reset_for_task(
        &self,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) {
        // 每个任务都重置 progress，避免跨任务污染
        {
            let mut guard = match self.current_progress.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = Arc::new(Mutex::new(0.0));
        }
        {
            let mut guard = match self.images_dir.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = images_dir;
        }
        {
            let mut guard = match self.plugin_id.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = plugin_id;
        }
        {
            let mut guard = match self.task_id.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = task_id;
        }
        {
            let mut guard = match self.output_album_id.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = output_album_id;
        }
        {
            let mut guard = match self.http_headers.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = http_headers;
        }
    }
}

/// 注册爬虫相关的 Rhai 函数
pub fn register_crawler_functions(
    engine: &mut Engine,
    images_dir: Shared<PathBuf>,
    download_queue: Arc<crate::crawler::DownloadQueue>,
    plugin_id: Shared<String>,
    task_id: Shared<String>,
    current_progress: Shared<Arc<Mutex<f64>>>,
    output_album_id: Shared<Option<String>>,
    http_headers: Shared<HashMap<String, String>>,
) {
    // url_encode(s) - 对字符串进行 URL 百分号编码（用于 query/path）
    engine.register_fn("url_encode", |s: &str| -> String {
        urlencoding::encode(s).into_owned()
    });

    // sleep(secs) - 阻塞当前线程指定秒数（支持小数；上限 300s）
    engine.register_fn("sleep", |secs: f64| {
        let clamped = secs.max(0.0).min(300.0);
        std::thread::sleep(std::time::Duration::from_secs_f64(clamped));
    });

    // rand_f64(min, max) - 返回 [min, max) 范围内的伪随机浮点数
    // 使用线程局部 XorShift64，首次调用以 SystemTime 纳秒为种子
    engine.register_fn("rand_f64", |min: f64, max: f64| -> f64 {
        use std::cell::Cell;
        use std::time::{SystemTime, UNIX_EPOCH};
        thread_local! {
            static STATE: Cell<u64> = Cell::new(0);
        }
        STATE.with(|s| {
            let mut x = s.get();
            if x == 0 {
                x = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(12345678901234567);
                if x == 0 {
                    x = 1;
                }
            }
            // XorShift64
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            s.set(x);
            let t = (x >> 11) as f64 / (1u64 << 53) as f64; // [0, 1)
            min + t * (max - min)
        })
    });

    // unix_time_ms() - 返回当前 Unix 时间戳（毫秒）
    engine.register_fn("unix_time_ms", || -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    });

    // xhh_nonce(t) - 生成 XHH nonce（32位大写十六进制）
    engine.register_fn("xhh_nonce", |t: i64| -> String { xhh_sign::xhh_nonce(t) });

    // xhh_hkey(path, t, nonce) - 计算 XHH hkey 签名字符串（7字符）
    engine.register_fn("xhh_hkey", |path: &str, t: i64, nonce: &str| -> String {
        xhh_sign::xhh_hkey(path, t, nonce)
    });

    // re_is_match(pattern, text) - 正则匹配判断（pattern 使用 Rust regex 语法）
    // 注意：pattern 编译失败时返回 false
    engine.register_fn("re_is_match", |pattern: &str, text: &str| -> bool {
        regex::Regex::new(pattern)
            .map(|re| re.is_match(text))
            .unwrap_or(false)
    });

    // re_replace_all(pattern, replacement, text)：全局正则替换（Rust regex；replacement 可用 $0/$1 等）
    // pattern 无效时返回原文本
    engine.register_fn(
        "re_replace_all",
        |pattern: &str, replacement: &str, text: &str| -> String {
            regex::Regex::new(pattern)
                .map(|re| re.replace_all(text, replacement).into_owned())
                .unwrap_or_else(|_| text.to_string())
        },
    );

    engine.register_fn("set_header", {
        let headers_holder = Arc::clone(&http_headers);
        let dq_holder = Arc::clone(&download_queue);
        let task_id_holder = Arc::clone(&task_id);
        move |key: &str, value: &str| {
            let k = key.trim();
            if k.is_empty() {
                return;
            }
            if let Err(e) = HeaderName::from_bytes(k.as_bytes()) {
                let tid = get_task_id(&task_id_holder);
                emit_http_warn(
                    dq_holder.as_ref(),
                    &tid,
                    format!("[headers] 跳过无效 header 名：{k} ({e})"),
                );
                return;
            }
            if let Err(e) = HeaderValue::from_str(value) {
                let tid = get_task_id(&task_id_holder);
                emit_http_warn(
                    dq_holder.as_ref(),
                    &tid,
                    format!("[headers] 跳过无效 header 值：{k} ({e})"),
                );
                return;
            }
            let mut guard = lock_or_inner(&headers_holder);
            guard.insert(k.to_string(), value.to_string());
        }
    });

    engine.register_fn("del_header", {
        let headers_holder = Arc::clone(&http_headers);
        move |key: &str| {
            let k = key.trim();
            if k.is_empty() {
                return;
            }
            let mut guard = lock_or_inner(&headers_holder);
            guard.remove(k);
        }
    });

    // warn(msg) — 向任务日志输出 warn 级别（与 HTTP 重试等一致，供脚本提示数量不足等）
    engine.register_fn("warn", {
        let task_id_holder = Arc::clone(&task_id);
        let dq_holder = Arc::clone(&download_queue);
        move |msg: &str| {
            let tid = get_task_id(&task_id_holder);
            emit_http_warn(dq_holder.as_ref(), &tid, msg.to_string());
        }
    });

    // to(url) - 访问一个网页，将当前页面入栈
    engine.register_fn("to", {
        let dq_holder = Arc::clone(&download_queue);
        let task_id_holder = Arc::clone(&task_id);
        let headers_holder = Arc::clone(&http_headers);
        // 注意：返回 Result<T, Box<EvalAltResult>> 时，脚本侧拿到的是 T（失败会直接抛出运行时错误）
        // 这样 print(to(...)) / print(current_html()) 不会出现 "Result<...>" 字样。
        move |url: &str| -> Result<(), Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|entry| entry.url.clone())
                    .unwrap_or_else(|| url.to_string())
            };

            // 解析 URL（可能是相对 URL）
            let resolved_url = if url.starts_with("http://") || url.starts_with("https://") {
                url.to_string()
            } else {
                let base = Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {}", e))?;
                base.join(url)
                    .map_err(|e| format!("Failed to resolve URL: {}", e))?
                    .to_string()
            };

            // 获取 HTML
            // 并增加失败重试 + 日志输出（风格与 download_image 一致：可取消、指数退避、最终失败 eprintln）
            let url_clone = resolved_url.clone();
            let dq_for_http = Arc::clone(&dq_holder);
            let task_id_for_http = get_task_id(&task_id_holder);
            let headers_for_http = {
                let guard = lock_or_inner(&headers_holder);
                guard.clone()
            };
            emit_http_info(
                dq_holder.as_ref(),
                &task_id_for_http,
                format!("[to] 打开页面：{resolved_url}"),
            );
            let (tx, rx) = std::sync::mpsc::channel();
            let result = http_get_text_with_retry(
                &dq_for_http,
                &task_id_for_http,
                &url_clone,
                "to",
                &headers_for_http,
            );
            let _ = tx.send(result);
            let (final_url, html, resp_headers) = rx
                .recv()
                .map_err(|e| format!("Thread communication error: {}", e))?
                .map_err(|e| e)?;

            // 将当前页面推入栈（如果栈不为空，先保存当前页面）
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard.push(PageStackEntry {
                url: final_url,
                html,
                headers: resp_headers,
                page_label: String::new(),
                page_state: serde_json::Value::Null,
            });
            if let Some(entry) = stack_guard.last() {
                emit_http_info(
                    dq_holder.as_ref(),
                    &task_id_for_http,
                    format!(
                        "[to] 页面已入栈：{}（stack_depth={}）",
                        entry.url,
                        stack_guard.len()
                    ),
                );
            }
            Ok(())
        }
    });

    // fetch_json(url) - 请求 JSON API 并解析为 Rhai 值，不入页面栈
    engine.register_fn("fetch_json", {
        let dq_holder = Arc::clone(&download_queue);
        let task_id_holder = Arc::clone(&task_id);
        let headers_holder = Arc::clone(&http_headers);
        move |url: &str| -> Result<Map, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|entry| entry.url.clone())
                    .unwrap_or_else(|| url.to_string())
            };

            // 解析 URL（可能是相对 URL）
            let resolved_url = if url.starts_with("http://") || url.starts_with("https://") {
                url.to_string()
            } else {
                let base = Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {}", e))?;
                base.join(url)
                    .map_err(|e| format!("Failed to resolve URL: {}", e))?
                    .to_string()
            };

            // 获取 JSON 响应（不入栈）
            let dq_for_http = Arc::clone(&dq_holder);
            let task_id_for_http = get_task_id(&task_id_holder);
            let headers_for_http = {
                let guard = lock_or_inner(&headers_holder);
                guard.clone()
            };
            emit_http_info(
                dq_holder.as_ref(),
                &task_id_for_http,
                format!("[fetch_json] 请求 JSON：{resolved_url}"),
            );
            let (final_url, text, _) = http_get_text_with_retry(
                &dq_for_http,
                &task_id_for_http,
                &resolved_url,
                "fetch_json",
                &headers_for_http,
            )?;
            let json_value = serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
                let msg = format!("[fetch_json] JSON 解析失败：{e}");
                eprintln!("{msg} URL: {final_url}");
                emit_http_error(
                    &dq_holder,
                    &task_id_for_http,
                    format!("{msg}，URL: {final_url}"),
                );
                format!("Failed to parse JSON: {}", e)
            })?;
            let json_kind = match &json_value {
                serde_json::Value::Object(_) => "object",
                serde_json::Value::Array(_) => "array",
                serde_json::Value::String(_) => "string",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::Bool(_) => "boolean",
                serde_json::Value::Null => "null",
            };
            emit_http_info(
                dq_holder.as_ref(),
                &task_id_for_http,
                format!("[fetch_json] JSON 请求成功：{final_url}（type={json_kind}）"),
            );

            // 将 JSON 值转换为 Rhai 类型
            match &json_value {
                serde_json::Value::Object(_) => {
                    // 如果是对象，转换为 Map
                    let mut map = Map::new();
                    convert_json_to_rhai_map(&json_value, &mut map);
                    Ok(map)
                }
                serde_json::Value::Array(_) => {
                    // 如果是数组，转换为 Array，然后包装在 Map 中
                    let mut array = rhai::Array::new();
                    convert_json_to_rhai_array(&json_value, &mut array);
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(array));
                    Ok(map)
                }
                serde_json::Value::String(s) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(s.clone()));
                    Ok(map)
                }
                serde_json::Value::Number(n) => {
                    let mut map = Map::new();
                    let value = if n.is_i64() {
                        Dynamic::from(n.as_i64().unwrap_or(0))
                    } else if n.is_u64() {
                        Dynamic::from(n.as_u64().unwrap_or(0) as i64)
                    } else if n.is_f64() {
                        Dynamic::from(n.as_f64().unwrap_or(0.0))
                    } else {
                        Dynamic::UNIT
                    };
                    map.insert("data".into(), value);
                    Ok(map)
                }
                serde_json::Value::Bool(b) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(*b));
                    Ok(map)
                }
                serde_json::Value::Null => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::UNIT);
                    Ok(map)
                }
            }
        }
    });

    // parse_json(text) - 解析 JSON 字符串并转换为 Rhai 值
    engine.register_fn(
        "parse_json",
        move |text: &str| -> Result<Map, Box<rhai::EvalAltResult>> {
            let json_value = serde_json::from_str::<serde_json::Value>(text)
                .map_err(|e| format!("Failed to parse JSON: {e}"))?;

            match &json_value {
                serde_json::Value::Object(_) => {
                    let mut map = Map::new();
                    convert_json_to_rhai_map(&json_value, &mut map);
                    Ok(map)
                }
                serde_json::Value::Array(_) => {
                    let mut array = rhai::Array::new();
                    convert_json_to_rhai_array(&json_value, &mut array);
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(array));
                    Ok(map)
                }
                serde_json::Value::String(s) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(s.clone()));
                    Ok(map)
                }
                serde_json::Value::Number(n) => {
                    let mut map = Map::new();
                    let value = if n.is_i64() {
                        Dynamic::from(n.as_i64().unwrap_or(0))
                    } else if n.is_u64() {
                        Dynamic::from(n.as_u64().unwrap_or(0) as i64)
                    } else if n.is_f64() {
                        Dynamic::from(n.as_f64().unwrap_or(0.0))
                    } else {
                        Dynamic::UNIT
                    };
                    map.insert("data".into(), value);
                    Ok(map)
                }
                serde_json::Value::Bool(b) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(*b));
                    Ok(map)
                }
                serde_json::Value::Null => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::UNIT);
                    Ok(map)
                }
            }
        },
    );

    // back() - 返回上一页，出栈
    engine.register_fn("back", {
        let task_id_holder = Arc::clone(&task_id);
        move || -> Result<(), Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            if stack_guard.is_empty() {
                return Err("Page stack is empty, cannot go back".into());
            }
            stack_guard.pop();
            Ok(())
        }
    });

    // current_url() - 获取当前栈顶的 URL
    engine.register_fn("current_url", {
        let task_id_holder = Arc::clone(&task_id);
        move || -> Result<String, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|entry| entry.url.clone())
                .ok_or_else(|| "Page stack is empty".into())
        }
    });

    // current_html() - 获取当前栈顶的 HTML
    engine.register_fn("current_html", {
        let task_id_holder = Arc::clone(&task_id);
        move || -> Result<String, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|entry| entry.html.clone())
                .ok_or_else(|| "Page stack is empty".into())
        }
    });

    // current_headers() - 获取当前栈顶页面最后一次 HTTP 响应头（与 current_html 同源）
    engine.register_fn("current_headers", {
        let task_id_holder = Arc::clone(&task_id);
        move || -> Result<Map, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            let entry = stack_guard
                .last()
                .ok_or_else(|| "Page stack is empty".to_string())?;
            let mut m = Map::new();
            for (k, v) in &entry.headers {
                m.insert(k.clone().into(), Dynamic::from(v.clone()));
            }
            Ok(m)
        }
    });

    // md5(text) - 小写 hex MD5，用于 WBI 等签名拼接
    engine.register_fn("md5", |text: &str| -> String {
        format!("{:x}", md5::compute(text.as_bytes()))
    });

    // query(selector) - 在当前栈顶页面查询元素文本
    // 支持 CSS 选择器和 XPath（以 / 或 // 开头）
    engine.register_fn("query", {
        let task_id_holder = Arc::clone(&task_id);
        move |selector: &str| -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|entry| entry.html.clone())
                    .ok_or_else(|| "Page stack is empty, call to(url) first".to_string())?
            };

            let mut results = rhai::Array::new();

            // 判断是 XPath 还是 CSS 选择器
            let is_xpath = selector.starts_with("/")
                || selector.starts_with("//")
                || selector.contains("[@")
                || selector.contains("::");

            if is_xpath {
                // 使用 XPath（使用 select crate）
                let document = select::document::Document::from(html.as_str());

                // 简单的 XPath 实现
                if selector.starts_with("//") {
                    // //tag 格式：查找所有 tag 元素
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("//").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                results.push(Dynamic::from(node.text()));
                            }
                        } else {
                            // // 表示所有元素
                            for node in document.find(select::predicate::Any) {
                                results.push(Dynamic::from(node.text()));
                            }
                        }
                    }
                } else if selector.starts_with("/") {
                    // /tag 格式：从根节点查找
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("/").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                results.push(Dynamic::from(node.text()));
                            }
                        }
                    }
                } else {
                    // 其他 XPath 格式，尝试作为标签名处理
                    for node in document.find(select::predicate::Name(selector)) {
                        results.push(Dynamic::from(node.text()));
                    }
                }
            } else {
                // 使用 CSS 选择器
                let document = Html::parse_document(&html);
                let css_selector = Selector::parse(selector)
                    .map_err(|e| format!("Invalid CSS selector: {}", e))?;

                for element in document.select(&css_selector) {
                    let text = element.text().collect::<String>();
                    results.push(Dynamic::from(text));
                }
            }

            Ok(results)
        }
    });

    // query_by_text(text) - 通过文本内容查找包含该文本的元素，返回元素的文本和属性
    // 直接返回数组，出错时返回空数组
    engine.register_fn("query_by_text", {
        let task_id_holder = Arc::clone(&task_id);
        move |text: &str| -> rhai::Array {
            let stack = match get_page_stack(&task_id_holder) {
                Ok(s) => s,
                Err(_) => return rhai::Array::new(),
            };
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some(entry) => entry.html.clone(),
                    None => return rhai::Array::new(),
                },
                Err(_) => return rhai::Array::new(),
            };

            let mut results = rhai::Array::new();
            let document = Html::parse_document(&html);

            // 使用通用选择器查找所有元素
            let all_selector = match Selector::parse("*") {
                Ok(sel) => sel,
                Err(_) => return rhai::Array::new(),
            };

            for element in document.select(&all_selector) {
                // 获取元素的文本内容（只包含直接文本，不包括子元素）
                let element_text: String = element.text().collect();

                // 检查是否包含目标文本
                if element_text.contains(text) {
                    // 创建一个 Map 来存储元素信息
                    let mut element_info = Map::new();
                    element_info.insert("text".into(), Dynamic::from(element_text.clone()));

                    // 获取元素的标签名
                    let tag_name = element.value().name();
                    element_info.insert("tag".into(), Dynamic::from(tag_name.to_string()));

                    // 获取元素的所有属性
                    let mut attrs = Map::new();
                    for (attr_name, attr_value) in element.value().attrs() {
                        attrs.insert(
                            attr_name.to_string().into(),
                            Dynamic::from(attr_value.to_string()),
                        );
                    }
                    element_info.insert("attrs".into(), Dynamic::from(attrs));

                    // 尝试获取元素的 ID 或 class（如果存在）
                    if let Some(id) = element.value().attr("id") {
                        element_info.insert("id".into(), Dynamic::from(id.to_string()));
                    }
                    if let Some(class) = element.value().attr("class") {
                        element_info.insert("class".into(), Dynamic::from(class.to_string()));
                    }

                    results.push(Dynamic::from(element_info));
                }
            }

            results
        }
    });

    // find_by_text(text, tag) - 在指定标签中查找包含该文本的元素，返回元素的文本
    engine.register_fn("find_by_text", {
        let task_id_holder = Arc::clone(&task_id);
        move |text: &str, tag: &str| -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            let stack = get_page_stack(&task_id_holder)?;
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|entry| entry.html.clone())
                    .ok_or_else(|| "Page stack is empty, call to(url) first".to_string())?
            };

            let mut results = rhai::Array::new();
            let document = Html::parse_document(&html);

            // 使用 CSS 选择器查找指定标签
            let selector_str = format!("{}", tag);
            let selector = Selector::parse(&selector_str)
                .map_err(|e| format!("Invalid tag selector: {}", e))?;

            for element in document.select(&selector) {
                let element_text: String = element.text().collect();
                if element_text.contains(text) {
                    results.push(Dynamic::from(element_text));
                }
            }

            Ok(results)
        }
    });

    // get_attr(selector, attr) - 在当前栈顶页面获取元素属性
    // 支持 CSS 选择器和 XPath（以 / 或 // 开头）
    // 直接返回数组，出错时返回空数组
    engine.register_fn("get_attr", {
        let task_id_holder = Arc::clone(&task_id);
        move |selector: &str, attr: &str| -> rhai::Array {
            let stack = match get_page_stack(&task_id_holder) {
                Ok(s) => s,
                Err(_) => return rhai::Array::new(),
            };
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some(entry) => entry.html.clone(),
                    None => return rhai::Array::new(),
                },
                Err(_) => return rhai::Array::new(),
            };

            let mut results = rhai::Array::new();

            // 判断是 XPath 还是 CSS 选择器
            let is_xpath = selector.starts_with("/")
                || selector.starts_with("//")
                || selector.contains("[@")
                || selector.contains("::");

            if is_xpath {
                // 使用 XPath（使用 select crate）
                let document = select::document::Document::from(html.as_str());

                // 简单的 XPath 实现
                if selector.starts_with("//") {
                    // //tag 格式：查找所有 tag 元素
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("//").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        } else {
                            // // 表示所有元素
                            for node in document.find(select::predicate::Any) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        }
                    }
                } else if selector.starts_with("/") {
                    // /tag 格式：从根节点查找
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("/").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        }
                    }
                } else {
                    // 其他 XPath 格式，尝试作为标签名处理
                    for node in document.find(select::predicate::Name(selector)) {
                        if let Some(value) = node.attr(attr) {
                            results.push(Dynamic::from(value.to_string()));
                        }
                    }
                }
            } else {
                // 使用 CSS 选择器
                let document = Html::parse_document(&html);
                if let Ok(css_selector) = Selector::parse(selector) {
                    for element in document.select(&css_selector) {
                        if let Some(value) = element.value().attr(attr) {
                            results.push(Dynamic::from(value.to_string()));
                        }
                    }
                }
            }

            results
        }
    });

    // resolve_url(relative) - 解析相对 URL 为绝对 URL（基于当前栈顶 URL）
    // 直接返回 String，出错时返回原始 URL
    engine.register_fn("resolve_url", {
        let task_id_holder = Arc::clone(&task_id);
        move |relative: &str| -> String {
            let stack = match get_page_stack(&task_id_holder) {
                Ok(s) => s,
                Err(_) => return relative.to_string(),
            };
            let base_url = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some(entry) => entry.url.clone(),
                    None => return relative.to_string(),
                },
                Err(_) => return relative.to_string(),
            };
            Url::parse(&base_url)
                .unwrap()
                .join(relative)
                .unwrap()
                .to_string()

            // resolve_url_against_base(&base_url, relative)
        }
    });

    // is_image_url(url) - 检查是否是图片 URL（与 image_type 一致）
    engine.register_fn("is_image_url", crate::image_type::url_has_image_extension);
    // is_video_url(url) - 检查是否是视频 URL（与 image_type 一致）
    engine.register_fn("is_video_url", crate::image_type::url_has_video_extension);
    // is_media_url(url) - 检查是否是图片或视频 URL
    engine.register_fn("is_media_url", crate::image_type::url_has_media_extension);

    // 辅助函数：递归扫描目录
    fn scan_directory_recursive(
        dir: &std::path::Path,
        extensions: &std::collections::HashSet<String>,
        file_list: &mut rhai::Array,
    ) -> Result<(), Box<rhai::EvalAltResult>> {
        let entries =
            std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() {
                // 检查文件扩展名
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_with_dot = format!(".{}", ext.to_lowercase());
                    if extensions.contains(&ext_with_dot) {
                        // 返回文件的完整路径（使用 file:// 协议）
                        let file_path_str = path.to_string_lossy().replace("\\", "/");
                        let file_url = format!("file:///{}", file_path_str);
                        file_list.push(Dynamic::from(file_url));
                    }
                }
            } else if path.is_dir() {
                // 递归处理子目录
                scan_directory_recursive(&path, extensions, file_list)?;
            }
        }

        Ok(())
    }

    // list_local_files(folder_url, extensions, recursive) - 列出本地文件夹内的文件
    // recursive 为可选参数，默认为 false（非递归）
    engine.register_fn(
        "list_local_files",
        |folder_url: &str,
         extensions: rhai::Array,
         recursive: bool|
         -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            // 解析文件夹路径
            let folder_path_str = if folder_url.starts_with("file:///") {
                &folder_url[8..]
            } else if folder_url.starts_with("file://") {
                &folder_url[7..]
            } else {
                folder_url
            };

            // 检查路径是否为空
            if folder_path_str.is_empty() {
                return Err(format!("Empty folder path. Original URL: {}", folder_url).into());
            }

            // 处理 Windows 路径分隔符
            // 先统一处理：将正斜杠替换为反斜杠（Windows 标准）
            // 如果路径中已经有反斜杠，它们会保持不变
            #[cfg(windows)]
            let folder_path_str = folder_path_str.replace("/", "\\");
            #[cfg(not(windows))]
            let folder_path_str = folder_path_str;

            let folder_path = std::path::PathBuf::from(&folder_path_str);

            // 检查文件夹是否存在
            if !folder_path.exists() {
                return Err(format!(
                    "Folder does not exist: {} (original URL: {}, parsed path: {})",
                    folder_path.display(),
                    folder_url,
                    folder_path_str
                )
                .into());
            }

            if !folder_path.is_dir() {
                return Err(format!("Path is not a directory: {}", folder_path.display()).into());
            }

            let mut file_list = rhai::Array::new();
            let extensions_set: std::collections::HashSet<String> = extensions
                .into_iter()
                .map(|ext| {
                    let ext_str = ext.to_string().to_lowercase();
                    // 确保扩展名包含点号
                    if ext_str.starts_with(".") {
                        ext_str
                    } else {
                        format!(".{}", ext_str)
                    }
                })
                .collect();

            // 递归或非递归扫描
            if recursive {
                scan_directory_recursive(&folder_path, &extensions_set, &mut file_list)?;
            } else {
                // 非递归扫描：只读取当前文件夹
                let entries = std::fs::read_dir(&folder_path)
                    .map_err(|e| format!("Failed to read directory: {}", e))?;

                for entry in entries {
                    let entry =
                        entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                    let path = entry.path();

                    // 只处理文件，不处理目录
                    if path.is_file() {
                        // 检查文件扩展名
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            let ext_with_dot = format!(".{}", ext.to_lowercase());
                            if extensions_set.contains(&ext_with_dot) {
                                // 返回文件的完整路径（使用 file:// 协议）
                                let file_path_str = path.to_string_lossy().replace("\\", "/");
                                let file_url = format!("file:///{}", file_path_str);
                                file_list.push(Dynamic::from(file_url));
                            }
                        }
                    }
                }
            }

            Ok(file_list)
        },
    );

    // add_progress(percentage) - 增加任务运行进度（单位为%，累加）
    let dq_handle = Arc::clone(&download_queue);
    let task_id_holder = Arc::clone(&task_id);
    let progress_holder = Arc::clone(&current_progress);
    engine.register_fn(
        "add_progress",
        move |percentage: f64| -> Result<(), Box<rhai::EvalAltResult>> {
            let task_id = {
                let guard = match task_id_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };
            let progress_guard = {
                let guard = match progress_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };

            // 若任务已被取消，直接让脚本失败退出
            if dq_handle.is_task_canceled_blocking(&task_id) {
                return Err("Task canceled".into());
            }

            // 累加进度值
            let mut current = progress_guard
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *current += percentage;

            // 限制最大值为 99.9%（100% 由任务完成时自动设置）
            if *current > 99.9 {
                *current = 99.9;
            }

            // 确保进度不为负数
            if *current < 0.0 {
                *current = 0.0;
            }

            let final_progress = *current;

            // 通过事件发送进度更新
            GlobalEmitter::global().emit_task_progress(&task_id, final_progress);

            Ok(())
        },
    );

    // download_image(url) / download_image(url, opts) — opts 为 map，可选键 name、metadata
    let dq_handle = Arc::clone(&download_queue);
    let images_dir_holder = Arc::clone(&images_dir);
    let plugin_id_holder = Arc::clone(&plugin_id);
    let task_id_holder = Arc::clone(&task_id);
    let output_album_id_holder = Arc::clone(&output_album_id);
    let http_headers_holder = Arc::clone(&http_headers);
    let dq1 = Arc::clone(&dq_handle);
    let idh1 = Arc::clone(&images_dir_holder);
    let pid1 = Arc::clone(&plugin_id_holder);
    let tid1 = Arc::clone(&task_id_holder);
    let oaid1 = Arc::clone(&output_album_id_holder);
    let hdr1 = Arc::clone(&http_headers_holder);
    engine.register_fn(
        "download_image",
        move |url: &str| -> Result<(), Box<rhai::EvalAltResult>> {
            let images_dir = lock_or_inner(&idh1).clone();
            let plugin_id = lock_or_inner(&pid1).clone();
            let task_id = lock_or_inner(&tid1).clone();
            let output_album_id = lock_or_inner(&oaid1).clone();
            let http_headers = lock_or_inner(&hdr1).clone();
            run_rhai_download_image_sync(
                &dq1,
                images_dir,
                plugin_id,
                task_id,
                output_album_id,
                http_headers,
                url,
                None,
                None,
                None,
            )
        },
    );
    let dq2 = Arc::clone(&dq_handle);
    let idh2 = Arc::clone(&images_dir_holder);
    let pid2 = Arc::clone(&plugin_id_holder);
    let tid2 = Arc::clone(&task_id_holder);
    let oaid2 = Arc::clone(&output_album_id_holder);
    let hdr2 = Arc::clone(&http_headers_holder);
    engine.register_fn(
        "download_image",
        move |url: &str, opts: Map| -> Result<(), Box<rhai::EvalAltResult>> {
            let images_dir = lock_or_inner(&idh2).clone();
            let plugin_id = lock_or_inner(&pid2).clone();
            let task_id = lock_or_inner(&tid2).clone();
            let output_album_id = lock_or_inner(&oaid2).clone();
            let http_headers = lock_or_inner(&hdr2).clone();
            let (custom_name, metadata, metadata_id) = parse_download_image_opts_from_map(&opts)?;
            run_rhai_download_image_sync(
                &dq2,
                images_dir,
                plugin_id,
                task_id,
                output_album_id,
                http_headers,
                url,
                custom_name,
                metadata,
                metadata_id,
            )
        },
    );

    engine.register_fn(
        "create_image_metadata",
        |m: Map| -> Result<i64, Box<rhai::EvalAltResult>> {
            let mut obj = JsonMap::new();
            for (k, v) in m {
                obj.insert(k.to_string(), rhai_dynamic_to_json_value(&v)?);
            }
            let val = JsonValue::Object(obj);
            Storage::global()
                .insert_or_get_image_metadata_row(&val)
                .map_err(|e| e.to_string().into())
        },
    );

    // download_archive(url, type) - 导入压缩包（目前仅支持 zip）
    let dq_handle = Arc::clone(&download_queue);
    let images_dir_holder = Arc::clone(&images_dir);
    let plugin_id_holder = Arc::clone(&plugin_id);
    let task_id_holder = Arc::clone(&task_id);
    let output_album_id_holder = Arc::clone(&output_album_id);
    let http_headers_holder = Arc::clone(&http_headers);
    engine.register_fn(
        "download_archive",
        move |url: &str, archive_type: Dynamic| -> Result<(), Box<rhai::EvalAltResult>> {
            let archive_type_str = if archive_type.is_unit() {
                "none".to_string()
            } else if archive_type.is_string() {
                archive_type.into_string().unwrap()
            } else {
                return Err("archive_type must be a string or none".into());
            };

            let images_dir = {
                let guard = match images_dir_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };
            let plugin_id = {
                let guard = match plugin_id_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };
            let task_id_for_download = {
                let guard = match task_id_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };
            let output_album_id_for_download = {
                let guard = match output_album_id_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };
            let http_headers_for_download = {
                let guard = match http_headers_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                guard.clone()
            };

            // 如果任务已被取消，让脚本失败退出
            if dq_handle.is_task_canceled_blocking(&task_id_for_download) {
                return Err("Task canceled".into());
            }

            // 记录“导入开始时间”（用于 UI 排序）
            let download_start_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let parsed_url = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
            let fut = dq_handle.download_archive(
                parsed_url,
                &archive_type_str,
                images_dir,
                plugin_id,
                task_id_for_download,
                download_start_time,
                output_album_id_for_download,
                http_headers_for_download,
            );
            tokio::runtime::Handle::current()
                .block_on(fut)
                .map_err(|e| format!("Failed to download archive: {}", e).into())
        },
    );

    engine.register_fn("get_supported_archive_types", || -> Vec<Dynamic> {
        crate::archive::supported_types()
            .into_iter()
            .map(Into::into)
            .collect()
    });
}

/// 执行 Rhai 爬虫脚本
pub fn execute_crawler_script_with_runtime(
    runtime: &mut RhaiCrawlerRuntime,
    plugin: &Plugin,
    images_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    script_content: &str,
    merged_config: HashMap<String, serde_json::Value>,
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
    http_headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    // task worker 复用 runtime：这里仅重置 task 上下文（stack/progress/ids/dir）
    runtime.reset_for_task(
        images_dir.to_path_buf(),
        plugin_id.to_string(),
        task_id.to_string(),
        output_album_id,
        http_headers.unwrap_or_default(),
    );
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &format!("开始执行脚本（pluginId={plugin_id}, taskId={task_id}）"),
    );

    // 创建作用域
    let mut scope = Scope::new();

    // 注入插件级变量：base_url（来自 config.json 的 baseUrl）
    // 规则：
    // - 仅当插件提供了 baseUrl（非空）时注入
    // - 不覆盖用户/变量系统已提供的同名 base_url（merged_config 中存在则跳过）
    let plugin_base_url = plugin.base_url.trim();
    if !plugin_base_url.is_empty() && !merged_config.contains_key("base_url") {
        scope.push_constant("base_url", plugin_base_url.to_string());
    }

    // 注入变量到脚本作用域：
    // Rhai 的函数体默认不能捕获/读取 Scope 里的"普通变量"，但可以读取常量。
    // 因此这里统一用 push_constant，避免脚本在 fn 内访问不到 start_page/max_pages 等变量。
    for (key, value) in merged_config {
        // 根据值的类型转换为 Rhai 类型
        match value {
            serde_json::Value::Number(n) => {
                if n.is_i64() {
                    scope.push_constant(key.clone(), n.as_i64().unwrap_or(0));
                } else if n.is_u64() {
                    scope.push_constant(key.clone(), n.as_u64().unwrap_or(0) as i64);
                } else if n.is_f64() {
                    scope.push_constant(key.clone(), n.as_f64().unwrap_or(0.0));
                }
            }
            serde_json::Value::String(s) => {
                scope.push_constant(key.clone(), s);
            }
            serde_json::Value::Bool(b) => {
                scope.push_constant(key.clone(), b);
            }
            serde_json::Value::Object(_) => {
                // 将 JSON 对象转换为 Rhai Map（支持脚本中使用 foo.a/foo.b）
                let mut map = Map::new();
                convert_json_to_rhai_map(&value, &mut map);
                scope.push_constant(key.clone(), map);
            }
            serde_json::Value::Array(arr) => {
                // 将数组转换为 Rhai 数组
                let mut rhai_array = rhai::Array::new();
                for item in arr {
                    match item {
                        serde_json::Value::String(s) => {
                            rhai_array.push(Dynamic::from(s));
                        }
                        serde_json::Value::Number(n) => {
                            if n.is_i64() {
                                rhai_array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                            } else if n.is_u64() {
                                rhai_array.push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                            } else if n.is_f64() {
                                rhai_array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                            }
                        }
                        serde_json::Value::Bool(b) => {
                            rhai_array.push(Dynamic::from(b));
                        }
                        _ => {
                            rhai_array.push(Dynamic::from(item.to_string()));
                        }
                    }
                }
                scope.push_constant(key.clone(), rhai_array);
            }
            serde_json::Value::Null => {
                // 跳过 null 值，不注入到 scope（避免脚本读到 () 类型导致函数调用失败）
                // 脚本可以通过 try-catch 检测变量是否存在
            }
        }
    }

    // 执行脚本
    // 脚本通过 download_image() 函数将图片添加到下载队列
    // 不需要脚本返回 URL 数组，因为下载是同步的
    runtime
        .engine
        .eval_with_scope(&mut scope, &script_content)
        .map_err(|e| {
            let pos = e.position();
            let (line, col) = (pos.line().unwrap_or(0), pos.position().unwrap_or(0));
            if line > 0 && col > 0 {
                eprintln!("Script execution error at {}:{}: {}", line, col, e);
                let msg = format!("Script execution error at {}:{}: {}", line, col, e);
                GlobalEmitter::global().emit_task_log(task_id, "error", &msg);
                msg
            } else {
                eprintln!("Script execution error: {}", e);
                let msg = format!("Script execution error: {}", e);
                GlobalEmitter::global().emit_task_log(task_id, "error", &msg);
                msg
            }
        })?;

    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        "脚本执行完成：图片应已通过 download_image() 入队",
    );
    Ok(())
}

/// 执行 Rhai 爬虫脚本（兼容旧调用：每次调用创建独立 runtime）
pub fn execute_crawler_script(
    _plugin: &Plugin,
    images_dir: &Path,
    download_queue: Arc<crate::crawler::DownloadQueue>,
    plugin_id: &str,
    task_id: &str,
    script_content: &str,
    merged_config: HashMap<String, serde_json::Value>,
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
) -> Result<(), String> {
    let mut runtime = RhaiCrawlerRuntime::new(download_queue);
    execute_crawler_script_with_runtime(
        &mut runtime,
        _plugin,
        images_dir,
        plugin_id,
        task_id,
        script_content,
        merged_config,
        output_album_id,
        None,
    )
}

/// 将 serde_json::Value 转换为 rhai::Map
fn convert_json_to_rhai_map(json: &serde_json::Value, map: &mut Map) {
    match json {
        serde_json::Value::Object(obj) => {
            for (key, value) in obj {
                match value {
                    serde_json::Value::String(s) => {
                        map.insert(key.clone().into(), Dynamic::from(s.clone()));
                    }
                    serde_json::Value::Number(n) => {
                        if n.is_i64() {
                            map.insert(key.clone().into(), Dynamic::from(n.as_i64().unwrap_or(0)));
                        } else if n.is_u64() {
                            map.insert(
                                key.clone().into(),
                                Dynamic::from(n.as_u64().unwrap_or(0) as i64),
                            );
                        } else if n.is_f64() {
                            map.insert(
                                key.clone().into(),
                                Dynamic::from(n.as_f64().unwrap_or(0.0)),
                            );
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        map.insert(key.clone().into(), Dynamic::from(*b));
                    }
                    serde_json::Value::Array(arr) => {
                        let mut rhai_array = rhai::Array::new();
                        for item in arr {
                            match item {
                                serde_json::Value::String(s) => {
                                    rhai_array.push(Dynamic::from(s.clone()));
                                }
                                serde_json::Value::Number(n) => {
                                    if n.is_i64() {
                                        rhai_array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                                    } else if n.is_u64() {
                                        rhai_array
                                            .push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                                    } else if n.is_f64() {
                                        rhai_array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                                    }
                                }
                                serde_json::Value::Bool(b) => {
                                    rhai_array.push(Dynamic::from(*b));
                                }
                                serde_json::Value::Object(_) => {
                                    let mut nested_map = Map::new();
                                    convert_json_to_rhai_map(item, &mut nested_map);
                                    rhai_array.push(Dynamic::from(nested_map));
                                }
                                serde_json::Value::Array(_) => {
                                    let mut nested_array = rhai::Array::new();
                                    convert_json_to_rhai_array(item, &mut nested_array);
                                    rhai_array.push(Dynamic::from(nested_array));
                                }
                                serde_json::Value::Null => {
                                    rhai_array.push(Dynamic::UNIT);
                                }
                            }
                        }
                        map.insert(key.clone().into(), Dynamic::from(rhai_array));
                    }
                    serde_json::Value::Object(_) => {
                        let mut nested_map = Map::new();
                        convert_json_to_rhai_map(value, &mut nested_map);
                        map.insert(key.clone().into(), Dynamic::from(nested_map));
                    }
                    serde_json::Value::Null => {
                        map.insert(key.clone().into(), Dynamic::UNIT);
                    }
                }
            }
        }
        _ => {}
    }
}

/// 将 serde_json::Value 数组转换为 rhai::Array
fn convert_json_to_rhai_array(json: &serde_json::Value, array: &mut rhai::Array) {
    if let serde_json::Value::Array(arr) = json {
        for item in arr {
            match item {
                serde_json::Value::String(s) => {
                    array.push(Dynamic::from(s.clone()));
                }
                serde_json::Value::Number(n) => {
                    if n.is_i64() {
                        array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                    } else if n.is_u64() {
                        array.push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                    } else if n.is_f64() {
                        array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                    }
                }
                serde_json::Value::Bool(b) => {
                    array.push(Dynamic::from(*b));
                }
                serde_json::Value::Object(_) => {
                    let mut nested_map = Map::new();
                    convert_json_to_rhai_map(item, &mut nested_map);
                    array.push(Dynamic::from(nested_map));
                }
                serde_json::Value::Array(_) => {
                    let mut nested_array = rhai::Array::new();
                    convert_json_to_rhai_array(item, &mut nested_array);
                    array.push(Dynamic::from(nested_array));
                }
                serde_json::Value::Null => {
                    array.push(Dynamic::UNIT);
                }
            }
        }
    }
}
