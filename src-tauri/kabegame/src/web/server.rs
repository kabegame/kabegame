use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::Duration;

use axum::{
    extract::{Path, Query},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use super::dispatch::{dispatch, JsonRpcRequest};

#[derive(Clone)]
pub struct SseMessage {
    pub event: String,
    pub data: String,
    pub id: u64,
}

static EVENT_BUS: OnceLock<broadcast::Sender<SseMessage>> = OnceLock::new();

pub fn event_bus() -> &'static broadcast::Sender<SseMessage> {
    EVENT_BUS.get_or_init(|| {
        let (tx, _) = broadcast::channel(1024);
        tx
    })
}

pub fn web_routes() -> Router {
    Router::new()
        .route("/events", get(sse_handler))
        .route("/logs", get(log_sse_handler))
        .route("/rpc", post(rpc_handler))
        .route("/rpc/{method}", post(rpc_method_handler))
}

async fn sse_handler(
    Query(params): Query<HashMap<String, String>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>> + Send + 'static> {
    let is_super = params.get("super").map(|v| v == "1").unwrap_or(false);
    let rx = event_bus().subscribe();

    let hello = futures_util::stream::once(futures_util::future::ready(Ok::<_, Infallible>(
        Event::default()
            .event("connected")
            .data(serde_json::json!({ "super": is_super }).to_string()),
    )));

    let events = BroadcastStream::new(rx).filter_map(|r| async move {
        r.ok().map(|msg| {
            Ok::<_, Infallible>(
                Event::default()
                    .event(msg.event)
                    .id(msg.id.to_string())
                    .data(msg.data),
            )
        })
    });

    Sse::new(hello.chain(events)).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
}

/// 应用日志的 SSE（`event: log`，data 为 `LogRecord` JSON）；只对 super 开放。
/// 日志是 opt-in 事件，不经 `/events` 的全局事件总线，避免推给所有 Web 客户端。
/// 本函数处在日志管线上，不要在这里打 trace 以上的日志。
async fn log_sse_handler(
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use kabegame_core::ipc::events::{AppEvent, AppEventKind};
    use kabegame_core::ipc::server::EventBroadcaster;

    let is_super = params.get("super").map(|v| v == "1").unwrap_or(false);
    if !is_super {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    let rx = EventBroadcaster::global().subscribe_filtered_stream(&[AppEventKind::Log]);
    let events = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).filter_map(
        |(_, event)| async move {
            let AppEvent::Log { record } = &*event else {
                return None;
            };
            Some(Ok::<_, Infallible>(
                Event::default()
                    .event("log")
                    .id(record.seq.to_string())
                    .data(serde_json::to_string(record).unwrap_or_else(|_| "null".into())),
            ))
        },
    );
    Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response()
}

async fn rpc_handler(
    Query(params): Query<HashMap<String, String>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<serde_json::Value> {
    dispatch_rpc(params, req).await
}

async fn rpc_method_handler(
    Path(method): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<serde_json::Value> {
    if method != req.method {
        return Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": req.id.unwrap_or(serde_json::Value::Null),
            "error": { "code": -32600, "message": "URL method does not match request method" },
        }));
    }
    dispatch_rpc(params, req).await
}

async fn dispatch_rpc(
    params: HashMap<String, String>,
    req: JsonRpcRequest,
) -> Json<serde_json::Value> {
    let is_super = params.get("super").map(|v| v == "1").unwrap_or(false);
    #[cfg(feature = "web")]
    let timer = super::track::start(&req.method);
    let resp = dispatch(req, is_super).await;
    #[cfg(feature = "web")]
    if let Some(timer) = timer {
        timer.finish(&resp);
    }
    Json(resp)
}
