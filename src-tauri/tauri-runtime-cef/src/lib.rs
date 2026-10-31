//! # tauri-runtime-cef
//!
//! 一个面向 **桌面端** 的 Tauri CEF(Chromium Embedded Framework)
//! webview 后端。
//!
//! ## Why this exists
//!
//! Tauri uses the OS-native webview (WebView2 on Windows, WKWebView on macOS,
//! WebKitGTK on Linux). On Linux + NVIDIA, WebKitGTK is unstable: kabegame hits
//! native heap corruption (`free(): invalid pointer`) on ordinary UI
//! interactions, and gallery scrolling is not smooth. These bugs live inside
//! WebKitGTK's C++ and cannot be debugged or fixed from the Rust/JS layer, so we
//! use Chromium via CEF as the desktop rendering engine.
//!
//! See the platform gating in `src-tauri/kabegame/Cargo.toml` and the kabegame
//! entry point.
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
//! 本 crate 直接实现 `tauri-runtime` 的核心 trait。Windows/macOS/Linux 上
//! CEF Views 创建并管理原生窗口及 GPU 组合；`kabegame` 的桌面 standard 构建依赖它。

#![allow(dead_code)]

use tauri_runtime::UserEvent;

#[cfg(target_os = "macos")]
mod app_mac;
mod file_access;
mod runtime;
mod subprocess;
mod webview;
mod window;

// The IPC bridge (`window.ipc.postMessage` → Rust) and the custom URI scheme
// handler (`tauri://` serving the bundled frontend) are the two
// Tauri-specific pieces that wry hides behind one-liners but CEF needs wired up
// through its multi-process render handler.
mod ipc;
mod protocol;

/// Start a native CEF download from the webview identified by `webview_label`.
pub fn start_download(webview_label: &str, url: &str) -> Result<(), String> {
    webview::start_download(webview_label, url)
}

// ---- 文件访问：两项能力 + 应用 origin 跨源白名单 + 按发起 frame 分档的闸门 ----
//
// 应用在建窗前按 label 登记能力，再按需设置允许的根目录。两项能力都写进建 browser 时的
// `extra_info`，由 CEF 补丁只给这个 browser 打开：
// - 文件文档（`kabegame.allow_file_access_from_file_urls`，补丁 0004）：`file://` 页面可以
//   `fetch` / XHR 读本地文件（WPE 网页壁纸读同目录文件）；
// - 应用页加载本地资源（`kabegame.allow_local_resources`，补丁 0005 + 0006）：最外层主 frame 里的
//   非 `file:` 文档可以给 `<iframe>` 赋 `src = file:…`（WPE 预览，0005），也可以用 `<img>` / `<video>`
//   / CSS `url()` 加载 `file:` 子资源（图库媒体，0006 补上子资源工厂）；应用页 `fetch(file:)` 还需 0006 私有 CORS 列表和运行时跨源白名单。
// 补丁只开门；登记了任一能力的 label 的 `file:` 请求按发起 frame 分档：应用页主 frame 的子资源在登记
// 了 0005 时免检，子 frame / 主 frame 的导航与 `file:` 文档的子资源在 `OnBeforeResourceLoad` 里过目录闸门。
// `file:` 文档照常注入初始化脚本（Tauri 自身脚本只进主 frame）；IPC 来源在协议层按 frame URL
// 判成远程 `file:`，权限由应用的 ACL 限定。

/// 建窗前给 `webview_label` 登记「文件文档」能力：该 label 的 browser 在 `extra_info` 里带
/// `kabegame.allow_file_access_from_file_urls = true`（CEF 补丁 0004 据此打开文件访问偏好），
/// 并启用 `file:` 目录闸门；初始根目录为空（拒绝所有 `file:` 请求）。
pub fn allow_file_documents(webview_label: &str) {
    file_access::allow_file_documents(webview_label)
}

