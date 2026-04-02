#[cfg(not(target_os = "android"))]
use std::{path::Path, str::FromStr, sync::OnceLock};

#[cfg(not(target_os = "android"))]
use axum::{
    body::Body,
    extract::Query,
    http::{
        header::{
            HeaderValue, ACCEPT_RANGES, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, RANGE,
        },
        Request, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(all(not(target_os = "android"), debug_assertions))]
use axum::{body::Bytes, extract::DefaultBodyLimit, http::Method, routing::post};
#[cfg(all(not(target_os = "android"), debug_assertions))]
use tower_http::cors::{Any, CorsLayer};
#[cfg(not(target_os = "android"))]
use tokio::io::{AsyncReadExt, AsyncSeekExt};
#[cfg(not(target_os = "android"))]
use tokio::io::SeekFrom;
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower::ServiceExt;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower_http::services::ServeDir;

#[cfg(not(target_os = "android"))]
pub static HTTP_SERVER_PORT: OnceLock<u16> = OnceLock::new();

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
struct ProxyQuery {
    url: String,
}

/// 插件文档图片：?pluginId=xxx&path=yyy（path 为 doc_root 内相对路径，如 screenshot.png）
#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
struct PluginDocImageQuery {
    plugin_id: String,
    path: String,
}

#[cfg(not(target_os = "android"))]
fn is_allowed_media_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    kabegame_core::image_type::is_supported_media_ext(ext)
}

#[cfg(not(target_os = "android"))]
fn mime_for_doc_image_path(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    kabegame_core::image_type::mime_by_ext()
        .get(&ext)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn build_serve_dir_request(path: &str) -> Option<Request<Body>> {
    let uri = Uri::from_str(path).ok()?;
    Request::builder().uri(uri).body(Body::empty()).ok()
}

#[cfg(not(target_os = "android"))]
fn mime_from_path(path: &str) -> Option<String> {
    if let Some(m) = kabegame_core::image_type::mime_type_from_path(Path::new(path)) {
        return Some(m);
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(kabegame_core::image_type::default_image_extension())
        .trim_start_matches('.')
        .to_ascii_lowercase();
    kabegame_core::image_type::mime_by_ext().get(&ext).cloned()
}

#[cfg(not(target_os = "android"))]
fn set_content_type_if_present(resp: &mut Response, mime_type: Option<&str>) {
    let Some(mime_type) = mime_type else { return };
    if let Ok(v) = HeaderValue::from_str(mime_type) {
        resp.headers_mut().insert(CONTENT_TYPE, v);
    }
}

#[cfg(not(target_os = "android"))]
async fn handle_file_query(Query(query): Query<FileQuery>, headers: axum::http::HeaderMap) -> Response {
    let path = query.path.trim();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }
    if !is_allowed_media_ext(path) {
        return (StatusCode::FORBIDDEN, "file extension not allowed").into_response();
    }

    // 先检查本地文件是否存在，找不到则不查表直接 404
    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    // 表中无此 local_path 则 404
    match kabegame_core::storage::Storage::global().find_image_by_path(path) {
        Ok(Some(_)) => {}
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    }

    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    serve_file_with_mime(path, mime_from_path(path), range).await
}

#[cfg(not(target_os = "android"))]
async fn handle_thumbnail_query(Query(query): Query<FileQuery>, headers: axum::http::HeaderMap) -> Response {
    let path = query.path.trim();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }
    if !is_allowed_media_ext(path) {
        return (StatusCode::FORBIDDEN, "file extension not allowed").into_response();
    }

    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    match kabegame_core::storage::Storage::global().find_image_by_thumbnail_path(path) {
        Ok(Some(_)) => {}
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    }

    // 缩略图 MIME 优先根据缩略图文件路径推断（缩略图可能是 jpg 而原始文件是 mp4）
    let thumb_mime = kabegame_core::image_type::mime_type_from_path(Path::new(path))
        .or_else(|| mime_from_path(path));

    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    serve_file_with_mime(path, thumb_mime, range).await
}

