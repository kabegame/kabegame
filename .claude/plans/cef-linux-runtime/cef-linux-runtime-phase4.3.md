# Phase 4.3 — IPC 往返打通(invoke ↔ command)

> 父:[phase4](cef-linux-runtime-phase4.md)。前置:4.2(命令/handler 已挂上)。
>
> **目标**:前端 `window.__TAURI_INTERNALS__.invoke(...)` 能命中 Rust 命令并拿到返回。

## 现状锚点
- 3.1 已注册 `ipc` scheme,`protocol.rs` 把请求转 `http::Request` 后调 `PendingWebview.uri_scheme_protocols` 对应 handler。
- `ipc.rs` 仍占位。
- Tauri IPC 双通道:`PendingWebview.ipc_handler`(postMessage 风格)与 Tauri `ipc/protocol.rs`(`ipc://localhost` POST,`Tauri-Invoke-Key` header)。wry 主要用 `ipc_handler`。

## 点 0 — 先判定 Tauri 给我们走哪条(关键调查)
- **核对**:build/create_webview 时,Tauri 是否把 IPC 放进了 `pending.uri_scheme_protocols`(键 `ipc`),还是只设了 `pending.ipc_handler`?
  - 看 `pending.uri_scheme_protocols.keys()` 是否含 `ipc`;看 `pending.ipc_handler.is_some()`。
  - 在 `runtime.rs::create_cef_webview` 打印一次即可判定。
- 据此二选一(点 1A / 1B)。

## 点 1A — 若走 `ipc://` 自定义协议(优先,3.1 基本已覆盖)
- **核对** `protocol.rs` 是否已对 `ipc` scheme 注册 factory(目前对 webview 的 `uri_scheme_protocols` 都注册了吗?还是只注册了 tauri/asset?)。
- **修改/补全**:确保 `ipc` 的请求(POST + body + `Tauri-Invoke-Key`/`Tauri-Callback`/`Tauri-Error` headers)完整透传给 handler,响应(命令结果 JSON)回流。
- init script 确认 `__TAURI_INTERNALS__.invoke` 选用了自定义协议路径(Tauri 内核根据环境自动选;CEF 需让它认为支持)。

## 点 1B — 若走 `ipc_handler`(postMessage 风格)
- **新增** `ipc.rs`:render 进程注入 `window.ipc.postMessage` → 经 CEF(`window.cefQuery` / process message)→ browser 进程 → 调 `pending.ipc_handler(request)`。
- **回包**:命令结果经 `frame.execute_java_script("window.__TAURI_INTERNALS__.runCallback(...)")` 注回页面(格式见 `tauri/src/ipc/format_callback.rs`)。
- 需要 render-process handler(3.1 推迟的那块)来注入 binding。

## 点 2 — 打通后冒烟
- **验证** 一个无副作用命令(如 `get_supported_image_types` / `plugin:pathes|…`)`invoke` 成功返回。
- **验证** 带参数 + 返回结构体的命令;错误路径(reject)。

## 验收
- 前端 `invoke('某命令')` resolve 出正确结果;reject 能抛错。
- 画廊/设置首批命令通(数据能拉到)。

## 风险
- **`Tauri-Invoke-Key`**:Tauri 2 校验该 header,CEF 路径必须原样透传,否则命令被拒。
- 大 payload / 二进制(`ArrayBuffer`)经协议或 postMessage 的编码。
- Channel(`__TAURI_CHANNEL__`)与事件(`emit`)方向(事件回推可能 4.4 再补)。
- init script 注入时机(document-start)影响 `__TAURI_INTERNALS__` 是否在前端脚本前就绪(3.1 的 browser-side 注入可能需升级到 render-process)。

## 锚点
- `tauri-runtime/src/webview.rs`(`ipc_handler` / `uri_scheme_protocols`)
- `tauri/src/ipc/protocol.rs`(`Tauri-Invoke-Key`)、`format_callback.rs`(`runCallback`)
- `tauri-runtime-wry/src/lib.rs:~4588`(`ipc_handler` 接法)

## 完成记录(2026-06-25)

- 判定结果:Tauri 2.11 在 `prepare_pending_webview` 后同时存在 `uri_scheme_protocols` 与 `ipc_handler`;命令 IPC 前端优先走 `fetch(ipc://localhost/<cmd>)`,失败后降级 `window.ipc.postMessage(...)`。
- 主路径:保留并确认 `protocol.rs` 注册 `pending.uri_scheme_protocols` 的全部 scheme,`ipc://` POST/body/header 原样转 `http::Request<Vec<u8>>` 给 Tauri IPC protocol handler,`Tauri-Invoke-Key` 等 header 不做重写。
- 后备路径:新增 `src-tauri/tauri-runtime-cef/src/ipc.rs` 的 `cef-ipc://` bridge,在 webview 初始化脚本中提供 `window.ipc.postMessage`,再把 JSON body 转成 `http::Request<String>` 调 `pending.ipc_handler`。回包仍由 Tauri handler 通过 `webview.eval(...)` 调 `runCallback`。
- 诊断:在 `create_cef_webview` 打印一次 `protocols=[...]` 与 `ipc_handler=true/false`,方便运行期确认实际 IPC 形态。
- 验证:
  - `cargo check -p tauri-runtime-cef --features cef-backend`
  - `FFMPEG_PKG_CONFIG_PATH=/home/cm/code/kabegame/third/FFmpeg-build/install/lib/pkgconfig cargo check -p kabegame --features standard`
