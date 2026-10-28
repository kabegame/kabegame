//! IPC bridge helpers for the CEF runtime.
//!
//! Tauri 2 的命令 IPC 有两条上游通道:`fetch(ipc://localhost/<cmd>)` 自定义协议
//! (主通道,JSON 与 raw 二进制 body 都走它,请求与响应在 DevTools Network 面板可见)
//! 与 `window.ipc.postMessage(...)` JSON 回退(fetch 失败后由上游脚本自动切换)。
//! 主通道直接由 Tauri 注册的 `ipc` scheme handler 承接:CEF scheme handler 处理的
//! 请求不发 CORS 预检,只在响应上校验 ACAO,Tauri 的 `ipc` handler 已返回 `*`;
//! `ipc` scheme 注册时带 `CSP_BYPASSING`,第三方页面的严格 CSP 也拦不住它。
//!
//! 本模块只补 CEF 缺的回退通道:提供 `window.ipc.postMessage` 实现 —— 经 CEF 自有的
//! `cef-ipc://` 自定义协议 POST,转发给 Tauri `PendingWebview` 的 `ipc_handler`
//! (JSON 通道,`Uint8Array` payload 会退化成数字数组,不能承载二进制)。
//!
//! 纵深防御:`cef-ipc` scheme handler 本身不区分 frame,子 frame(例如图库里跨源 iframe
//! 承载的 WPE 网页壁纸)也能 POST 进来,此前只靠 Tauri 的 invoke key 挡住。现在只接受
//! **主 frame**(畅游窗口的注入脚本跑在主 frame,Origin 是站点源,所以不能按「应用源」判),
//! 或与该 webview 初始 URL **同源**的子 frame(同源子 frame 本来就能被主 frame 脚本完全访问,
//! 放行不扩大攻击面);其余返回 400。frame 身份由 scheme factory 的 `frame.is_main()` 提供
//! (见 [`crate::protocol::RequestFrame`]);CEF 未给出 frame 时维持原行为。

use std::{borrow::Cow, sync::Mutex};

use http::{
    header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE},
    Request as HttpRequest, Response as HttpResponse, StatusCode,
};
use tauri_runtime::{
    webview::{DetachedWebview, InitializationScript, PendingWebview},
    UserEvent,
};

use crate::{protocol::RequestFrame, Cef};

pub(crate) const CEF_IPC_SCHEME: &str = "cef-ipc";

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
            Err(message) => text_response(StatusCode::BAD_REQUEST, message),
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

    if let Some(frame) = request.extensions().get::<RequestFrame>() {
        if !frame.is_main && !is_same_origin_as(&request, fallback_url) {
            return Err("CEF IPC postMessage is only accepted from the main frame".to_string());
        }
    }

    // Tauri 的 handle_ipc_message 会对该 URI 做 `Url::parse(...).expect(...)`;
    // opaque origin(错误页、Cloudflare 拦截页、沙箱 iframe)的 Origin 头是字面量
    // "null",能过 http::Uri 但过不了 url::Url,必须在此过滤,否则整个进程 abort。
    let uri = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| url::Url::parse(value).is_ok())
        .unwrap_or(fallback_url)
        .to_string();

    if url::Url::parse(&uri).is_err() {
        return Err(format!("CEF IPC postMessage origin is not an absolute URL: {uri}"));
    }

    let body = String::from_utf8(request.into_body())
        .map_err(|_| "CEF IPC postMessage body must be UTF-8".to_string())?;

    HttpRequest::builder()
        .uri(uri)
        .body(body)
        .map_err(|error| format!("invalid CEF IPC postMessage request: {error}"))
}

/// 请求的 `Origin` 是否与 webview 初始 URL 同源(子 frame 白名单)。缺 Origin、opaque
/// (`null`)或解析失败一律视为不同源。
fn is_same_origin_as(request: &HttpRequest<Vec<u8>>, initial_url: &str) -> bool {
    let Some(origin) = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| url::Url::parse(value).ok())
    else {
        return false;
    };
    let Ok(initial) = url::Url::parse(initial_url) else {
        return false;
    };
    let origin = origin.origin();
    origin.is_tuple() && origin == initial.origin()
}

fn text_response(status: StatusCode, message: String) -> HttpResponse<Cow<'static, [u8]>> {
    HttpResponse::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(message.into_bytes()))
        .expect("static text response must be valid")
}

fn empty_response(status: StatusCode) -> HttpResponse<Cow<'static, [u8]>> {
    HttpResponse::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("static empty response must be valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(origin: Option<&str>, frame: Option<bool>) -> HttpRequest<Vec<u8>> {
        let mut builder = HttpRequest::builder()
            .method(http::Method::POST)
            .uri("cef-ipc://localhost/");
        if let Some(origin) = origin {
            builder = builder.header(http::header::ORIGIN, origin);
        }
        let mut request = builder.body(b"{}".to_vec()).unwrap();
        if let Some(is_main) = frame {
            request.extensions_mut().insert(RequestFrame { is_main });
        }
        request
    }

    const APP: &str = "http://tauri.localhost/";

    #[test]
    fn main_frame_is_accepted_with_any_origin() {
        // 畅游窗口注入脚本：主 frame，Origin 是站点源
        assert!(post_message_request(request(Some("https://example.com"), Some(true)), APP).is_ok());
    }

    #[test]
    fn cross_origin_subframe_is_rejected() {
        // 图库里承载 WPE 网页壁纸的跨源 iframe
        assert!(post_message_request(request(Some("http://127.0.0.1:33050"), Some(false)), APP).is_err());
        assert!(post_message_request(request(Some("null"), Some(false)), APP).is_err());
        assert!(post_message_request(request(None, Some(false)), APP).is_err());
    }

    #[test]
    fn same_origin_subframe_is_accepted() {
        assert!(post_message_request(request(Some("http://tauri.localhost"), Some(false)), APP).is_ok());
    }

    #[test]
    fn unknown_frame_keeps_previous_behavior() {
        assert!(post_message_request(request(Some("https://example.com"), None), APP).is_ok());
    }
}
