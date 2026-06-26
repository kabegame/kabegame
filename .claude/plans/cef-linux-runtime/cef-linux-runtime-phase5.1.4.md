# Phase 5.1.4 — 收敛 OSR 专属路径(输入/blit)+ webview 复核

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。前置:5.1.2/5.1.3。
>
> **目标**:windowed 模式下 CEF **原生**处理输入与呈现,因此把 Phase 3 的 OSR 输入转发、softbuffer blit、`on_paint` 收敛为 **OSR-only fallback**;复核 webview 能力在 windowed 下仍通。

## 现状锚点(windowed 下变为多余的 OSR 专属件)
- `webview.rs`:`on_paint` BGRA + `blit`(softbuffer)—— windowed 下 CEF 自己合成,不需要。
- Phase 3.2 输入转发(`handle_window_input`/`send_key_input`/mouse/wheel/IME、`GtkIMMulticontext`)—— windowed 下 CEF 原生收输入,不需要从 tao 转发。
- `RenderHandler`/`screen_info`/`view_rect` —— OSR 专属。

## 点 1 — 分流而非删除
- **修改**:用 `WindowMode` 把 OSR 输入转发 + softbuffer blit + RenderHandler **gate 到 OSR 分支**;windowed 分支 bypass(CEF Views 原生)。保留 OSR 作 fallback 编译路径。

## 点 2 — webview 能力 windowed 复核
- **核对**(多为 browser-host 级,理应沿用):`navigate`/`reload`/`eval_script(_with_callback)`/`url`/devtools(open/close/is_open)/cookies/`set_zoom`/`set_background_color`/`clear_all_browsing_data`。windowed 下逐个确认仍工作。
- **核对** `set_size`/`set_bounds`/`set_position`:windowed 下 webview 充满窗口,尺寸跟随 CEF Views 布局,不再走 OSR `was_resized` + 帧缓冲。

## 点 3 — IME / 输入法
- **核对**:windowed 下中文输入由 CEF 原生 IME 处理;确认 Phase 3.2 的 `GtkIMMulticontext` 自挂逻辑在 windowed 下**不冲突**(应只在 OSR 分支启用)。

## 验收
- windowed 下点击/滚动/键盘/中文输入由 CEF 原生处理且正常;无 OSR 残留代码被执行。
- 上述 webview 方法在 windowed 下全部可用。
- OSR fallback 仍可编译/运行(回归保护)。

## 风险
- 误删被 windowed/OSR 共用的代码;务必按 mode 分流。
- devtools 窗口在 windowed(CEF Views)下的弹出方式与 OSR 不同,需验证。

## 锚点
- `webview.rs`(`on_paint`/`blit`/输入转发/IME)。
- Phase 3.2 文档(输入转发已完成项)。

---

## 落地记录(2026-06-26)

### OSR / windowed 分流(已完成)
- `create_cef_webview` 仍是唯一创建 `OsrRenderHandler` / `OsrDisplayHandler` /
  `GtkIMMulticontext` 的入口；`create_cef_browser_view` 不创建这些 OSR 对象。
- OSR 专属操作显式收敛为 `resize_osr_webview`、`handle_osr_window_input`、
  `blit_osr_frame`。runtime 仅在 `CefWindowKind::Osr` 分支调用输入转发和
  softbuffer blit；输入函数本身也以 `webview.osr.is_none()` 防御，避免未来调用方
  向 CEF Views 重复注入 tao 输入。
- windowed 不再从 webview `SetSize` 路径调用 `BrowserHost::was_resized` 或直接
  设置 `BrowserView` 尺寸。`WindowDelegate::on_window_bounds_changed` 用 CEF
  `Window::client_area_bounds_in_screen` 布局 BrowserView，故页面随 CEF 原生窗口
  client area 变化；初始化和后加 webview 同样走该布局函数。

### Webview 能力复核
**windowed 已沿用 browser-host / frame 实现**：`navigate`、`reload`、
`eval_script`、`url`、devtools 打开/关闭/状态、`set_focus`、`set_zoom`。windowed
BrowserView 的 browser 是异步创建，因此这些调用统一经 `resolve_browser()` 延迟
取得 browser，避免创建期同步取值失败。

**Views 语义**：`set_size` / `set_bounds` 在 windowed 为 no-op（唯一 BrowserView
填满所属 CEF Window client area）；`set_position` 继续无效，符合不能把单个
BrowserView 脱离其父 Window 的约束。show/hide 直接调用 `BrowserView::set_visible`。

**既有跨模式缺口，非本次迁移引入**：cookie 读写、
`eval_script_with_callback` 的返回值、`set_background_color`、
`clear_all_browsing_data` 在 CEF runtime 的 OSR 和 windowed 路径均仍是旧的占位
实现；本阶段未把它们误记为已支持。它们需要单独接入 `RequestContext` /
`CookieManager` 和 CEF 异步回调，避免在 windowed UI 线程上同步等待造成死锁。

### 验收边界
- 代码级验收：windowed 不会执行 OSR render handler、softbuffer blit、tao 输入或
  GTK IME；窗口 resize 由 CEF Views 原生布局保持 BrowserView 填充。
- 交互式验收仍需在实际桌面会话确认：点击、滚动、键盘和中文输入均由 CEF 原生
  GTK/IME 处理。cookie 等既有 trait 缺口不属于 OSR→Views 分流验收，另开能力补齐。
