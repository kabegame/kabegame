#[cfg(not(target_os = "android"))]
use std::{path::Path, str::FromStr, sync::OnceLock};

#[cfg(not(target_os = "android"))]
use axum::{
    body::Body,
    extract::Query,
    http::{Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
#[cfg(not(target_os = "android"))]
use tower::ServiceExt;
#[cfg(not(target_os = "android"))]
use tower_http::services::ServeDir;

#[cfg(not(target_os = "android"))]
pub static FILE_SERVER_PORT: OnceLock<u16> = OnceLock::new();

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[cfg(not(target_os = "android"))]
fn is_allowed_image_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    kabegame_core::image_type::is_supported_image_ext(ext)
}

#[cfg(not(target_os = "android"))]
fn build_serve_dir_request(path: &str) -> Option<Request<Body>> {
    let uri = Uri::from_str(path).ok()?;
    Request::builder().uri(uri).body(Body::empty()).ok()
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

    // 优先尝试 ServeDir（桌面统一走 HTTP 文件服务）
    #[cfg(not(target_os = "windows"))]
    {
        if path.starts_with('/') {
            if let Some(req) = build_serve_dir_request(path) {
                let service = ServeDir::new("/");
                if let Ok(resp) = service.oneshot(req).await {
                    if resp.status().is_success() {
                        return resp.into_response();
                    }
                }
            }
        }
    }

    // ServeDir 不可用/失败时回落到直接读文件
    match tokio::fs::read(path).await {
        Ok(bytes) => (StatusCode::OK, bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "file not found").into_response(),
    }
}

#[cfg(not(target_os = "android"))]
pub async fn start_file_server() -> Result<u16, String> {
    if let Some(port) = FILE_SERVER_PORT.get() {
        return Ok(*port);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind file server failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read file server local addr failed: {e}"))?
        .port();

    let app = Router::new().route("/file", get(handle_file_query));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[file-server] stopped: {e}");
        }
    });

    let _ = FILE_SERVER_PORT.set(port);
    Ok(port)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_file_server_base_url() -> Result<String, String> {
    for _ in 0..60 {
        if let Some(port) = FILE_SERVER_PORT.get() {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("file server not ready".to_string())
}
