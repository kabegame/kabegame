//! IPC bridge helpers for the CEF runtime.
//!
//! Tauri 2 prefers `fetch(ipc://localhost/<cmd>)` for command IPC and falls
//! back to `window.ipc.postMessage(...)` when the custom-protocol request fails.
//! `protocol.rs` handles the primary `ipc://` path by forwarding CEF requests
//! to Tauri's prepared URI scheme handlers. This module supplies the
//! `window.ipc.postMessage` fallback by routing it through a CEF-owned
//! `cef-ipc://` custom protocol, then invoking Tauri's `PendingWebview`
//! `ipc_handler`.

use std::{borrow::Cow, sync::Mutex};

use http::{
    header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE},
    Request as HttpRequest, Response as HttpResponse, StatusCode,
};
use tauri_runtime::{
    webview::{DetachedWebview, InitializationScript, PendingWebview},
    UserEvent,
};

use crate::Cef;

const CEF_IPC_SCHEME: &str = "cef-ipc";

const POST_MESSAGE_SHIM: &str = r#"
;(() => {
  if (window.ipc && typeof window.ipc.postMessage === 'function') {
    return
  }

  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: Object.freeze({
      postMessage(data) {
        fetch('cef-ipc://localhost/', {
          method: 'POST',
          body: String(data),
          headers: { 'Content-Type': 'application/json' }
        }).catch((error) => {
          console.error('CEF IPC postMessage failed', error)
        })
      }
    })
  })
})()
"#;

pub(crate) fn install_post_message_bridge<T: UserEvent>(
    pending: &mut PendingWebview<T, Cef<T>>,
    detached: DetachedWebview<T, Cef<T>>,
    initial_url: String,
) {
    let Some(ipc_handler) = pending.ipc_handler.take() else {
        return;
    };

    pending.webview_attributes.initialization_scripts.insert(
        0,
        InitializationScript {
            script: POST_MESSAGE_SHIM.to_string(),
            for_main_frame_only: true,
        },
    );

    let ipc_handler = Mutex::new(ipc_handler);
    pending.register_uri_scheme_protocol(CEF_IPC_SCHEME, move |_label, request, responder| {
        let response = match post_message_request(request, &initial_url) {
            Ok(request) => {
                let handler = ipc_handler.lock().expect("CEF IPC handler mutex poisoned");
                handler(detached.clone(), request);
                empty_response(StatusCode::NO_CONTENT)
            }
            Err(message) => HttpResponse::builder()
                .status(StatusCode::BAD_REQUEST)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Cow::Owned(message.into_bytes()))
                .expect("static bad-request response must be valid"),
        };
        responder(response);
    });
}

fn post_message_request(
    request: HttpRequest<Vec<u8>>,
    fallback_url: &str,
) -> Result<HttpRequest<String>, String> {
    if request.method() != http::Method::POST {
        return Err("CEF IPC postMessage only accepts POST".to_string());
    }

    let uri = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_url)
        .to_string();

    let body = String::from_utf8(request.into_body())
        .map_err(|_| "CEF IPC postMessage body must be UTF-8".to_string())?;

    HttpRequest::builder()
        .uri(uri)
        .body(body)
        .map_err(|error| format!("invalid CEF IPC postMessage request: {error}"))
}

fn empty_response(status: StatusCode) -> HttpResponse<Cow<'static, [u8]>> {
    HttpResponse::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("static empty response must be valid")
}
