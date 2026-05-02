//! POST /api/import — web-mode upload: receives multipart files, spills them
//! to `cache_dir/web-upload/{uuid}/`, then enqueues a `local-import` task.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::{
    extract::{Multipart, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use kabegame_core::app_paths::AppPaths;
use kabegame_core::crawler::{CrawlTaskRequest, TaskScheduler};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::storage::{Storage, TaskInfo};

#[derive(Debug, Deserialize)]
struct ImportQuery {
    output_album_id: Option<String>,
    #[serde(default)]
    recursive: Option<String>,
    #[serde(default)]
    include_archive: Option<String>,
    #[serde(default, rename = "super")]
    super_flag: Option<String>,
}

#[derive(Debug, Serialize)]
struct ImportResponse {
    task_id: String,
}

fn truthy(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1") | Some("true"))
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_join(base: &std::path::Path, rel: &str) -> Option<PathBuf> {
    let normalized = rel.replace('\\', "/");
    let mut out = base.to_path_buf();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        out.push(sanitize_segment(seg));
    }
    // Must still be under base
    out.starts_with(base).then_some(out)
}

fn bad_request(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, msg.into()).into_response()
}

async fn handle_import(Query(q): Query<ImportQuery>, mut multipart: Multipart) -> Response {
    if !truthy(&q.super_flag) {
        return (StatusCode::FORBIDDEN, "super required").into_response();
    }

    let upload_root = AppPaths::global()
        .cache_dir
        .join("web-upload")
        .join(uuid::Uuid::new_v4().to_string());
    if let Err(e) = tokio::fs::create_dir_all(&upload_root).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("create upload dir failed: {e}"),
        )
            .into_response();
    }

    let mut file_count = 0usize;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return bad_request(format!("multipart read failed: {e}")),
        };
        let rel_name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("file_{file_count}"));
        let dest = match safe_join(&upload_root, &rel_name) {
            Some(p) => p,
            None => return bad_request("invalid file name"),
        };
        if let Some(parent) = dest.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("mkdir failed: {e}"),
                )
                    .into_response();
            }
        }
        let mut file = match tokio::fs::File::create(&dest).await {
            Ok(f) => f,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("create file failed: {e}"),
                )
                    .into_response();
            }
        };
        let bytes = match field.bytes().await {
            Ok(b) => b,
            Err(e) => return bad_request(format!("field read failed: {e}")),
        };
        if let Err(e) = file.write_all(&bytes).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("write failed: {e}"),
            )
                .into_response();
        }
        file_count += 1;
    }

    if file_count == 0 {
        let _ = tokio::fs::remove_dir_all(&upload_root).await;
        return bad_request("no files uploaded");
    }

    let recursive = q
        .recursive
        .as_deref()
        .map(|v| v == "1" || v == "true")
        .unwrap_or(true);
    let include_archive = truthy(&q.include_archive);

    let root_str = upload_root.to_string_lossy().to_string();
    let mut user_config: HashMap<String, serde_json::Value> = HashMap::new();
    user_config.insert("paths".to_string(), serde_json::json!([root_str]));
    user_config.insert("recursive".to_string(), serde_json::Value::Bool(recursive));
    user_config.insert(
        "include_archive".to_string(),
        serde_json::Value::Bool(include_archive),
    );

    let task_id = uuid::Uuid::new_v4().to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let task_info = TaskInfo {
        id: task_id.clone(),
        plugin_id: "local-import".to_string(),
        output_dir: None,
        user_config: Some(user_config.clone()),
        http_headers: None,
        output_album_id: q.output_album_id.clone(),
        run_config_id: None,
        trigger_source: "web-upload".to_string(),
        status: "pending".to_string(),
        progress: 0.0,
        deleted_count: 0,
        dedup_count: 0,
        success_count: 0,
        failed_count: 0,
        start_time: Some(now_ms),
        end_time: None,
        error: None,
    };
    if let Err(e) = Storage::global().add_task(task_info.clone()) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    if let Ok(payload) = serde_json::to_value(&task_info) {
        GlobalEmitter::global().emit_task_added(&payload);
    }

    let req = CrawlTaskRequest {
        plugin_id: "local-import".to_string(),
        task_id: task_id.clone(),
        output_dir: None,
        user_config: Some(user_config),
        http_headers: None,
        output_album_id: q.output_album_id,
        plugin_file_path: None,
        run_config_id: None,
        trigger_source: "web-upload".to_string(),
    };
    if let Err(e) = TaskScheduler::global().submit_task(req) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }

    Json(ImportResponse { task_id }).into_response()
}

pub fn api_routes() -> Router {
    Router::new()
        .route("/api/import", post(handle_import))
        .layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024 * 1024))
}

/// Best-effort cleanup: remove subdirectories older than 24h under cache_dir/web-upload.
pub async fn gc_stale_uploads() {
    let root = AppPaths::global().cache_dir.join("web-upload");
    let mut dir = match tokio::fs::read_dir(&root).await {
        Ok(d) => d,
        Err(_) => return,
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    while let Ok(Some(entry)) = dir.next_entry().await {
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if mtime < cutoff {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}
