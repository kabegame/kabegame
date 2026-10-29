//! Android / Web 共用的插件文件 HTTP 路由。
#[cfg(any(feature = "web", target_os = "android"))]
use axum::{
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(any(feature = "web", target_os = "android"))]
use kabegame_core::plugin::package_file::*;
#[cfg(any(feature = "web", target_os = "android"))]
use serde::Deserialize;

#[cfg(any(feature = "web", target_os = "android"))]
#[derive(Default, Deserialize)]
struct FileQuery {
    v: Option<String>,
    source: Option<String>,
    preview: Option<String>,
}

#[cfg(any(feature = "web", target_os = "android"))]
pub fn plugin_file_routes() -> Router {
    Router::new()
        .route("/plugin_file/{plugin_id}/{*path}", get(handle_plugin_file))
        .layer(axum::middleware::from_fn(plugin_file_cors))
}

#[cfg(any(feature = "web", target_os = "android"))]
async fn plugin_file_cors(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut response = if request.method() == axum::http::Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        ("access-control-allow-methods", "GET, HEAD, OPTIONS"),
        ("access-control-allow-headers", "If-None-Match"),
        ("access-control-expose-headers", "ETag, Cache-Control"),
    ] {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}

#[cfg(any(feature = "web", target_os = "android"))]
async fn handle_plugin_file(
    Path((id, path)): Path<(String, String)>,
    query: Result<Query<FileQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let Ok(Query(query)) = query else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(version) = query.v else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(origin) = PluginFileOrigin::from_query(query.source, query.preview) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let result = tokio::task::spawn_blocking(move || -> Result<Response, String> {
        let body = read_plugin_file(&id, &origin, &version, &path, if_none_match.as_deref())
            .map_err(|error| error.to_string())?;
        let (mut response, etag) = match body {
            Some(body) => (
                ([("content-type", body.mime)], body.bytes).into_response(),
                body.etag,
            ),
            None => {
                let plugin = kabegame_core::plugin::PluginManager::global_opt()
                    .and_then(|manager| manager.resolve_plugin_file(&id, &origin, &version))
                    .ok_or("插件文件不存在")?;
                (StatusCode::NOT_MODIFIED.into_response(), etag_for(&plugin)?)
            }
        };
        response.headers_mut().insert(
            "etag",
            etag.parse()
                .map_err(|error: axum::http::header::InvalidHeaderValue| error.to_string())?,
        );
        response
            .headers_mut()
            .insert("cache-control", "no-cache".parse().unwrap());
        Ok(response)
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Android 的 Kotlin 文件服务将插件请求转发到这个有界 loopback 服务。
#[cfg(target_os = "android")]
pub async fn start_plugin_file_server() -> Result<u16, String> {
    static PORT: tokio::sync::OnceCell<u16> = tokio::sync::OnceCell::const_new();
    PORT.get_or_try_init(|| async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let app = plugin_file_routes();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                eprintln!("[plugin-file] {error}");
            }
        });
        Ok(port)
    })
    .await
    .copied()
}
