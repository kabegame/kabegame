//! IPC bridge helpers for the CEF runtime.
//!
//! Tauri 2 的命令 IPC 有两条上游通道:`fetch(ipc://localhost/<cmd>)` 自定义协议
//! (主通道,JSON 与 raw 二进制 body 都走它,请求与响应在 DevTools Network 面板可见)
//! 与 `window.ipc.postMessage(...)` JSON 回退(fetch 失败后由上游脚本自动切换)。
//! 主通道直接由 Tauri 注册的 `ipc` scheme handler 承接:CEF scheme handler 处理的
//! 请求不发 CORS 预检,只在响应上校验 ACAO,Tauri 的 `ipc` handler 已返回 `*`;
//! `ipc` scheme 注册时带 `CSP_BYPASSING`,第三方页面的严格 CSP 也拦不住它。
//! 三平台主通道都是 `ipc://localhost/<cmd>`。tauri 补丁 0012 给主通道 fetch 加了
//! `referrerPolicy: 'origin'`,防止 `no-referrer` 页面发出 `Origin: null`；下面的回退 shim 也照此设置。
//!
//! 本模块只补 CEF 缺的回退通道:提供 `window.ipc.postMessage` 实现 —— 经 CEF 自有的
//! `cef-ipc://` 自定义协议 POST,转发给 Tauri `PendingWebview` 的 `ipc_handler`
//! (JSON 通道,`Uint8Array` payload 会退化成数字数组,不能承载二进制)。
//!
//! 子 frame:Tauri 的 IPC 桥(连同本模块的回退 shim)无条件注入每个子 frame(见
//! `subprocess.rs` 与 `WebviewAttributes::subframe_bridge_scripts`),子 frame 能调什么完全由 ACL 决定。
//! 所以回退通道放行所有 CEF 给出了 frame 的请求,不再要求子 frame 与初始 URL 同源:请求带着
//! [`IpcFrame`] 与子 frame 的 [`SubframeId`] extension(见 `crate::protocol::attach_request_frame`),
//! Tauri ACL 按 frame 匹配 capability 的 `frames`(默认只认主 frame),响应送回发起调用的 frame。
//! 回退通道重新构造请求时把两个 extension 一并带上;CEF 未给出 frame 时记为 `Unknown`。
//!
//! 来源判定：只取协议层按发起方与 CEF 补丁 0007 文档 URL 算好的 Origin。无法解析时
//! 统一用占位来源交给 ACL 拒绝，绝不回退到 frame URL 或 webview 初始 URL。

use std::{borrow::Cow, sync::Mutex};

use http::{
    header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE},
    Request as HttpRequest, Response as HttpResponse, StatusCode,
};
use tauri_runtime::{
    webview::{DetachedWebview, InitializationScript, IpcFrame, PendingWebview, SubframeId},
    UserEvent,
};

use crate::Cef;

pub(crate) const CEF_IPC_SCHEME: &str = "cef-ipc";

