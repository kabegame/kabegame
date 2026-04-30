use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::Duration;

use axum::{
    extract::Query,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use kabegame_core::ipc::events::DaemonEventKind;
use kabegame_core::ipc::server::EventBroadcaster;

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
        .route("/rpc", post(rpc_handler))
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

async fn rpc_handler(
    Query(params): Query<HashMap<String, String>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<serde_json::Value> {
    let is_super = params.get("super").map(|v| v == "1").unwrap_or(false);
    Json(dispatch(req, is_super).await)
}

pub fn start_web_event_loop() {
    let bus = event_bus().clone();
    tokio::spawn(async move {
        let mut rx = EventBroadcaster::global().subscribe_filtered_stream(&DaemonEventKind::ALL);
        let mut counter = 0u64;
        while let Some((_id, event)) = rx.recv().await {
            counter += 1;
            let event_name = event.kind().as_event_name();
            let data = serde_json::to_string(&*event).unwrap_or_else(|_| "null".into());
            let _ = bus.send(SseMessage {
                event: event_name,
                data,
                id: counter,
            });
        }
    });
}
