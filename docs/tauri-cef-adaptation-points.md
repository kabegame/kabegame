# Tauri 接入 CEF 的适配点

基于工作区中 `tauri-tauri-v2.10.0` 源码梳理：若要在 Tauri 中接入 Chromium（CEF）替代当前 Wry/WebKit2GTK，需要动到的层次与具体位置。

---

## 1. 整体架构（当前）

```
tauri (应用层，泛型 Runtime)
    ↓
tauri-runtime (抽象：Runtime / RuntimeHandle / WebviewDispatch / WindowDispatch)
    ↓
tauri-runtime-wry (具体实现：Wry + tao + 各平台 WebView)
    ↓
  - Windows: wry → WebView2
  - macOS:   wry → WKWebView
  - Linux:   wry → webkit2gtk + tao + gtk
```

接入 CEF 时，**不改变** `tauri` 和 `tauri-runtime` 的抽象；**新增或替换**一层“运行时实现”，在 Linux（以及可选 Windows/macOS）上用 CEF 实现同一套 trait。

---

## 2. 必须实现的抽象（tauri-runtime）

所有适配都围绕实现 `tauri-runtime` 里这些接口（见 `crates/tauri-runtime/src/lib.rs`）：

| 接口 | 作用 | CEF 侧需要做的事 |
|------|------|------------------|
| **Runtime\<T>** | 事件循环、创建窗口/WebView、monitor、主题等 | 用 CEF 的 message loop 或与 tao 协同；`create_webview` 里建 CEF browser |
| **RuntimeHandle\<T>** | 线程安全句柄：`create_window`、`create_webview`、`run_on_main_thread`、`request_exit` 等 | 转发到 CEF/窗口所在线程 |
| **WindowDispatch\<T>** | 窗口 API：位置、大小、标题、焦点、图标、进度条、光标、拖拽等 | 若窗口仍用 tao，则大部分沿用；若用 CEF 窗口，需用 CEF/系统 API 实现 |
| **WebviewDispatch\<T>** | WebView API：url、navigate、eval_script、cookies、bounds、zoom、devtools 等 | 全部映射到 CEF 的 CefBrowser / CefFrame / CefRequest 等 |
| **PendingWebview / DetachedWebview** | 构建参数与创建结果 | 构造时填 CEF 所需参数；返回的 dispatcher 内部持 CefBrowser 等 |

也就是说：**CEF 适配 = 新写一个 “tauri-runtime-cef” 或给 tauri-runtime-wry 加 `cef` feature，实现上述 trait，并把所有“当前调 wry/WebKit2/WebView2 的地方”改成调 CEF。**

---

## 3. 具体适配点（按 crate / 文件）

### 3.1 tauri-runtime（抽象层）

- **`crates/tauri-runtime/src/webview.rs`**
  - **NewWindowOpener**：当前按平台是 `webkit2gtk::WebView`（Linux）、WebView2（Windows）、WKWebView（macOS）。  
    CEF 需新增或条件编译：如 `CefBrowser` + 可选 `CefBrowserHost` 的句柄，用于 `new_window_handler` 里“在已有窗口上创建新 webview”或传给新窗口。
  - **DownloadEvent**、**PendingWebview**（含 `download_handler`、`uri_scheme_protocols`、`navigation_handler`、`new_window_handler` 等）：  
    类型可保持；CEF 在实现层把这些回调用 CEF 的下载、自定义协议、导航、新窗口 API 接上即可。

### 3.2 tauri-runtime-wry（当前实现层，可作参考）

- **`crates/tauri-runtime-wry/src/lib.rs`**
  - **create_webview**（约 4556 行起）：当前用 `WebViewBuilder::new_with_web_context()` 再按平台配置。  
    CEF：改为 CefBrowserHost::CreateBrowser / CreateBrowserSync，或 CEF 提供的封装；窗口句柄从 tao 的 `RawWindow` 取（Linux 下即 X11/Wayland 的 window）。
  - **WebViewBuilder 链式调用**：  
    - url、透明、焦点、incognito、clipboard、zoom、user_agent、proxy、bounds、ipc_handler → 对应 CEF 的 settings、request context、life span handler 等。  
    - **navigation_handler** → CEF `CefRequestHandler::OnBeforeBrowse` 等。  
    - **new_window_handler** → CEF `CefLifeSpanHandler::OnBeforePopup`，需要能创建新窗口或新 CefBrowser 并和 Tauri 的 window 映射起来。  
    - **download_handler** → CEF `CefDownloadHandler::OnBeforeDownload` / `OnDownloadUpdated`。  
    - **uri_scheme_protocols** → CEF `CefRegisterSchemeHandlerFactory` + `CefResourceHandler`。  
    - **on_page_load_handler** → CEF `CefLoadHandler::OnLoadStart`/`OnLoadEnd`。  
  - **IPC**：当前 wry 用 `with_ipc_handler` 收前端消息；CEF 需用 CEF 的 JS 与 native 通信（如 `ExecuteJavaScript` + `CefV8Context`，或 `CefProcessMessage` + 自定义 protocol）。

