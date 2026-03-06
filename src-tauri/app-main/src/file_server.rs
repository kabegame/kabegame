#[cfg(not(target_os = "android"))]
use std::{path::Path, str::FromStr, sync::OnceLock};

// #region agent log
#[cfg(not(target_os = "android"))]
fn debug_log(location: &str, message: &str, data: &std::collections::HashMap<&str, String>, hypothesis_id: &str) {
    let path_esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ").replace('\r', " ");
    let data_str = data
        .iter()
        .map(|(k, v)| format!("\"{}\":\"{}\"", k, path_esc(v)))
        .collect::<Vec<_>>()
        .join(",");
    let line = format!(
        r#"{{"sessionId":"3057c8","location":"{}","message":"{}","data":{{{}}},"timestamp":{},"hypothesisId":"{}"}}"#,
        path_esc(location),
        path_esc(message),
        data_str,
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        hypothesis_id
    );
    let log_path = std::env::temp_dir().join("debug-3057c8.log");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, (line + "\n").as_bytes()));
}
// #endregion

#[cfg(not(target_os = "android"))]
use axum::{
    body::Body,
    extract::Query,
    http::{
        header::{CONTENT_TYPE, HeaderValue},
        Request, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(not(target_os = "android"))]
use serde::Deserialize;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
use tower::ServiceExt;
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
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

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn build_serve_dir_request(path: &str) -> Option<Request<Body>> {
    let uri = Uri::from_str(path).ok()?;
    Request::builder().uri(uri).body(Body::empty()).ok()
}

#[cfg(not(target_os = "android"))]
fn mime_from_image_or_path(img: &kabegame_core::storage::ImageInfo, path: &str) -> Option<String> {
    let from_db = img
        .mime_type
        .as_deref()
        .filter(|m| !m.trim().is_empty());
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
    // #region agent log
    let mut data = std::collections::HashMap::new();
    data.insert("path", path.to_string());
    data.insert("path_len", path.len().to_string());
    debug_log("file_server.rs:handle_thumbnail_query", "thumbnail request", &data, "A");
    // #endregion
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }
    if !is_allowed_image_ext(path) {
        return (StatusCode::FORBIDDEN, "file extension not allowed").into_response();
    }

    let metadata_ok = tokio::fs::metadata(path).await.is_ok();
    // #region agent log
    let mut data2 = std::collections::HashMap::new();
    data2.insert("metadata_ok", metadata_ok.to_string());
    debug_log("file_server.rs:handle_thumbnail_query", "after metadata", &data2, "B");
    // #endregion
    if !metadata_ok {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    let find_result = kabegame_core::storage::Storage::global().find_image_by_thumbnail_path(path);
    let result_label = match &find_result {
        Ok(Some(_)) => "Some",
        Ok(None) => "None",
        Err(_) => "Err",
    };
    // #region agent log
    let mut data3 = std::collections::HashMap::new();
    data3.insert("find_result", result_label.to_string());
    if let Err(e) = &find_result {
        data3.insert("find_err", e.to_string());
    }
    debug_log("file_server.rs:handle_thumbnail_query", "after find_image_by_thumbnail_path", &data3, "C");
    // #endregion
    let img = match find_result {
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

    let app = Router::new()
        .route("/file", get(handle_file_query))
        .route("/thumbnail", get(handle_thumbnail_query));
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
