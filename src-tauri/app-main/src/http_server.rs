#[cfg(not(target_os = "android"))]
use std::{
    path::Path,
    str::FromStr,
    sync::{Arc, OnceLock},
};

#[cfg(not(target_os = "android"))]
use axum::{
    body::Body,
    extract::Query,
    http::{
        header::{
            HeaderValue, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, RANGE,
        },
        Request, StatusCode, Uri,
    },
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(not(target_os = "android"))]
use tokio::sync::Semaphore;
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
#[cfg(not(target_os = "android"))]
use tokio::io::SeekFrom;
#[cfg(not(target_os = "android"))]
use tokio::io::{AsyncReadExt, AsyncSeekExt};
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower::ServiceExt;
#[cfg(all(not(target_os = "android"), debug_assertions))]
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

/// 本地文件按路径寻址、内容不变。浏览器命中磁盘缓存即可跳过一次 fs 读 + DB 查询。
#[cfg(not(target_os = "android"))]
fn apply_immutable_cache(resp: &mut Response) {
    resp.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
}

#[cfg(not(target_os = "android"))]
async fn handle_file_query(
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
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

    let image_info = match kabegame_core::storage::Storage::global().find_image_by_path(path) {
        Ok(Some(info)) => info,
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    let mime = image_info.media_type.or_else(|| mime_from_path(path));

    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    serve_file_with_mime(path, mime, range).await
}

#[cfg(not(target_os = "android"))]
async fn handle_thumbnail_query(
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
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
async fn serve_file_with_mime(
    path: &str,
    mime_type: Option<String>,
    range_header: Option<String>,
) -> Response {
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
                        apply_immutable_cache(&mut out);
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
                    apply_immutable_cache(&mut out);
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
                                    return (StatusCode::NOT_FOUND, "file not found")
                                        .into_response()
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
                            apply_immutable_cache(&mut out);
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
            apply_immutable_cache(&mut out);
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

    let mut client_builder =
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::default());
    if let Some(ref proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            client_builder = client_builder.proxy(proxy);
        }
    }
    let client = match client_builder.build() {
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

#[cfg(not(target_os = "android"))]
async fn handle_unmatched(uri: Uri) -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}


/// Returns a Router with file-serving routes usable by both local and web modes.
/// Does NOT include `/plugin-doc-image` (inlined as data URLs on the frontend).
#[cfg(not(target_os = "android"))]
pub fn file_routes() -> Router {
    Router::new()
        .route("/file", get(handle_file_query))
        .route("/thumbnail", get(handle_thumbnail_query))
        .route("/proxy", get(handle_proxy_query))
}

/// web 模式下同时能响应多少张图片的上限。超出的请求在信号量上排队等待。
#[cfg(not(target_os = "android"))]
const WEB_IMAGE_CONCURRENCY: usize = 10;

#[cfg(not(target_os = "android"))]
static WEB_IMAGE_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[cfg(not(target_os = "android"))]
fn web_image_semaphore() -> Arc<Semaphore> {
    WEB_IMAGE_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(WEB_IMAGE_CONCURRENCY)))
        .clone()
}

/// 给 /file 与 /thumbnail 套用的并发闸：最多 WEB_IMAGE_CONCURRENCY 个在飞，其余排队。
/// permit 在响应发出之前持有；一旦 handler 返回（Response 构造完成）就释放，不会等客户端读完 body。
#[cfg(not(target_os = "android"))]
async fn image_concurrency_mw(req: Request<Body>, next: Next) -> Response {
    let sem = web_image_semaphore();
    // Semaphore 从不 close，acquire_owned 不会失败；兜底走降级（不限流），避免僵死。
    match sem.acquire_owned().await {
        Ok(permit) => {
            let resp = next.run(req).await;
            drop(permit);
            resp
        }
        Err(_) => next.run(req).await,
    }
}

/// web 模式专用：/file 与 /thumbnail 套并发闸（10 个并发 + 无限排队），/proxy 不受限。
#[cfg(not(target_os = "android"))]
pub fn file_routes_web() -> Router {
    let gated = Router::new()
        .route("/file", get(handle_file_query))
        .route("/thumbnail", get(handle_thumbnail_query))
        .layer(from_fn(image_concurrency_mw));
    gated.route("/proxy", get(handle_proxy_query))
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

    let app = file_routes().fallback(handle_unmatched);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[file-server] stopped: {e}");
        }
    });

    let _ = HTTP_SERVER_PORT.set(port);
    Ok(port)
}

#[cfg(all(not(target_os = "android"), feature = "local"))]
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