#[cfg(not(target_os = "android"))]
async fn serve_file_with_mime(path: &str, mime_type: Option<String>, range_header: Option<String>) -> Response {
    // 优先尝试 ServeDir（桌面统一走 HTTP 文件服务）
    #[cfg(not(target_os = "windows"))]
    {
        if path.starts_with('/') {
            if let Some(req) = build_serve_dir_request(path) {
                let service = ServeDir::new("/");
                if let Ok(resp) = service.oneshot(req).await {
                    if resp.status().is_success() {
                        let mut out = resp.into_response();
                        set_content_type_if_present(&mut out, mime_type.as_deref());
                        return out;
                    }
                }
            }
        }
    }

    if let Some(range_header) = range_header {
        match tokio::fs::metadata(path).await {
            Ok(meta) => {
                let file_size = meta.len();
                if file_size == 0 {
                    let mut out = (StatusCode::OK, Vec::<u8>::new()).into_response();
                    out.headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    set_content_type_if_present(&mut out, mime_type.as_deref());
                    return out;
                }
                if let Some(range_part) = range_header.strip_prefix("bytes=") {
                    let mut split = range_part.splitn(2, '-');
                    let start_str = split.next().unwrap_or("").trim();
                    let end_str = split.next().unwrap_or("").trim();
                    let start = start_str.parse::<u64>().ok();
                    let end = if end_str.is_empty() {
                        None
                    } else {
                        end_str.parse::<u64>().ok()
                    };
                    if let Some(start) = start {
                        let end = end.unwrap_or(file_size.saturating_sub(1));
                        if start <= end && end < file_size {
                            let chunk_len = (end - start + 1) as usize;
                            let mut file = match tokio::fs::File::open(path).await {
                                Ok(f) => f,
                                Err(_) => {
                                    return (StatusCode::NOT_FOUND, "file not found").into_response()
                                }
                            };
                            if file.seek(SeekFrom::Start(start)).await.is_err() {
                                return (StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                                    .into_response();
                            }
                            let mut buf = vec![0u8; chunk_len];
                            if file.read_exact(&mut buf).await.is_err() {
                                return (StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                                    .into_response();
                            }
                            let mut out = (StatusCode::PARTIAL_CONTENT, buf).into_response();
                            if let Ok(v) = HeaderValue::from_str(&format!(
                                "bytes {}-{}/{}",
                                start, end, file_size
                            )) {
                                out.headers_mut().insert(CONTENT_RANGE, v);
                            }
                            if let Ok(v) = HeaderValue::from_str(&(end - start + 1).to_string()) {
                                out.headers_mut().insert(CONTENT_LENGTH, v);
                            }
                            out.headers_mut()
                                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                            set_content_type_if_present(&mut out, mime_type.as_deref());
                            return out;
                        }
                    }
                }
                let mut out =
                    (StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable").into_response();
                if let Ok(v) = HeaderValue::from_str(&format!("bytes */{}", file_size)) {
                    out.headers_mut().insert(CONTENT_RANGE, v);
                }
                return out;
            }
            Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
        }
    }

    // ServeDir 不可用/失败时回落到直接读文件
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mut out = (StatusCode::OK, bytes).into_response();
            out.headers_mut()
                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            set_content_type_if_present(&mut out, mime_type.as_deref());
            out
        }
        Err(_) => (StatusCode::NOT_FOUND, "file not found").into_response(),
    }
}

/// 代理 GET 请求：/proxy?url=xxx，用 reqwest 拉取目标 URL 后流式返回（初步实现，无任务上下文）
#[cfg(not(target_os = "android"))]
async fn handle_proxy_query(Query(query): Query<ProxyQuery>) -> Response {
    let url = query.url.trim();
    if url.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing url").into_response();
    }
    let Ok(target_uri) = url.parse::<Uri>() else {
        return (StatusCode::BAD_REQUEST, "invalid url").into_response();
    };
    let scheme = target_uri.scheme_str().unwrap_or("");
    if scheme != "http" && scheme != "https" {
        return (StatusCode::BAD_REQUEST, "only http and https are allowed").into_response();
    }

    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::default());
    if let Some(ref proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            client_builder = client_builder.proxy(proxy);
        }
    }
    let client = match client_builder.build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("proxy client build failed: {e}"),
            )
                .into_response();
        }
    };

    let upstream = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            let code = e
                .status()
                .map(|s| s.as_u16())
                .and_then(|u| StatusCode::from_u16(u).ok())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            return (code, e.to_string()).into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response_builder = Response::builder().status(status);

    // 复制部分响应头（按字符串从 reqwest 取，避免 http 版本不一致）
    let pass_header_names = ["content-type", "content-length", "content-encoding"];
    if let Some(headers_mut) = response_builder.headers_mut() {
        for name in pass_header_names {
            if let Some(v) = upstream.headers().get(name) {
                if let (Ok(hn), Ok(hv)) = (
                    axum::http::header::HeaderName::try_from(name),
                    HeaderValue::try_from(v.as_bytes()),
                ) {
                    headers_mut.insert(hn, hv);
                }
            }
        }
    }

    response_builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "body build failed").into_response()
        })
}

