use crate::plugin::Plugin;
use crate::runtime::EventEmitter;
use rhai::{Dynamic, Engine, Map, Position, Scope};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use url::Url;

type Shared<T> = Arc<Mutex<T>>;

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

fn is_sensitive_var_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("token")
        || n.contains("cookie")
        || n.contains("auth")
        || n.contains("password")
        || n.contains("secret")
        || n.contains("apikey")
        || n.contains("api_key")
}

fn build_rhai_scope_dump_json(
    plugin_id: &str,
    task_id: &str,
    scope: &Scope,
    err: &rhai::EvalAltResult,
) -> serde_json::Value {
    // 注意：Scope 仅包含脚本中的“全局变量”（以及我们注入的常量）。
    // 函数内部的局部变量/临时值不会出现在这里。
    const MAX_VALUE_CHARS: usize = 4096;
    const MAX_VARS: usize = 256;

    let pos = err.position();
    let line = pos.line().unwrap_or(0);
    let col = pos.position().unwrap_or(0);

    let mut vars: Vec<serde_json::Value> = Vec::new();
    let mut total = 0usize;
    for (name, is_const, value) in scope.iter_raw() {
        total += 1;
        if vars.len() >= MAX_VARS {
            break;
        }

        let sensitive = is_sensitive_var_name(name);
        let raw_value = if sensitive {
            "<redacted>".to_string()
        } else {
            value.to_string()
        };
        let raw_len = raw_value.chars().count();
        let (value_out, truncated) = if raw_len > MAX_VALUE_CHARS {
            let mut s = raw_value.chars().take(MAX_VALUE_CHARS).collect::<String>();
            s.push_str(&format!(" ... (truncated, original_len={raw_len})"));
            (s, true)
        } else {
            (raw_value, false)
        };

        vars.push(serde_json::json!({
            "name": name,
            "typeId": format!("{:?}", value.type_id()),
            "isConstant": is_const,
            "isSensitive": sensitive,
            "value": value_out,
            "valueTruncated": truncated,
            "valueLen": raw_len,
        }));
    }

    serde_json::json!({
        "pluginId": plugin_id,
        "taskId": task_id,
        "error": err.to_string(),
        "position": {
            "line": line,
            "col": col,
        },
        "notes": "仅包含 Scope（全局变量/注入常量）。函数内部局部变量无法从 Scope 提取。",
        "vars": vars,
        "varsTotal": total,
        "varsCapped": total > vars.len(),
    })
}

