# Phase 5.1.6 — windowed 路径彻底弃用 tao(OSR 的 tao 保留)

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。修 5.1.2 的"启动卡 10s + 无窗口"根因,并落实 5.1 点 1「纯 CEF/GLib runtime loop」。
>
> **范围(2026-06-26 定)**:**只对 windowed(CEF Views)路径弃用 tao**——改纯 CEF + GLib pump,所有 CEF Views 创建经 `post_task(ThreadId::UI)`。**OSR 模式的 tao 事件循环 / tao 窗口 / softbuffer 原样保留**作 fallback。

## 根因(已定位)
`run_windowed_loop` 仍用 **tao `run_return`** 当主循环,`create_window` 经 `Event::UserEvent` → `handle_message` → 在 **tao 的 GTK 回调里同步调 `window_create_top_level` / `browser_view_create`**。CEF Views 建窗口要求 CEF 消息循环在调用过程中被泵,但本轮 `do_message_loop_work()` 排在回调之后 → 互等 → 卡死(日志:webview IPC 行之后既无 "window created and attached" 也无 "failed",仅 10×10 占位窗)。对照:bootstrap 在 `on_context_initialized`(CEF `do_message_loop_work` 上下文)里建窗口 → 成功。深层是 **tao 的 GTK loop 与 CEF 自带 GTK/X11 集成抢同一 GLib 上下文**。

## tao → CEF 替换矩阵(仅 windowed)

| 现状(windowed 误用 tao) | 替代 |
|---|---|
| `run_windowed_loop` = tao `run_return` + 手动 pump(`runtime.rs:1615`) | 纯 CEF/GLib pump:`loop { drain_msgs(); pump_glib(); do_message_loop_work(); idle?sleep(1ms) }`(照 `minimal_windowed::run_external_pump`) |
| Message 投递 = tao `EventLoopProxy<Message<T>>` + `Event::UserEvent` | **线程安全队列**(`Mutex<VecDeque<Message<T>>>` 或 `mpsc`)挂在 `CefContext`;`CefEventLoopProxy::send_event` / `CefContext::send` push 之 |
| `RunEvent::{Ready,MainEventsCleared,UserEvent,Exit}` 由 tao 事件产生 | 由 pump loop 自己产出(Ready 进循环前;UserEvent 来自队列;MainEventsCleared 每轮;Exit 退出后) |
| **窗口/webview/窗口操作创建在 tao 回调内同步调** | **`post_task(ThreadId::UI, wrap_task!(…))`** 把创建丢进 CEF UI 任务;调用方在 UI 线程则 `loop { do_message_loop_work(); if done break }` 同步等完成,保住 Tauri 同步契约;非 UI 线程则 block 在结果 channel 上(pump loop 会执行) |
| 退出 = tao `ControlFlow::Exit` | `windowed_quit` flag + `quit_message_loop()`;pump loop 检查 flag 退出 |

> **关键不变量**:CEF UI 线程 = 调 `cef_initialize` 的线程 = pump loop 所在线程(主线程)。所有 CEF Views 调用都必须在该线程、且在 `do_message_loop_work` 泵动的上下文里发生 → 一律走 `post_task(TID_UI)`。

## 双模式共存
- `Cef` 运行时仍可持有 tao `EventLoop`(OSR 用);windowed 不调用它的 `run_return`。
- 消息投递统一改用新队列(OSR 的 tao `run_return` 每轮也 drain 该队列;windowed 的 pump loop 同样 drain)→ `CefEventLoopProxy` 不再依赖 tao,两模式一致。
- `WindowMode` 在 `run` / `create_window_now` / `create_webview_now` 继续分流:windowed → 新路径;OSR → 现有 tao 路径不动。

## 分阶段(每阶段可编译)
- **S1 — 消息队列解耦 tao**:`CefContext` 加 `Mutex<VecDeque<Message<T>>>`;`send`/`send_event` 改 push 队列;OSR `run_return` 循环每轮 drain;`CefEventLoopProxy` 去 tao 依赖。验收:OSR 仍正常(回归)。
- **S2 — windowed 纯 pump loop**:新 `run_windowed_loop` 去 tao `run_return`,改 `minimal_windowed` 式 pump;产出 RunEvent;退出走 `quit_message_loop` + flag。
- **S3 — post_task 建窗口(核心修复)**:`create_windowed_window_now` / `create_cef_browser_view` / windowed 窗口 setter 全部包进 `post_task(ThreadId::UI, …)` + 同步等完成;消除卡死。验收:windowed 真窗口弹出、可交互(对照 bootstrap)。
- **S4 — 清理**:windowed 不再触达 tao 类型(monitor/cursor 等用 CEF Views/降级,见 5.1.3);确认 `cargo check` 通过、OSR 无回归。