/// 插件文档图片：从已安装插件的 .kgpg 中读取 doc_root 下图片，供桌面端 HTTP 复用
#[cfg(not(target_os = "android"))]
async fn handle_plugin_doc_image(Query(query): Query<PluginDocImageQuery>) -> Response {
    let plugin_id = query.plugin_id.trim();
    let path = query.path.trim();
    if plugin_id.is_empty() || path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing plugin_id or path").into_response();
    }
    if !is_allowed_media_ext(path) {
        return (StatusCode::FORBIDDEN, "path extension not allowed").into_response();
    }

    let manager = kabegame_core::plugin::PluginManager::global();
    let bytes = match manager
        .load_plugin_image_for_detail(
            plugin_id,
            None,
            None,
            None,
            path,
            None,
            None,
        )
        .await
    {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "plugin or image not found").into_response(),
    };

    let mime = mime_for_doc_image_path(path);
    let mut out = (StatusCode::OK, bytes).into_response();
    out.headers_mut()
        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    set_content_type_if_present(&mut out, Some(&mime));
    out
}

#[cfg(not(target_os = "android"))]
async fn handle_unmatched(uri: Uri) -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

#[cfg(all(not(target_os = "android"), debug_assertions))]
const DEBUG_INGEST_MAX_BODY: usize = 256 * 1024;

/// 开发调试用：接受 NDJSON 单行或原文，追加到 `AppPaths::debug_ingest_log()`（与 Cursor/agent 埋点类似）。
#[cfg(all(not(target_os = "android"), debug_assertions))]
async fn handle_debug_ingest(body: Bytes) -> Response {
    use tokio::io::AsyncWriteExt;

    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty body").into_response();
    }
    if body.len() > DEBUG_INGEST_MAX_BODY {
        return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response();
    }

    let path = kabegame_core::app_paths::AppPaths::global().debug_ingest_log();
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let mut chunk = body.to_vec();
    if !chunk.ends_with(b"\n") {
        chunk.push(b'\n');
    }

    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
    {
        Ok(mut f) => {
            if let Err(e) = f.write_all(&chunk).await {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("write failed: {e}"),
                )
                    .into_response();
            }
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("open failed: {e}"),
            )
                .into_response();
        }
    }

    StatusCode::NO_CONTENT.into_response()
}

#[cfg(not(target_os = "android"))]
pub async fn start_http_server() -> Result<u16, String> {
    if let Some(port) = HTTP_SERVER_PORT.get() {
        return Ok(*port);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind file server failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read file server local addr failed: {e}"))?
        .port();

    let mut app = Router::new()
        .route("/file", get(handle_file_query))
        .route("/thumbnail", get(handle_thumbnail_query))
        .route("/plugin-doc-image", get(handle_plugin_doc_image))
        .route("/proxy", get(handle_proxy_query));

    #[cfg(debug_assertions)]
    {
        let debug_routes = Router::new()
            .route("/debug/ingest", post(handle_debug_ingest))
            .layer(DefaultBodyLimit::max(DEBUG_INGEST_MAX_BODY))
            .layer(
                CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods([Method::POST, Method::OPTIONS])
                    .allow_headers(Any),
            );
        app = app.merge(debug_routes);
        eprintln!(
            "[file-server] debug ingest POST http://127.0.0.1:{port}/debug/ingest → {}",
            kabegame_core::app_paths::AppPaths::global()
                .debug_ingest_log()
                .display()
        );
    }

    let app = app.fallback(handle_unmatched);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[file-server] stopped: {e}");
        }
    });

    let _ = HTTP_SERVER_PORT.set(port);
    Ok(port)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_http_server_base_url() -> Result<String, String> {
    for _ in 0..60 {
        if let Some(port) = HTTP_SERVER_PORT.get() {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("file server not ready".to_string())
}
