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
//! 来源判定:Tauri 按交给 `ipc_handler` 的请求 URI 区分本地 / 远程来源。取值顺序是
//! `Origin` 头 → 发起请求的 frame URL;都拿不到时主 frame(以及 CEF 没给出 frame 的请求)退到 webview
//! 初始 URL,子 frame **不再**退到初始 URL——初始 URL 是应用页,退过去会把子 frame 判成本地来源。子 frame
//! 改用占位来源 [`UNATTRIBUTED_SUBFRAME_ORIGIN`](装不进 `http::Uri` 的来源同样如此):
//! 它不匹配任何 capability,请求在 Tauri 的 ACL 被拒,错误回调送回发起调用的 frame——页面的 Promise 会
//! reject,而不是像回 400 那样永远挂起。`file:` 文档(WPE 网页壁纸)的 `Origin` 已在协议层改写成 frame
//! URL,所以它总被判成远程 `file:` 来源,只拿到 `remote.urls` 匹配它的 capability。

use std::{borrow::Cow, sync::Mutex};

use http::{
    header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE},
    Request as HttpRequest, Response as HttpResponse, StatusCode,
};
use tauri_runtime::{
    webview::{DetachedWebview, InitializationScript, IpcFrame, PendingWebview, SubframeId},
    UserEvent,
};

use crate::{protocol::RequestFrame, Cef};

pub(crate) const CEF_IPC_SCHEME: &str = "cef-ipc";