/// 认不出来源的子 frame 交给 Tauri 的占位来源:不是已注册的自定义协议(Tauri 判成远程),不匹配任何
/// capability 的 `remote.urls`,于是请求在 ACL 被拒。不要给任何 capability 配匹配一切的远程模式。
pub(crate) const UNATTRIBUTED_IPC_ORIGIN: &str = "kabegame-unattributed://ipc/";

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
          headers: { 'Content-Type': 'application/json' },
          // 与 tauri 补丁 0012 给主通道加的一致：站点的 referrer 策略不影响 Origin 头
          referrerPolicy: 'origin'
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
    // 子 frame 同样拿到回退通道:与 Tauri 的桥一起无条件注入,权限只看 ACL
    pending
        .webview_attributes
        .subframe_bridge_scripts
        .insert(0, POST_MESSAGE_SHIM.to_string());

    let ipc_handler = Mutex::new(ipc_handler);
    pending.register_uri_scheme_protocol(CEF_IPC_SCHEME, move |_label, request, responder| {
        let response = match post_message_request(request) {
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

fn post_message_request(request: HttpRequest<Vec<u8>>) -> Result<HttpRequest<String>, String> {
    if request.method() != http::Method::POST {
        return Err("CEF IPC postMessage only accepts POST".to_string());
    }
    // Tauri 会对 URI 做 Url::parse；不合法来源改用远程占位来源，由 ACL 拒绝。
    let http_uri = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| url::Url::parse(value).is_ok())
        .map(http_uri_for)
        .filter(|uri| uri.parse::<http::Uri>().is_ok())
        .unwrap_or_else(|| UNATTRIBUTED_IPC_ORIGIN.to_string());

    // 重新构造请求会丢掉全部 extension:把 Tauri 要用的 frame 位置与子 frame 标识带过去
    let ipc_frame = request
        .extensions()
        .get::<IpcFrame>()
        .copied()
        .unwrap_or(IpcFrame::Unknown);
    let subframe_id = request.extensions().get::<SubframeId>().cloned();

    let body = String::from_utf8(request.into_body())
        .map_err(|_| "CEF IPC postMessage body must be UTF-8".to_string())?;

    let mut rebuilt = HttpRequest::builder()
        .uri(http_uri)
        .extension(ipc_frame)
        .body(body)
        .map_err(|error| format!("invalid CEF IPC postMessage request: {error}"))?;
    if let Some(subframe_id) = subframe_id {
        rebuilt.extensions_mut().insert(subframe_id);
    }
    Ok(rebuilt)
}

/// `http::Uri` 不接受空 authority，`file:///D:/…` 装不进请求 URI；改写成等价的
/// `file://localhost/…`。Tauri 再用 `url::Url` 解析时把 `file:` 的 `localhost` 主机归一为空，
/// 拿到的仍是 `file:///…`，ACL 按它匹配远程来源。其它 URL 原样返回。
fn http_uri_for(url: &str) -> String {
    match url.get(..8) {
        Some(prefix) if prefix.eq_ignore_ascii_case("file:///") => {
            format!("file://localhost/{}", &url[8..])
        }
        _ => url.to_string(),
    }
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
    use crate::protocol::RequestFrame;

    fn request(origin: Option<&str>, frame: Option<bool>) -> HttpRequest<Vec<u8>> {
        request_from(
            origin,
            frame.map(|is_main| RequestFrame {
                is_main,
                id: (!is_main).then(|| "2-5".to_string()),
            }),
        )
    }

    fn request_from(origin: Option<&str>, frame: Option<RequestFrame>) -> HttpRequest<Vec<u8>> {
        let mut builder = HttpRequest::builder()
            .method(http::Method::POST)
            .uri("cef-ipc://localhost/");
        if let Some(origin) = origin {
            builder = builder.header(http::header::ORIGIN, origin);
        }
        let mut request = builder.body(b"{}".to_vec()).unwrap();
        if let Some(frame) = frame {
            // 与协议层 `attach_request_frame` 一致:frame 位置、子 frame 标识与 RequestFrame 一起插
            request.extensions_mut().insert(frame.ipc_frame());
            if let Some(id) = frame.subframe_id() {
                request.extensions_mut().insert(id);
            }
            request.extensions_mut().insert(frame);
        }
        request
    }

    fn ipc_frame_of(request: &HttpRequest<String>) -> Option<IpcFrame> {
        request.extensions().get::<IpcFrame>().copied()
    }

    fn subframe_id_of(request: &HttpRequest<String>) -> Option<SubframeId> {
        request.extensions().get::<SubframeId>().cloned()
    }

    #[test]
    fn frame_and_subframe_id_survive_the_rebuilt_request() {
        let rebuilt =
            post_message_request(request(Some("https://example.com"), Some(true))).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Main));
        assert_eq!(subframe_id_of(&rebuilt), None);
        let rebuilt =
            post_message_request(request(Some("tauri://localhost"), Some(false))).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub));
        assert_eq!(subframe_id_of(&rebuilt), Some(SubframeId::new("2-5")));
        let rebuilt = post_message_request(request(Some("https://example.com"), None)).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Unknown));
    }

    fn tauri_url(request: HttpRequest<String>) -> String {
        url::Url::parse(&request.uri().to_string())
            .unwrap()
            .to_string()
    }

    #[test]
    fn main_frame_is_accepted_with_any_origin() {
        assert_eq!(
            tauri_url(
                post_message_request(request(Some("https://example.com"), Some(true))).unwrap()
            ),
            "https://example.com/"
        );
    }

    #[test]
    fn cross_origin_subframe_is_accepted_as_sub() {
        for origin in [
            "http://127.0.0.1:33050",
            "tauri://evil",
            "https://example.org",
        ] {
            let rebuilt = post_message_request(request(Some(origin), Some(false))).unwrap();
            assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub));
            assert!(!tauri_url(rebuilt).starts_with("tauri://localhost/"));
        }
    }

    #[test]
    fn invalid_origin_uses_placeholder() {
        for frame in [Some(true), Some(false), None] {
            for origin in [None, Some("null")] {
                let rebuilt = post_message_request(request(origin, frame)).unwrap();
                assert_eq!(tauri_url(rebuilt), UNATTRIBUTED_IPC_ORIGIN);
            }
        }
    }

    #[test]
    fn file_document_origin_survives_http_uri() {
        let rebuilt =
            post_message_request(request(Some("file:///D:/wpe/1/index.html"), Some(false)))
                .unwrap();
        assert_eq!(tauri_url(rebuilt), "file:///D:/wpe/1/index.html");
    }

    #[test]
    fn file_url_survives_http_uri() {
        assert_eq!(
            http_uri_for("file:///D:/a%20b/index.html"),
            "file://localhost/D:/a%20b/index.html"
        );
        assert!("file:///D:/x/index.html".parse::<http::Uri>().is_err());
        assert!(http_uri_for("file:///D:/x/index.html")
            .parse::<http::Uri>()
            .is_ok());
    }
}