- **`crates/tauri-runtime-wry/src/webview.rs`**
  - Linux 下 `pub type Webview = webkit2gtk::WebView`。  
    CEF：改为 CEF 的 Webview 句柄类型（如 `Rc<CefBrowser>` 或自定义 wrapper），所有 `WebviewDispatch` 实现都基于该类型调 CEF API。

- **`crates/tauri-runtime-wry/src/window/linux.rs`**
  - 当前用 tao 的 window + `WindowExtUnix::gtk_window()`。  
    CEF：若继续用 tao 做窗口，只需把 CEF 的 view 嵌到 tao 的 window 里（通过 raw window handle）；若用 CEF 自己的窗口，需要实现 `WindowDispatch` 的 Linux 分支（位置、大小、标题等）用 CEF/GTK/X11 实现。

- **`crates/tauri-runtime-wry/src/undecorated_resizing.rs`**
  - Linux 下用 `webkit2gtk::WebView` + gtk 事件做无边框拖拽。  
    CEF：改为用 CEF 的 browser 或宿主窗口的鼠标事件做同样的拖拽/resize 逻辑。

- **依赖（Cargo.toml）**
  - Linux：当前 `wry` + `tao` + `webkit2gtk` + `gtk`。  
    CEF：去掉（或 feature 关掉）`webkit2gtk`，增加 `cef-sys` 或上游的 `libcef` 绑定；窗口可继续用 `tao` 或完全用 CEF 的 host window。

### 3.3 tauri（主 crate）

- **`crates/tauri/src/lib.rs`**
  - 当前：`pub type Wry = tauri_runtime_wry::Wry<EventLoopMessage>`；默认 feature 带 `wry`。  
  - CEF：新增 feature `cef`，例如 `pub type Cef = tauri_runtime_cef::Cef<EventLoopMessage>`，并在 `Builder` 里按 feature 选择 `Wry` 或 `Cef` 作为泛型 Runtime。

- **`crates/tauri/Cargo.toml`**
  - 当前：`wry = ["webview2-com", "webkit2gtk", "tauri-runtime-wry"]`。  
  - CEF：增加 `cef = ["tauri-runtime-cef"]`（或 `tauri-runtime-wry?/cef`），与 `wry` 二选一或按平台选。

应用层（如 kabegame）只需在依赖里选 `features = ["cef"]` 并保证入口用 CEF 的 Runtime 类型即可，无需改 Tauri 上层业务代码。

---

## 4. Linux 特有注意点

1. **窗口与句柄**  
   tao 在 Linux 上提供 `RawWindow`（含 `gtk_window` / `default_vbox`），CEF 需要 X11/Wayland 的 window handle 才能嵌入。若用 tao，可从 gtk 取 `gdk_x11_window_get_xid` 或 Wayland 的 surface；若用 CEF 的 CefWindowInfo，需与 tao 的 window 一致，避免重复创建顶层窗口。

2. **事件循环**  
   ​​当前是 tao 的 `EventLoop::run` 驱动；CEF 有 `CefDoMessageLoopWork` 或 `CefRunMessageLoop`。常见做法是：主循环用 tao，每帧或定时器里调一次 `CefDoMessageLoopWork`，或把 CEF 消息循环跑在单独线程（需注意 CEF 的线程模型）。

3. **NewWindowOpener / related_view**  
   Linux 上 wry 用 `webkit2gtk::WebView` 的 related_view 做新窗口父子关系。CEF 需用 CEF 的 opener 信息（如 parent window、opener browser）在 `OnBeforePopup` 里建新 CefBrowser 并挂到 Tauri 的 window 上。

4. **NVIDIA / EGL**  
   当前 WebKit2GTK 有 DMA-BUF 的 workaround；CEF 用 Chromium 的 GPU 栈，一般不再需要 `WEBKIT_DISABLE_DMABUF_RENDERER`，但需确认 CEF 在 Linux 上的 GPU 加速与无头/软件渲染选项。

---

## 5. 建议实现顺序

1. **新 crate：tauri-runtime-cef**（或 wry 的 `feature = "cef"`）  
   - 只做 **Linux**：实现 `Runtime`、`RuntimeHandle`、`WindowDispatch`、`WebviewDispatch`，内部用 tao 建窗口 + CEF 建 browser 并嵌入。
2. **最小闭环**：一个窗口、一个 webview、能 loadUrl、能 eval_script、能收一条 IPC，不接下载/自定义协议/新窗口。
3. **再补**：download、custom protocol、new_window、cookies、devtools 等，对应 tauri-runtime 的 `PendingWebview` 里各项 handler。
4. **最后**：在 tauri 主 crate 里加 `cef` feature 和 `Cef` 类型，并文档说明与 wry 二选一。

官方实验分支 `feat/cef` 可对照上述点看他们当前做到哪一步、Linux 是否已实现窗口+webview 创建与事件循环集成。
