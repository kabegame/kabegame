# Phase 5.1.2 — Tauri `create_window` / `create_webview` → CEF Views

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。前置:5.1.1(windowed 骨架可起 CEF Views 窗口)。
>
> **目标**:让 `tauri::Builder::<Cef>` 的 `create_window` / `create_webview` 在 windowed 模式下创建 **CEF Views Window + BrowserView**(而非 tao 窗口 + OSR browser),IPC/protocol/init-script 沿用 Phase 3/4 成果。

## 现状锚点
**a. 窗口创建走 tao**(`window.rs build_tao_window`;`runtime.rs:792 create_window`)。
**b. webview 走 OSR**(`runtime.rs create_webview_now` → windowless browser + RenderHandler)。
**c. 窗口表按 tao id**(`runtime.rs:152 CefWindowIdMap(BTreeMap<tao::window::WindowId, WindowId>)`)。
**d. 已有可复用件**:`protocol.rs`(scheme factory)、`ipc.rs`(post-message bridge)、`LoadHandler::on_load_start`(init script 注入)、`LifeSpanHandler`(见 minimal_windowed)。

## 点 1 — create_window → CEF Views Window
- **修改**:windowed 分支用 `window_create_top_level(WindowDelegate)`(`preferred_size`/`on_window_created`/`can_close`/`on_window_destroyed`/`window_runtime_style`),从 `PendingWindow` 的 size/title/decorations 等初始化。
- **新增** `LifeSpanHandler`(`on_after_created`/`on_before_close`):登记 browser、关窗驱动 quit/事件。
- **完成**:`create_window_now` 在 `KABEGAME_CEF_WINDOW_MODE=windowed` 下创建 CEF Views `Window`;OSR 模式继续走 tao。
- **完成**:固定 URL bootstrap 改为仅 `KABEGAME_CEF_WINDOWED_BOOTSTRAP=1` 时启用,默认不再额外弹 example.com。

## 点 2 — create_webview → BrowserView
- **修改**:`browser_view_create(client, url, settings, …)` 挂进窗口的 view(`window.add_child_view`,见 minimal_windowed `on_window_created`)。
- **复用**:client 继续挂 `protocol.rs` 的 scheme factory(production `tauri://localhost`)、`ipc.rs` bridge、init-script `LoadHandler`;**不再**挂 OSR `RenderHandler`。
- **完成**:`webview.rs` 新增 `create_cef_browser_view`;复用 protocol / ipc / `InitializationLoadHandler`,不挂 OSR `RenderHandler`。
- **完成**:`create_webview_now` 在 windowed 模式下把 `BrowserView` 挂到 CEF `Window`。

## 点 3 — 窗口/ webview id 映射改造
- **修改** `CefWindowIdMap` 等状态表:键从 `tao::window::WindowId` 改为 CEF `Window`/`Browser` 标识(browser identifier);dispatcher 通过该表找到对应 CEF 对象。
- **完成(最小版)**:`CefWindowState` 拆为 `Osr` / `Windowed`;windowed state 保存 CEF `Window` / `BrowserView` 共享状态和 Tauri window id。tao id map 仍只服务 OSR tao 事件,windowed 不依赖 tao event id。

## 点 4 — runtime_style
- **确认**:`window_runtime_style` / `browser_runtime_style` 用 **Alloy**(无浏览器外壳),不是默认 Chrome runtime(避免出现标签栏/地址栏,见 README §窗口机制)。
- **完成**:windowed `WindowDelegate` 与 `BrowserViewDelegate` 均返回 `RuntimeStyle::ALLOY`。

## 完成记录(2026-06-26)
- `src-tauri/tauri-runtime-cef/src/runtime.rs`
  - `create_window_now` / `create_webview_now` 按 `WindowMode` 分流。
  - 新增 windowed window state,基础 getter/setter 覆盖 title/size/show/hide/close/focus/fullscreen/maximize/minimize/always_on_top。
  - windowed `run_loop` 保留 tao `run_return` 消费 `EventLoopProxy` 消息,同时每轮泵 GLib + CEF。
  - CEF Views 创建前等待 `BrowserProcessHandler::on_context_initialized`;否则 `create_window` 阶段太早会导致 windowed 主窗口不显示。
  - `window_create_top_level` 返回后同步保存 CEF `Window`、attach `BrowserView`、设置初始大小并显式 `show`,避免完全依赖 `on_window_created` 回调时序导致主窗口不 materialize。
  - OSR path 保留 tao window + OSR browser + softbuffer blit。
- `src-tauri/tauri-runtime-cef/src/webview.rs`
  - 新增 `ViewsClient` / `ViewsBrowserViewDelegate` / `create_cef_browser_view`。
  - `CefWebviewState` 可表示 OSR 或 BrowserView;windowed 不再需要 OSR frame/input/surface。
- 验证:
  ```sh
  cargo fmt -p tauri-runtime-cef
  env CEF_PATH=/home/cm/.local/share/cef cargo check -p tauri-runtime-cef --features cef-backend
  ```
  通过;仅余既有 `protocol.rs` macro unused warning。

## 当前边界
- windowed 的完整 `WindowDispatch` 映射尚未完成,5.1.3 继续补齐降级矩阵。
- 未做 GUI smoke;需要交互式运行:
  ```sh
  CEF_PATH=/home/cm/.local/share/cef \
  LD_LIBRARY_PATH=/home/cm/.local/share/cef:$LD_LIBRARY_PATH \
  KABEGAME_CEF_WINDOW_MODE=windowed \
  bun dev -c kabegame
  ```

## 验收
- `tauri::Builder::<Cef>::…build().run()` 在 windowed 模式弹出**无外壳** CEF 窗口、GPU 渲染 kabegame 前端;IPC(invoke)、protocol(`tauri://`)、init-script(`__TAURI_INTERNALS__`)全部仍通。

## 风险
- Tauri 期望的"窗口 + 内嵌 webview"模型 vs CEF Views"Window 持有 BrowserView"的映射;一窗一 view 先行。
- `PendingWindow`/`PendingWebview` 的属性(透明/装饰/初始尺寸)到 CEF Views 的对应度。

## 锚点
- `examples/minimal_windowed.rs`(Window/BrowserView/LifeSpanHandler 全套)。
- `runtime.rs:152/792`、`create_webview_now`;`protocol.rs`、`ipc.rs`。