/// 认不出来源的子 frame 交给 Tauri 的占位来源:不是已注册的自定义协议(Tauri 判成远程),不匹配任何
/// capability 的 `remote.urls`,于是请求在 ACL 被拒。不要给任何 capability 配匹配一切的远程模式。
pub(crate) const UNATTRIBUTED_SUBFRAME_ORIGIN: &str = "kabegame-unattributed://subframe/";

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
    // 子 frame 同样拿到回退通道:与 Tauri 的桥一起无条件注入,权限只看 ACL
    pending
        .webview_attributes
        .subframe_bridge_scripts
        .insert(0, POST_MESSAGE_SHIM.to_string());

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

    // Tauri 的 handle_ipc_message 会对该 URI 做 `Url::parse(...).expect(...)`;
    // opaque origin(错误页、Cloudflare 拦截页、沙箱 iframe)的 Origin 头是字面量
    // "null",能过 http::Uri 但过不了 url::Url,必须在此过滤,否则整个进程 abort。
    // 回退顺序:Origin 头 → 发起请求的 frame URL → (仅主 frame / 未知 frame)webview 初始 URL。
    // 子 frame 两者都拿不到时用占位来源、交给 ACL 拒绝:初始 URL 是应用页,退过去会让子 frame 被 Tauri
    // 判成本地来源(`file:` frame 的 Origin 已在协议层改写,见 `crate::protocol::pin_file_frame_origin`)。
    let frame = request.extensions().get::<RequestFrame>().cloned();
    let is_subframe = frame.as_ref().is_some_and(|frame| !frame.is_main);
    let origin = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| url::Url::parse(value).is_ok())
        .map(str::to_string);
    let frame_url = frame
        .as_ref()
        .and_then(|frame| frame.url.clone())
        .filter(|url| url::Url::parse(url).is_ok());
    let uri = match origin.or(frame_url) {
        Some(uri) => uri,
        None if is_subframe => UNATTRIBUTED_SUBFRAME_ORIGIN.to_string(),
        None => fallback_url.to_string(),
    };

    if url::Url::parse(&uri).is_err() {
        return Err(format!("CEF IPC postMessage origin is not an absolute URL: {uri}"));
    }
    // 装不进 `http::Uri` 的来源:子 frame 同样交给 ACL 拒绝,而不是回 400 让页面挂起
    let mut http_uri = http_uri_for(&uri);
    if is_subframe && http_uri.parse::<http::Uri>().is_err() {
        http_uri = UNATTRIBUTED_SUBFRAME_ORIGIN.to_string();
    }

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

    fn request(origin: Option<&str>, frame: Option<bool>) -> HttpRequest<Vec<u8>> {
        request_from(
            origin,
            frame.map(|is_main| RequestFrame {
                is_main,
                url: None,
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
        // 主 frame:没有子 frame 标识
        let rebuilt =
            post_message_request(request(Some("https://example.com"), Some(true)), APP).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Main));
        assert_eq!(subframe_id_of(&rebuilt), None);
        // 子 frame:记为 sub 并带上标识,默认 capability 不对它生效,响应送回它
        let rebuilt =
            post_message_request(request(Some("tauri://localhost"), Some(false)), APP).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub));
        assert_eq!(subframe_id_of(&rebuilt), Some(SubframeId::new("2-5")));
        // 没有 frame 信息:Unknown
        let rebuilt =
            post_message_request(request(Some("https://example.com"), None), APP).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Unknown));
        assert_eq!(subframe_id_of(&rebuilt), None);
    }

    const APP: &str = "tauri://localhost/";

    #[test]
    fn main_frame_is_accepted_with_any_origin() {
        // 畅游窗口注入脚本：主 frame，Origin 是站点源
        assert!(post_message_request(request(Some("https://example.com"), Some(true)), APP).is_ok());
    }

    /// 跨源子 frame 不再被回退通道挡住：由 ACL 按 `Sub` 判定。
    #[test]
    fn cross_origin_subframe_is_accepted_as_sub() {
        for origin in [
            "http://127.0.0.1:33050",
            "tauri://evil",
            "https://example.org",
        ] {
            let rebuilt = post_message_request(request(Some(origin), Some(false)), APP).unwrap();
            assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub), "{origin}");
            // 来源是子 frame 自己的 Origin,不会变成应用页
            assert!(!tauri_url(rebuilt).starts_with(APP), "{origin}");
        }
        // 同源子 frame 同样记为 sub
        let rebuilt =
            post_message_request(request(Some("tauri://localhost"), Some(false)), APP).unwrap();
        assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub));
    }

    /// 子 frame 没有可用的 Origin、也没有 frame URL:交给 ACL 拒绝(占位来源),不退到应用页初始 URL。
    #[test]
    fn subframe_without_origin_or_frame_url_is_rejected() {
        for origin in [None, Some("null")] {
            let rebuilt = post_message_request(request(origin, Some(false)), APP).unwrap();
            assert_eq!(ipc_frame_of(&rebuilt), Some(IpcFrame::Sub));
            assert_eq!(subframe_id_of(&rebuilt), Some(SubframeId::new("2-5")));
            assert_eq!(tauri_url(rebuilt), UNATTRIBUTED_SUBFRAME_ORIGIN);
        }
        // opaque 来源的 srcdoc iframe:用 frame URL `about:srcdoc`,Tauri 判成远程来源、ACL 拒绝
        let srcdoc = Some(RequestFrame {
            is_main: false,
            url: Some("about:srcdoc".to_string()),
            id: Some("2-7".to_string()),
        });
        let rebuilt = post_message_request(request_from(Some("null"), srcdoc), APP).unwrap();
        assert_eq!(tauri_url(rebuilt), "about:srcdoc");
        // 占位来源不是本地来源:不是应用页初始 URL 的 scheme / host
        let placeholder = url::Url::parse(UNATTRIBUTED_SUBFRAME_ORIGIN).unwrap();
        let app = url::Url::parse(APP).unwrap();
        assert_ne!(placeholder.scheme(), app.scheme());
        // 有 frame URL 时用它(sandbox iframe 的 Origin 是 null)
        let sub_at = |url: &str| {
            Some(RequestFrame {
                is_main: false,
                url: Some(url.to_string()),
                id: Some("2-6".to_string()),
            })
        };
        let rebuilt = post_message_request(
            request_from(Some("null"), sub_at("https://ads.example/x")),
            APP,
        )
        .unwrap();
        assert_eq!(tauri_url(rebuilt), "https://ads.example/x");
    }

    #[test]
    fn unknown_frame_keeps_previous_behavior() {
        assert!(post_message_request(request(Some("https://example.com"), None), APP).is_ok());
        let rebuilt = post_message_request(request(None, None), APP).unwrap();
        assert_eq!(tauri_url(rebuilt), APP);
    }

    fn main_frame_at(url: &str) -> Option<RequestFrame> {
        Some(RequestFrame {
            is_main: true,
            url: Some(url.to_string()),
            id: Some("1-1".to_string()),
        })
    }

    /// Tauri 的 `handle_ipc_message` 实际拿到的来源：`Url::parse(request.uri().to_string())`。
    fn tauri_url(request: HttpRequest<String>) -> String {
        url::Url::parse(&request.uri().to_string()).unwrap().to_string()
    }

    #[test]
    fn missing_origin_falls_back_to_frame_url() {
        const ENTRY: &str = "file:///D:/wpe/3679122549/index.html";
        // 缺 Origin、已知 frame URL：取 frame URL，不退到应用页
        let request = post_message_request(request_from(None, main_frame_at(ENTRY)), APP).unwrap();
        assert_eq!(tauri_url(request), ENTRY);
        // Origin 为 null 同理
        let request = post_message_request(request_from(Some("null"), main_frame_at(ENTRY)), APP).unwrap();
        assert_eq!(tauri_url(request), ENTRY);
        // 协议层已改写 Origin 的情形（`pin_file_frame_origin`）
        let request = post_message_request(request_from(Some(ENTRY), main_frame_at(ENTRY)), APP).unwrap();
        assert_eq!(tauri_url(request), ENTRY);
    }

    #[test]
    fn valid_origin_wins_over_frame_url() {
        let request = post_message_request(
            request_from(Some("https://example.com"), main_frame_at("https://example.com/a/b")),
            APP,
        )
        .unwrap();
        assert_eq!(tauri_url(request), "https://example.com/");
    }

    #[test]
    fn unknown_main_frame_url_falls_back_to_initial_url() {
        let request = post_message_request(request(None, Some(true)), APP).unwrap();
        assert_eq!(tauri_url(request), APP);
    }

    #[test]
    fn file_url_survives_http_uri() {
        assert_eq!(http_uri_for("file:///D:/a%20b/index.html"), "file://localhost/D:/a%20b/index.html");
        assert_eq!(http_uri_for("https://example.com/"), "https://example.com/");
        // `http::Uri` 拒绝空 authority 的原形式，能承载改写后的形式
        assert!("file:///D:/x/index.html".parse::<http::Uri>().is_err());
        assert!(http_uri_for("file:///D:/x/index.html").parse::<http::Uri>().is_ok());
    }
}
