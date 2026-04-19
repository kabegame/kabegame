use axum::{
    Router,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
#[cfg(not(debug_assertions))]
use axum::{
    body::Body,
    http::{HeaderValue, header::CONTENT_TYPE},
};

/// Returns a Router that serves compiled Vue static assets via a fallback handler.
///
/// Release builds embed `dist-main/` at compile time via `include_dir!` (single-binary).
/// Debug builds return 404 — the Vite dev server on :1420 serves the frontend.
pub fn static_assets_router() -> Router {
    Router::new().fallback(static_fallback)
}

#[cfg(not(debug_assertions))]
static DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../dist-main");

async fn static_fallback(req: Request) -> Response {
    #[cfg(not(debug_assertions))]
    return serve_embedded(req.uri().path()).await;

    #[cfg(debug_assertions)]
    {
        let _ = req;
        (
            StatusCode::NOT_FOUND,
            "Static assets not available in debug builds — run Vite dev server on :1420",
        )
            .into_response()
    }
}

#[cfg(not(debug_assertions))]
async fn serve_embedded(raw_path: &str) -> Response {
    let path = raw_path.trim_start_matches('/');
    if path.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }

    if let Some(file) = DIST.get_file(path) {
        return build_file_response(file.path().to_str().unwrap_or(""), file.contents());
    }

    // SPA fallback: all unmatched paths get index.html
    if let Some(index) = DIST.get_file("index.html") {
        return build_file_response(index.path().to_str().unwrap_or(""), index.contents());
    }

    StatusCode::NOT_FOUND.into_response()
}

#[cfg(not(debug_assertions))]
fn build_file_response(path: &str, contents: &'static [u8]) -> Response {
    let mime = mime_for_path(path);
    let mut resp = (StatusCode::OK, Body::from(contents)).into_response();
    if let Ok(v) = HeaderValue::from_str(mime) {
        resp.headers_mut().insert(CONTENT_TYPE, v);
    }
    resp
}

#[cfg(not(debug_assertions))]
fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}