fn try_write_rhai_scope_dump_file(
    images_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    dump_text: &str,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(images_dir)
        .map_err(|e| format!("Failed to create images_dir for dump: {e}"))?;

    let safe_task = safe_filename_component(task_id);
    let safe_plugin = safe_filename_component(plugin_id);
    let filename = format!("{safe_task}_{safe_plugin}.rhai-scope-dump.json");
    let path = images_dir.join(filename);

    std::fs::write(&path, dump_text).map_err(|e| format!("Failed to write dump file: {e}"))?;
    Ok(path)
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

fn get_network_retry_count(dq: &crate::crawler::DownloadQueue) -> u32 {
    dq.settings_arc()
        .get_settings()
        .ok()
        .map(|s| s.network_retry_count)
        .unwrap_or(0)
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

fn emit_http_warn(dq: &crate::crawler::DownloadQueue, task_id: &str, message: impl Into<String>) {
    let emitter = dq.emitter_arc();
    emitter.emit_task_log(task_id, "warn", &message.into());
}

fn emit_http_error(dq: &crate::crawler::DownloadQueue, task_id: &str, message: impl Into<String>) {
    let emitter = dq.emitter_arc();
    emitter.emit_task_log(task_id, "error", &message.into());
}

fn http_get_text_with_retry(
    dq: &crate::crawler::DownloadQueue,
    task_id: &str,
    url: &str,
    label: &str,
    headers: &HashMap<String, String>,
) -> Result<String, String> {
    let client = crate::crawler::create_blocking_client()?;
    let header_map = build_reqwest_header_map(dq, task_id, headers);
    let retry_count = get_network_retry_count(dq);
    let max_attempts = retry_count.saturating_add(1).max(1);

    for attempt in 1..=max_attempts {
        // 若任务已被取消，尽早退出（与 download_image 一致）
        if dq.is_task_canceled(task_id) {
            return Err("Task canceled".to_string());
        }

        let mut req = client.get(url);
        if !header_map.is_empty() {
            req = req.headers(header_map.clone());
        }
        let response = match req.send() {
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
                return Err(format!("Failed to fetch: {e}"));
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
                        "[{label}] HTTP {status}，将于 {backoff_ms}ms 后重试 ({attempt}/{max_attempts})，URL: {url}"
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                continue;
            }
            let msg = format!("[{label}] HTTP 错误：{status}");
            eprintln!("{msg} URL: {url}");
            emit_http_error(dq, task_id, format!("{msg}，URL: {url}"));
            return Err(format!("HTTP error: {status}"));
        }

        match response.text() {
            Ok(text) => return Ok(text),
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
                eprintln!("{msg} URL: {url}");
                emit_http_error(dq, task_id, format!("{msg}，URL: {url}"));
                return Err(format!("Failed to fetch: {e}"));
            }
        }
    }

    Err("Unreachable".to_string())
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
    emitter: Arc<dyn EventEmitter>,
    page_stack: Shared<Arc<Mutex<Vec<(String, String)>>>>,
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
        let emitter = download_queue.emitter_arc();
        let page_stack: Shared<Arc<Mutex<Vec<(String, String)>>>> =
            Arc::new(Mutex::new(Arc::new(Mutex::new(Vec::new()))));
        let images_dir: Shared<PathBuf> = Arc::new(Mutex::new(PathBuf::new()));
        let plugin_id: Shared<String> = Arc::new(Mutex::new(String::new()));
        let task_id: Shared<String> = Arc::new(Mutex::new(String::new()));
        let current_progress: Shared<Arc<Mutex<f64>>> =
            Arc::new(Mutex::new(Arc::new(Mutex::new(0.0))));
        let output_album_id: Shared<Option<String>> = Arc::new(Mutex::new(None));
        let http_headers: Shared<HashMap<String, String>> = Arc::new(Mutex::new(HashMap::new()));

        // 将 Rhai 的 print/debug 输出重定向为 task-log 事件，供前端实时展示
        {
            let emitter_for_print = Arc::clone(&emitter);
            let task_id_for_print = Arc::clone(&task_id);
            engine.on_print(move |s: &str| {
                let tid = match task_id_for_print.lock() {
                    Ok(g) => g.clone(),
                    Err(e) => e.into_inner().clone(),
                };
                emitter_for_print.emit_task_log(&tid, "print", s);
            });
        }
        {
            let emitter_for_debug = Arc::clone(&emitter);
            let task_id_for_debug = Arc::clone(&task_id);
            engine.on_debug(move |s: &str, src: Option<&str>, pos: Position| {
                let tid = match task_id_for_debug.lock() {
                    Ok(g) => g.clone(),
                    Err(e) => e.into_inner().clone(),
                };
                let src = src.unwrap_or("unknown");
                emitter_for_debug.emit_task_log(&tid, "debug", &format!("{src} @ {pos:?} > {s}"));
            });
        }

        register_crawler_functions(
            &mut engine,
            Arc::clone(&page_stack),
            Arc::clone(&images_dir),
            Arc::clone(&download_queue),
            Arc::clone(&plugin_id),
            Arc::clone(&task_id),
            Arc::clone(&current_progress),
            Arc::clone(&output_album_id),
            Arc::clone(&http_headers),
        );

        Self {
            engine,
            download_queue,
            emitter,
            page_stack,
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
        // 每个任务都重置 page_stack 和 progress，避免跨任务污染
        {
            let mut guard = match self.page_stack.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            *guard = Arc::new(Mutex::new(Vec::new()));
        }
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
    page_stack: Shared<Arc<Mutex<Vec<(String, String)>>>>,
    images_dir: Shared<PathBuf>,
    download_queue: Arc<crate::crawler::DownloadQueue>,
    plugin_id: Shared<String>,
    task_id: Shared<String>,
    current_progress: Shared<Arc<Mutex<f64>>>,
    output_album_id: Shared<Option<String>>,
    http_headers: Shared<HashMap<String, String>>,
) {
    let stack_holder = Arc::clone(&page_stack);

    // re_is_match(pattern, text) - 正则匹配判断（pattern 使用 Rust regex 语法）
    // 注意：pattern 编译失败时返回 false
    engine.register_fn("re_is_match", |pattern: &str, text: &str| -> bool {
        regex::Regex::new(pattern)
            .map(|re| re.is_match(text))
            .unwrap_or(false)
    });

    // to(url) - 访问一个网页，将当前页面入栈
    engine.register_fn("to", {
        let stack_holder = Arc::clone(&stack_holder);
        let dq_holder = Arc::clone(&download_queue);
        let task_id_holder = Arc::clone(&task_id);
        let headers_holder = Arc::clone(&http_headers);
        // 注意：返回 Result<T, Box<EvalAltResult>> 时，脚本侧拿到的是 T（失败会直接抛出运行时错误）
        // 这样 print(to(...)) / print(current_html()) 不会出现 "Result<...>" 字样。
        move |url: &str| -> Result<(), Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = lock_or_inner(&stack_holder);
                Arc::clone(&*guard)
            };
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(url, _)| url.clone())
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
            // 在单独的线程中执行阻塞的 HTTP 请求，避免在 Tokio runtime 中创建新的 runtime
            // 并增加失败重试 + 日志输出（风格与 download_image 一致：可取消、指数退避、最终失败 eprintln）
            let url_clone = resolved_url.clone();
            let dq_for_http = Arc::clone(&dq_holder);
            let task_id_for_http = get_task_id(&task_id_holder);
            let headers_for_http = {
                let guard = lock_or_inner(&headers_holder);
                guard.clone()
            };
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result =
                    http_get_text_with_retry(&dq_for_http, &task_id_for_http, &url_clone, "to", &headers_for_http);
                let _ = tx.send(result);
            });
            let html = rx
                .recv()
                .map_err(|e| format!("Thread communication error: {}", e))?
                .map_err(|e| e)?;

            // 将当前页面推入栈（如果栈不为空，先保存当前页面）
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard.push((resolved_url, html));
            Ok(())
        }
    });

    // to_json(url) - 访问一个 JSON API，返回 JSON 对象
    engine.register_fn("to_json", {
        let stack_holder = Arc::clone(&stack_holder);
        let dq_holder = Arc::clone(&download_queue);
        let task_id_holder = Arc::clone(&task_id);
        let headers_holder = Arc::clone(&http_headers);
        move |url: &str| -> Result<Map, Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = lock_or_inner(&stack_holder);
                Arc::clone(&*guard)
            };
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(url, _)| url.clone())
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

            // 获取 JSON 响应
            // 在单独的线程中执行阻塞的 HTTP 请求，避免在 Tokio runtime 中创建新的 runtime
            // 并增加失败重试 + 日志输出（风格与 download_image 一致）
            let url_clone = resolved_url.clone();
            let dq_for_http = Arc::clone(&dq_holder);
            let task_id_for_http = get_task_id(&task_id_holder);
            let task_id_for_http_thread = task_id_for_http.clone();
            let headers_for_http = {
                let guard = lock_or_inner(&headers_holder);
                guard.clone()
            };
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = http_get_text_with_retry(
                    &dq_for_http,
                    &task_id_for_http_thread,
                    &url_clone,
                    "to_json",
                    &headers_for_http,
                );
                let _ = tx.send(result);
            });
            let text = rx
                .recv()
                .map_err(|e| format!("Thread communication error: {}", e))?
                .map_err(|e| e)?;
            let json_value = serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
                let msg = format!("[to_json] JSON 解析失败：{e}");
                eprintln!("{msg} URL: {resolved_url}");
                emit_http_error(
                    &dq_holder,
                    &task_id_for_http,
                    format!("{msg}，URL: {resolved_url}"),
                );
                format!("Failed to parse JSON: {}", e)
            })?;

            // 将当前页面推入栈（保存 URL 和 JSON 字符串表示）
            let json_string = serde_json::to_string(&json_value)
                .map_err(|e| format!("Failed to serialize JSON: {}", e))?;
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard.push((resolved_url, json_string));

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

    // back() - 返回上一页，出栈
    engine.register_fn("back", {
        let stack_holder = Arc::clone(&stack_holder);
        move || -> Result<(), Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
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
        let stack_holder = Arc::clone(&stack_holder);
        move || -> Result<String, Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|(url, _)| url.clone())
                .ok_or_else(|| "Page stack is empty".into())
        }
    });

    // current_html() - 获取当前栈顶的 HTML
    engine.register_fn("current_html", {
        let stack_holder = Arc::clone(&stack_holder);
        move || -> Result<String, Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|(_, html)| html.clone())
                .ok_or_else(|| "Page stack is empty".into())
        }
    });

    // query(selector) - 在当前栈顶页面查询元素文本
    // 支持 CSS 选择器和 XPath（以 / 或 // 开头）
    engine.register_fn("query", {
        let stack_holder = Arc::clone(&stack_holder);
        move |selector: &str| -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(_, html)| html.clone())
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
        let stack_holder = Arc::clone(&stack_holder);
        move |text: &str| -> rhai::Array {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((_, html)) => html.clone(),
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
        let stack_holder = Arc::clone(&stack_holder);
        move |text: &str, tag: &str| -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(_, html)| html.clone())
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
        let stack_holder = Arc::clone(&stack_holder);
        move |selector: &str, attr: &str| -> rhai::Array {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((_, html)) => html.clone(),
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
        let stack_holder = Arc::clone(&stack_holder);
        move |relative: &str| -> String {
            let stack = {
                let guard = match stack_holder.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                Arc::clone(&*guard)
            };
            let base_url = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((url, _)) => url.clone(),
                    None => return relative.to_string(),
                },
                Err(_) => return relative.to_string(),
            };

            match Url::parse(&base_url) {
                Ok(base) => match base.join(relative) {
                    Ok(resolved) => resolved.to_string(),
                    Err(_) => relative.to_string(),
                },
                Err(_) => relative.to_string(),
            }
        }
    });

    // is_image_url(url) - 检查是否是图片 URL
    engine.register_fn("is_image_url", |url: &str| -> bool {
        let url_lower = url.to_lowercase();
        url_lower.ends_with(".jpg")
            || url_lower.ends_with(".jpeg")
            || url_lower.ends_with(".png")
            || url_lower.ends_with(".gif")
            || url_lower.ends_with(".webp")
    });

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
            if dq_handle.is_task_canceled(&task_id) {
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
            dq_handle.emitter_arc().emit_task_progress(&task_id, final_progress);

            Ok(())
        },
    );

    // download_image(url) - 同步下载图片并添加到 gallery（等待窗口有空位后直接执行）
    let dq_handle = Arc::clone(&download_queue);
    let images_dir_holder = Arc::clone(&images_dir);
    let plugin_id_holder = Arc::clone(&plugin_id);
    let task_id_holder = Arc::clone(&task_id);
    let output_album_id_holder = Arc::clone(&output_album_id);
    let http_headers_holder = Arc::clone(&http_headers);
    engine.register_fn(
        "download_image",
        move |url: &str| -> Result<(), Box<rhai::EvalAltResult>> {
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
            if dq_handle.is_task_canceled(&task_id_for_download) {
                return Err("Task canceled".into());
            }

            let images_dir = images_dir.clone();
            let plugin_id = plugin_id.clone();
            let task_id = task_id_for_download.clone();

            // 注意：不在 Rhai 层做“按本地路径已存在就跳过”的短路。
            // 最终落盘/是否复制/是否复用（URL 仅网络、哈希适用本地+网络、以及“来源在输出目录内不复制”）
            // 统一由 downloader（crawler/mod.rs）按规则处理，避免出现“任务结束但 0 张”的隐式去重问题。

            // 检查任务图片数量限制（最多10000张）
            const MAX_TASK_IMAGES: usize = 10000;
            let storage = dq_handle.storage_arc();
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

            // 记录下载开始时间（使用毫秒以支持更精确的时间控制）
            let download_start_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            // 同步下载图片（等待窗口有空位后直接执行）
            dq_handle
                .download_image(
                    url.to_string(),
                    images_dir,
                    plugin_id,
                    task_id,
                    download_start_time,
                    output_album_id_for_download.clone(),
                    http_headers_for_download,
                )
                .map_err(|e| format!("Failed to download image: {}", e).into())
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
        move |url: &str, archive_type: &str| -> Result<(), Box<rhai::EvalAltResult>> {
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
            if dq_handle.is_task_canceled(&task_id_for_download) {
                return Err("Task canceled".into());
            }

            // 记录“导入开始时间”（用于 UI 排序）
            let download_start_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            dq_handle
                .download_archive(
                    url.to_string(),
                    archive_type,
                    images_dir,
                    plugin_id,
                    task_id_for_download,
                    download_start_time,
                    output_album_id_for_download.clone(),
                    http_headers_for_download,
                )
                .map_err(|e| format!("Failed to download archive: {}", e).into())
        },
    );
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
    runtime.emitter.emit_task_log(
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
            // 失败时输出一个 scope dump，便于定位脚本运行到哪一步/变量是否如预期。
            // 注意：只包含全局变量/注入常量；函数局部变量无法获取。
            let dump_text = build_rhai_scope_dump_json(plugin_id, task_id, &scope, e.as_ref());
            let dump_text = serde_json::to_string_pretty(&dump_text).ok();

            // 1) 保存到任务表（供 UI “确认”）
            if let Some(ref text) = dump_text {
                let storage = runtime.download_queue.storage_arc();
                if let Err(err) = storage.set_task_rhai_dump(task_id, text) {
                    runtime
                        .emitter
                        .emit_task_log(task_id, "warn", &format!("Rhai dump 保存到任务表失败：{err}"));
                }
            }

            // 2) 额外写一个文件（便于用户直接打开）
            let dump_path = match dump_text.as_deref() {
                Some(text) => {
                    match try_write_rhai_scope_dump_file(images_dir, plugin_id, task_id, text) {
                        Ok(p) => Some(p),
                        Err(dump_err) => {
                            let msg = format!("Rhai 脚本失败：生成变量 dump 文件失败：{dump_err}");
                            runtime.emitter.emit_task_log(task_id, "warn", &msg);
                            None
                        }
                    }
                }
                None => None,
            };

            // 尽可能把行列号带上，方便前端定位（某些错误的 Display 不包含 position）
            let pos = e.position();
            let (line, col) = (pos.line().unwrap_or(0), pos.position().unwrap_or(0));
            if line > 0 && col > 0 {
                eprintln!("Script execution error at {}:{}: {}", line, col, e);
                let mut msg = format!("Script execution error at {}:{}: {}", line, col, e);
                if let Some(p) = dump_path {
                    msg.push_str(&format!("\nScope dump: {}", p.display()));
                }
                runtime.emitter.emit_task_log(task_id, "error", &msg);
                msg
            } else {
                eprintln!("Script execution error: {}", e);
                let mut msg = format!("Script execution error: {}", e);
                if let Some(p) = dump_path {
                    msg.push_str(&format!("\nScope dump: {}", p.display()));
                }
                runtime.emitter.emit_task_log(task_id, "error", &msg);
                msg
            }
        })?;

    runtime.emitter.emit_task_log(
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
