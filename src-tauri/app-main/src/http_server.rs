#[cfg(not(target_os = "android"))]
use std::{io::Write, path::Path, str::FromStr, sync::OnceLock};

#[cfg(not(target_os = "android"))]
use axum::{
    body::Body,
    extract::Query,
    http::{
        header::{HeaderValue, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE},
        Request, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
#[cfg(not(target_os = "android"))]
use serde_json::json;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower::ServiceExt;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower_http::services::ServeDir;

#[cfg(not(target_os = "android"))]
pub static HTTP_SERVER_PORT: OnceLock<u16> = OnceLock::new();

#[cfg(not(target_os = "android"))]
fn debug_log(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
    // #region agent log
    let payload = json!({
        "sessionId": "be562c",
        "runId": "initial",
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": chrono_like_now_ms(),
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/Users/cmtheit/code/kabegame/.cursor/debug-be562c.log")
    {
        let _ = writeln!(file, "{payload}");
    }
    // #endregion
}

#[cfg(not(target_os = "android"))]
fn chrono_like_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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

#[cfg(not(target_os = "android"))]
fn is_allowed_image_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    kabegame_core::image_type::is_supported_image_ext(ext)
}

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn build_serve_dir_request(path: &str) -> Option<Request<Body>> {
    let uri = Uri::from_str(path).ok()?;
    Request::builder().uri(uri).body(Body::empty()).ok()
}

#[cfg(not(target_os = "android"))]
fn mime_from_image_or_path(img: &kabegame_core::storage::ImageInfo, path: &str) -> Option<String> {
    let from_db = img.mime_type.as_deref().filter(|m| !m.trim().is_empty());
    if from_db.is_some() {
        return from_db.map(String::from);
    }
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
async fn handle_file_query(Query(query): Query<FileQuery>) -> Response {
    let path = query.path.trim();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }
    if !is_allowed_image_ext(path) {
        return (StatusCode::FORBIDDEN, "file extension not allowed").into_response();
    }

    // 先检查本地文件是否存在，找不到则不查表直接 404
    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    // 表中无此 local_path 则 404
    let img = match kabegame_core::storage::Storage::global().find_image_by_path(path) {
        Ok(Some(img)) => img,
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    serve_file_with_mime(path, mime_from_image_or_path(&img, path)).await
}

#[cfg(not(target_os = "android"))]
async fn handle_thumbnail_query(Query(query): Query<FileQuery>) -> Response {
    let path = query.path.trim();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }
    if !is_allowed_image_ext(path) {
        return (StatusCode::FORBIDDEN, "file extension not allowed").into_response();
    }

    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    let img = match kabegame_core::storage::Storage::global().find_image_by_thumbnail_path(path) {
        Ok(Some(img)) => img,
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    serve_file_with_mime(path, mime_from_image_or_path(&img, path)).await
}

#[cfg(not(target_os = "android"))]
async fn serve_file_with_mime(path: &str, mime_type: Option<String>) -> Response {
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

    // ServeDir 不可用/失败时回落到直接读文件
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mut out = (StatusCode::OK, bytes).into_response();
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

    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::default())
        .build()
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

#[cfg(not(target_os = "android"))]
async fn handle_unmatched(uri: Uri) -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
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

    let app = Router::new()
        .route("/file", get(handle_file_query))
        .route("/thumbnail", get(handle_thumbnail_query))
        .route("/proxy", get(handle_proxy_query))
        .fallback(handle_unmatched);
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
