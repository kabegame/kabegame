# ✅ Phase 3.1 — 自定义协议 + init script(serve 打包前端 + 注入 Tauri 内核)

> 父:[phase3](cef-linux-runtime-phase3.md)。前置:Runtime/Window/Webview 骨架已落地(见 phase3 落地记录)。
>
> **目标**:让 CEF 能加载 **Tauri 打包前端**(`tauri://localhost` / `asset://`,非仅 dev 的 Vite devUrl),并在页面注入 Tauri 的 initialization scripts(`window.__TAURI_INTERNALS__` 等),为 Phase 4 IPC 铺路。

## 现状锚点

**a. 协议未实现**(`src/protocol.rs`,占位)
```rust
//! `data:` URL directly, so no scheme handler is needed yet.   // 现状:6 行占位
```
**b. 直接 load_url**(`src/runtime.rs:969`)
```rust
frame.load_url(Some(&CefString::from(url.as_str())));  // 现状:dev 靠 Vite devUrl,production 没法加载内置前端
```
**c. 无 render process handler / 无 init script 注入**(`App` 未实现 `render_process_handler`)。

## 点 1 — 注册自定义 scheme(`runtime.rs` 的 App)
- **修改** App:实现 `on_register_custom_schemes`,把 `tauri`(及 `use_https_scheme` 时的 `https`)注册为 standard + secure + fetch/CORS enabled。
  > CEF 要求自定义 scheme 在所有进程的此回调里声明,否则 fetch/XHR/CORS 行为不对。

## 点 2 — scheme handler factory(`protocol.rs`)
- **新增** `CefSchemeHandlerFactory`(`wrap_scheme_handler_factory!`)+ 异步 `CefResourceHandler`(`wrap_resource_handler!`)。
  - 在 `initialize` 后用 `register_scheme_handler_factory("tauri", "localhost", factory)`(asset:// 同理)。
  - factory 收到请求 → 调 Tauri 经 `PendingWebview` 暴露的自定义协议 handler(`uri_scheme_protocols` / `web_resource_request`,**对照 `tauri-runtime` 实际字段**)→ 把响应(status / MIME / headers / body)回流给 `CefResourceHandler`(支持异步 read、Range,见 phase3 风险)。
- **修改** `runtime.rs` create_webview:production(无 devUrl)时 `load_url("tauri://localhost/")`,dev 仍走 devUrl。

## 点 3 — init script 注入
- **最小实现(browser 进程侧)**:在 main frame 的 load start(或 `OnLoadStart`)用 `frame.execute_java_script` 注入 `PendingWebview.webview_attributes` 里的 initialization scripts。简单、单进程即可,够 bootstrap。
- **精确实现(后续)**:App 实现 `render_process_handler` → `wrap_render_process_handler!` 的 `on_context_created` 注入(更早、每 frame)。跨进程把脚本传到 render:`on_browser_created`/process message,或 dump 到 extra_info。
  > 取舍:3.1 先做 browser 侧 `execute_java_script` 跑通;render-process 注入列为优化项。

## 验收
- production 模式 CEF 加载 kabegame 打包前端(不依赖 Vite)。
- 页面中 `window.__TAURI_INTERNALS__` 存在(IPC 真正通仍归 Phase 4)。

## 风险
- ResourceHandler 异步流式 + Range(大图/视频)。
- scheme 的 secure/standard 标志影响 CORS / service worker。
- init script 时机:browser-side execute_java_script 可能晚于个别早期脚本;必要时升级到 render-process 注入。

## 锚点(CEF API)
- `register_scheme_handler_factory`、`wrap_scheme_handler_factory!`、`wrap_resource_handler!`、`App::on_register_custom_schemes`
- `Frame::execute_java_script` / `load_url`;`App::render_process_handler` + `wrap_render_process_handler!`(`on_context_created`)

## 落地记录(2026-06-24)

已完成:

- `CefRuntimeApp::on_register_custom_schemes` 在所有 CEF 进程初始化前声明
  `tauri` / `asset` / `ipc`,标记为 standard、secure、CORS enabled、fetch enabled。
- `protocol.rs` 已实现 `CefSchemeHandlerFactory` + `CefResourceHandler`:
  - 把 CEF URL/method/headers/POST bytes 转成 `http::Request<Vec<u8>>`;
  - 直接消费 Tauri 2.11.2 的 `PendingWebview.uri_scheme_protocols`,不重复实现
    打包资源查找或 asset scope;
  - 同时支持 handler 同步响应和异步 responder,避免在 `open` 内重入
    `Callback::cont`;
  - 回流 status/status text/MIME/charset/headers/body,按块读取 body;
  - Range 请求由 Tauri 原 handler 处理,CEF 层保留 `206`、
    `Content-Range` 等响应并流式输出对应 body。
- `create_cef_webview` 在创建 browser 前注册该 webview 的协议 factory;production
  URL 继续使用 Tauri 已解析的 `pending.url`(`tauri://localhost`),dev URL 不改写。
- 新增 browser-process `LoadHandler::on_load_start`,按
  `InitializationScript.for_main_frame_only` 语义向每次 frame 导航注入初始化脚本。

验证:

- `cargo check -p tauri-runtime-cef --all-targets --features cef-backend` 通过。
- 精确的 render-process `on_context_created` document-start 注入仍按本计划原取舍保留为
  后续优化;当前 browser-process 注入满足 Phase 3.1 的最小实现边界。
- CEF scheme factory 当前属于 global request context,与 Phase 3 的
  单窗口/单 webview 目标一致;多 webview 同 scheme 隔离需迁移到独立
  `RequestContext`,列入后续技术债务。
