//! 各平台共用的插件文件 HTTP 路由。
use axum::{
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use kabegame_core::plugin::{package_file::*, PluginManager};
use serde::Deserialize;

#[derive(Default, Deserialize)]
struct FileQuery {
    v: Option<String>,
    source: Option<String>,
    preview: Option<String>,
    t: Option<String>,
}

pub fn plugin_file_routes() -> Router {
    Router::new()
        .route("/plugin_file/{plugin_id}/{*path}", get(handle_plugin_file))
        .layer(axum::middleware::from_fn(plugin_file_cors))
}

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
    let origin = match (query.source, query.preview) {
        (None, None) => PluginFileOrigin::Installed,
        (Some(source_id), None) => PluginFileOrigin::Store { source_id },
        (None, Some(token)) => PluginFileOrigin::Preview { token },
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let Some(manager) = PluginManager::global_opt() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(plugin) = manager.resolve_plugin_file(&id, &origin, &version) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(entry) = allowed_entry(&plugin, &path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let annotate = match query.t.as_deref() {
        None => false,
        Some("recommendedConfig") if is_recommended_config(&plugin, &entry) => true,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<Response, String> {
        let Some(file) = plugin.file_path.as_ref() else {
            return Err("无插件文件".into());
        };
        let bytes = read_kgpg_entry(std::path::Path::new(file), &entry)?.ok_or("无条目")?;
        if annotate {
            let json = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let body = serde_json::to_vec(&annotate_recommended_config(&plugin, &entry, json)?)
                .map_err(|e| e.to_string())?;
            return Ok((
                [
                    ("content-type", "application/json; charset=utf-8"),
                    ("cache-control", "no-store"),
                ],
                body,
            )
                .into_response());
        }
        let etag = etag_for(&plugin)?;
        let matches = headers
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',').any(|value| {
                    let value = value.trim().trim_start_matches("W/");
                    value == etag || value == "*"
                })
            });
        let response = if matches {
            StatusCode::NOT_MODIFIED.into_response()
        } else {
            ([("content-type", mime_for_plugin_file(&entry))], bytes).into_response()
        };
        let mut response = response;
        response.headers_mut().insert(
            "etag",
            etag.parse()
                .map_err(|e: axum::http::header::InvalidHeaderValue| e.to_string())?,
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