/// 建窗前给 `webview_label` 登记「应用页加载本地资源」能力：该 label 的 browser 在 `extra_info`
/// 里带 `kabegame.allow_local_resources = true`，CEF 补丁 0005 据此让最外层主 frame 的非 `file:`
/// 文档能加载 `file:`（渲染侧放过 `CanDisplay`，浏览器侧给所在进程 `file` 请求权；弹窗里提交的文档、
/// 子 frame 不授，弹窗的初始 `about:blank` 按 Blink 规则从 opener 继承但仍过同一闸门）。0005 只放开显示与
/// 导航；CEF 补丁 0006 再给同一主 frame 塞带私有 CORS 列表的 `file:` 子资源工厂，运行时为应用 origin
/// 登记跨源白名单，让 `<img>` / `<video>` 与 `fetch(file:)` 都能读取。同时表示该 label 的应用页（主 frame
/// 非 `file:` 文档）发起的 `file:` 子资源**不过目录闸门**；子 frame
/// 导航与 `file:` 文档的请求仍按根目录。同样启用 `file:` 目录闸门；初始根目录为空。
pub fn allow_app_local_resources(webview_label: &str) {
    file_access::allow_app_local_resources(webview_label)
}

/// 设置 / 清空 `webview_label` 允许的根目录（子 frame 导航与 `file:` 文档的请求按它裁决）。`Some(dir)`
/// 只放行 `dir` 内的普通文件（拒绝越界、符号链接、目录、不存在）；`None` 拒绝这类请求。应用页主 frame
/// 的免检子资源不看根目录。未登记的 label 返回 Err。
pub fn set_file_document_root(
    webview_label: &str,
    root: Option<std::path::PathBuf>,
) -> Result<(), String> {
    file_access::set_file_document_root(webview_label, root)
}

/// 只给嵌入方放行用户为当前页面选的文件或目录；当前根不匹配时忽略。
pub fn grant_file_documents(
    webview_label: &str,
    for_root: &std::path::Path,
    paths: &[std::path::PathBuf],
) -> Result<(), String> {
    file_access::grant_file_documents(webview_label, for_root, paths)
}

// ---- 鼠标注入 ----

/// 注入到 webview 的鼠标事件；坐标是视图坐标（DIP，相对 browser 视图左上角）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseInjection {
    /// 移动（`send_mouse_move_event`）。不带按键标志，页面里不会启动拖放 / 拖选（同 WE）。
    Move { x: i32, y: i32 },
    /// 离开视图（`send_mouse_move_event(mouse_leave = 1)`）。
    Leave { x: i32, y: i32 },
    /// 左键按下（`send_mouse_click_event(LEFT, up = 0, click_count = 1)`）。
    LeftDown { x: i32, y: i32 },
    /// 左键抬起（`send_mouse_click_event(LEFT, up = 1, click_count = 1)`）。
    LeftUp { x: i32, y: i32 },
}

/// 经 `CefBrowserHost::SendMouse*Event` 向 `webview_label` 注入鼠标事件。
///
/// 直接进 Chromium 输入管线，不依赖窗口焦点与 Z 序；只投递到 CEF UI 线程、不等回执，
/// 找不到 browser 时静默返回 `Ok`。投递失败（CEF 未运行）返回 Err。
pub fn inject_mouse(webview_label: &str, input: MouseInjection) -> Result<(), String> {
    webview::inject_mouse(webview_label, input)
}

/// CEF 驱动的 Tauri runtime。
///
/// 桌面应用通过 `tauri::Builder::<Cef<EventLoopMessage>>::new()` 选择这个
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

/// 在 Tauri 启动前初始化 CEF browser 主进程。
pub use runtime::dispatch_cef_subprocess;

/// 运行 CEF renderer/GPU/utility 子进程；仅供独立 helper binary 调用。
pub use runtime::run_cef_subprocess;

/// 为 macOS 裸 executable 准备与 helper bundle id 一致的最小 main bundle。
#[cfg(target_os = "macos")]
pub use runtime::macos_unbundled_main_bundle;

/// 本进程实际启用的 CDP 远程调试端口(dev-only;未启用时 `None`)。
///
/// `KABEGAME_CEF_DEBUG_PORT=random` 时是内核分配的随机号,已 memoize,与
/// `CefSettings::remote_debugging_port` 是同一个值。app crate 用它把端口上报给
/// vite dev server,供 `.claude/skills/kabegame-chromium/` 发现。
pub use runtime::remote_debugging_port;

/// 注册「已有实例被第二个实例拉起」(Chrome ProcessSingleton relaunch)的处理器。
///
/// runtime 恒拦截 Chrome 默认的「在本进程弹一个浏览器窗口」;app 通过此处理器把
/// 这次拉起转成显示主窗口等应用语义。回调参数为发起方的完整 argv。
pub use runtime::set_already_running_app_relaunch_handler;

/// 注册把 `(webview_label, image_id)` 解析为已授权本地文件的拖拽导出回调。
pub use runtime::set_drag_file_resolver;
