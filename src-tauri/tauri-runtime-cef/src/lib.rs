//! # tauri-runtime-cef
//!
//! 一个面向 **Linux 桌面端** 的 Tauri CEF(Chromium Embedded Framework)
//! webview 后端。
//!
//! ## Why this exists
//!
//! Tauri uses the OS-native webview (WebView2 on Windows, WKWebView on macOS,
//! WebKitGTK on Linux). On Linux + NVIDIA, WebKitGTK is unstable: kabegame hits
//! native heap corruption (`free(): invalid pointer`) on ordinary UI
//! interactions, and gallery scrolling is not smooth. These bugs live inside
//! WebKitGTK's C++ and cannot be debugged or fixed from the Rust/JS layer, so we
//! replace the rendering engine *on Linux only* with Chromium via CEF.
//!
//! Windows already runs Chromium (WebView2) and macOS WKWebView is fine, so this
//! crate is deliberately Linux-only — see the platform gating in
//! `src-tauri/kabegame/Cargo.toml` and the kabegame entry point.
//!
//! ## What this crate is
//!
//! An **adapter**. Tauri's framework talks to its webview only through the
//! `tauri-runtime` trait set. `tauri-runtime-wry` implements those traits on top
//! of `wry`; this crate implements the *same* traits on top of `cef`
//! (tauri-apps/cef-rs). We never fork the `tauri` source — we depend on the
//! published `tauri-runtime` trait crate. See README.md.
//!
//! ```text
//!   tauri (framework)
//!        │  Runtime / WebviewDispatch / WindowDispatch traits
//!        ▼
//!   tauri-runtime-cef   ← THIS CRATE (adapter)
//!        │  calls
//!        ▼
//!   cef (cef-rs)        ← engine binding (prebuilt Chromium)
//! ```
//!
//! ## 当前状态
//!
//! 本 crate 直接实现 `tauri-runtime` 的核心 trait。Linux 上 CEF Views 创建
//! 并管理原生窗口及 GPU 组合；`kabegame` 只在 Linux standard/light 构建中依赖它。

#![allow(dead_code)]

use tauri_runtime::UserEvent;

mod runtime;
mod webview;
mod window;

// The IPC bridge (`window.ipc.postMessage` → Rust) and the custom URI scheme
// handler (`tauri://` / `asset://` serving the bundled frontend) are the two
// Tauri-specific pieces that wry hides behind one-liners but CEF needs wired up
// through its multi-process render handler.
mod ipc;
mod protocol;

/// Start a native CEF download from the webview identified by `webview_label`.
pub fn start_download(webview_label: &str, url: &str) -> Result<(), String> {
    webview::start_download(webview_label, url)
}

/// CEF 驱动的 Tauri runtime。
///
/// Linux 下应用通过 `tauri::Builder::<Cef<EventLoopMessage>>::new()` 选择这个
/// runtime,替代 Tauri 默认的 `Wry`。窗口和 webview 均由 CEF Views 管理。
#[derive(Debug)]
pub struct Cef<T: UserEvent> {
    pub(crate) inner: runtime::CefRuntime<T>,
}

/// 正在运行的 [`Cef`] runtime 的线程安全句柄。
///
/// Tauri 会在非主线程使用它投递创建窗口、创建 webview、退出请求和主线程任务。
/// CEF/tao 的实际操作仍会被转发到 runtime 主事件循环中执行。
#[derive(Debug, Clone)]
pub struct CefHandle<T: UserEvent> {
    pub(crate) context: runtime::CefContext<T>,
}

/// 向 CEF runtime 事件循环投递用户事件的代理。
///
/// 这是 `tauri_runtime::EventLoopProxy` 的 CEF 版本,把 Tauri 用户事件转换成
/// runtime 内部消息队列项。
#[derive(Debug, Clone)]
pub struct CefEventLoopProxy<T: UserEvent> {
    pub(crate) context: runtime::CefContext<T>,
}

/// 执行 CEF 多进程子进程派发,并在非 browser 进程中直接退出。
///
/// 必须在应用 `main` 的最早阶段调用,早于 Tauri `Builder`、单例检测和任何
/// 可能启动线程的初始化逻辑。CEF renderer/gpu 等子进程会通过这里进入
/// `cef::execute_process`,browser 主进程则继续执行后续应用启动流程。
pub use runtime::execute_cef_subprocess_and_exit;