## 验收
- `KABEGAME_CEF_WINDOW_MODE=windowed bun dev -c kabegame`:真窗口弹出、GPU 渲染前端、点击/滚动/IPC 正常、关闭退出干净、**无 10s 卡顿**。
- 不设该 env(OSR 默认):行为与本计划前一致(tao 保留,回归通过)。

## 风险
- 同步 `create_window` 契约 vs `post_task` 异步:用"post + 本线程 pump 至完成"桥接;注意不要在非 UI 线程 pump(按 `main_thread_id` 分支)。
- 队列轮询延迟(每 1ms)对 UserEvent 时延影响极小;必要时用 CEF `post_task` 唤醒。
- OSR `run_return` 改 drain 队列时,勿破坏既有 tao 窗口事件处理。

## 锚点
- `examples/minimal_windowed.rs`(`run_external_pump` / `pump_glib` / 在 `on_context_initialized` 建窗口)。
- `runtime.rs`:`run_windowed_loop`(1615)、`handle_message`/`handle_main_thread_message`、`create_windowed_window_now`(1318)、`CefEventLoopProxy`、`CefContext::send`(`:159` 主线程判定)。
- cef API:`post_task(ThreadId::UI, …)`、`wrap_task!`、`do_message_loop_work`、`quit_message_loop`。

## 完成记录(2026-06-26)
- S1 完成:`CefContext` 新增线程安全消息队列;`CefEventLoopProxy` 改持有 `CefContext`,不再直接依赖 tao `EventLoopProxy`;OSR `run_return` 每轮 drain 队列。
- S2 完成:windowed `run_windowed_loop` 不再调用 tao `run_return`,改纯 `drain_msgs → pump_glib → do_message_loop_work` 循环,自行发出 `Ready/MainEventsCleared/Exit`。
- S3 完成:`create_windowed_window_now` / `create_windowed_webview_now` 改为 `post_task(ThreadId::UI)` + 同步 pump 等结果;真实 CEF Views `Window + BrowserView` 创建发生在 CEF UI task 中。
- 清理:删除旧的 `wait_for_windowed_context_initialized` 10s 等待路径;OSR 的 tao window / input / softbuffer fallback 保留。
- 验证:
  ```sh
  cargo fmt -p tauri-runtime-cef --check
  env CEF_PATH=/home/cm/.local/share/cef cargo check -p tauri-runtime-cef --features cef-backend
  ```
  通过;仅余既有 `protocol.rs` macro unused warning。

## 后续修复(2026-06-26):windowed 仍无窗口的真因 — `browser_view.browser()` 异步

S1–S3 后 `cargo check` 过,但实跑(`KABEGAME_CEF_WINDOW_MODE=windowed`)**无任何窗口**。逐行 `cef-dbg` 日志定位:`after browser_view_create` 打了、`got browser ok` 没打。

**根因**:`create_cef_browser_view` 在 `browser_view_create()` 之后**立刻同步** `browser_view.browser().ok_or(..)?`。CEF 的 `BrowserView` 的 browser 是**异步创建**的(挂窗 + 显示后经 `LifeSpanHandler::on_after_created` 才有),创建时必为 `None` → `?` 直接 `Err` → webview 创建失败 → 整个窗口静默不出现。OSR 不受影响(用同步的 `browser_host_create_browser_sync`)。bootstrap 不受影响(它从不调 `browser()`,直接用 `browser_view`)。

**修复**:
- `CefWebviewState.browser`:`CefBrowser` → `Option<CefBrowser>`;新增 `resolve_browser() -> Option<Browser>`:优先返回同步创建的(OSR),否则**延迟**从 `browser_view.browser()` 解析(windowed,首次 None、挂窗后即可用)。
- windowed 创建:`browser: None`,删除创建期的 `browser_view.browser()?`;OSR 创建:`browser: Some(..)` 不变。
- 全部 `state.browser.inner.*`(navigate / eval / reload / devtools / zoom / set_focus / has_dev_tools 等 11 处)改走 `resolve_browser()`——dispatch 发生时 browser 已就绪。
- 防御:`post_cef_ui_task` 起始先 pump 至 `WINDOWED_CONTEXT_INITIALIZED` 再 post 建窗任务(避免在 `on_context_initialized` 之前发起 CEF Views 创建)。

**验证(实跑)**:主窗口 `Kabegame` 2250×1688 + `Kabegame 爬虫` 2700×1519 弹出,日志两次 `windowed top-level CEF window created and attached`,CEF 在 GPU 正确渲染。裸二进制下页面为 `ERR_CONNECTION_REFUSED`(未起 Vite,`localhost:1420` 连不上),属预期;`bun dev` / production `tauri://` 加载真实前端。

> 经验留痕:CEF `BrowserView` 的 browser 异步创建,**任何时候都不要在创建后同步取 browser**;一律延迟解析。后续多窗口 / `reparent`(5.2 / 5.4)注意同一坑。
