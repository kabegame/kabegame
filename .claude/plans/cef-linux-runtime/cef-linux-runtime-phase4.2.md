# Phase 4.2 — 抽共享 builder,CEF 入口挂全 app

> 父:[phase4](cef-linux-runtime-phase4.md)。前置:4.1(全泛型化)。

## 现状锚点
两条独立 run(`src-tauri/kabegame/src/lib.rs`):
```rust
// 320: CEF 最小路径 —— 不挂任何东西
let app = tauri::Builder::<Cef<EventLoopMessage>>::new().build(context)?;
app.run(|_, _| {});

// 333+: Wry 全功能 —— plugins + setup + invoke_handler + generate_context
tauri::Builder::default()
    .plugin(tauri_plugin_pathes::init()) ... // 一长串
    .setup(|app| { /* http_server / tray / organize / windows */ })
    .invoke_handler(tauri::generate_handler![ /* 全部命令 */ ])
    .build(tauri::generate_context!())?;
```

## 点 1 — 抽出 `configure_app<R: Runtime>`
- **新增** 一个泛型函数(或宏)把**插件链 + setup + invoke_handler** 收进去:
  ```rust
  fn configure_app<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
      builder
          .plugin(tauri_plugin_pathes::init())
          // … 其余插件 …
          .setup(|app| { /* 复用现有 setup */ Ok(()) })
          .invoke_handler(tauri::generate_handler![ /* 同一份命令清单 */ ])
  }
  ```
  > `generate_handler!` 在泛型函数里可用;`generate_context!` 仍在各自 run 里调(它绑定具体 config)。

## 点 2 — 两条 run 都走 configure_app
- **修改** Wry run:`configure_app(tauri::Builder::default()).build(generate_context!())`。
- **修改** CEF run:`configure_app(tauri::Builder::<Cef<_>>::new()).build(context)`(context 仍是 320 那段加了 main window 的)。
- **删除** CEF 路径里"空 build"的临时实现。

## 点 3 — setup 副作用按平台/运行时校准
- **核对** setup 内启动项在 CEF 路径是否都应跑:http_server(要,缩略图依赖)、tray(要)、organize service(要)、单例/更新(按现状)。
- 必要时对 CEF 分支做最小跳过(尽量不跳,先全开,出问题再 gate)。

## 验收
- CEF 启动后:`app` 持有 invoke_handler + 全部 plugins + setup 已执行(日志/断点确认)。
- 前端首屏后**不再因 "command not found / plugin missing" 立即报错**(IPC 真正往返留 4.3,但 handler 已就位)。
- 可临时用 `KABEGAME_CEF_URL` 加载一个调 `invoke` 的测试页观察(往返通不通看 4.3)。

## 落地记录(2026-06-25)— ✅ 核心完成

- 抽出 `configure_app(builder: Builder<crate::AppRuntime>) -> Builder<...>`(`lib.rs`,`cfg(not(web))`),装全套 plugins + `on_window_event` + setup + `invoke_handler`。Wry run 与 CEF run 都调它(`AppRuntime` 按 cfg 单态)。
- CEF run 不再手动 push "main" 窗口(`tauri.conf` 桌面端 `windows: []`),主窗口统一由 setup 的 `startup::create_main_window` 创建,与 Wry 完全一致。
- 验证:`cargo build -p kabegame --features standard` 通过;启动后全套 bootstrap(Settings/Plugin/Storage/Runtime/DownloadQueue/Scheduler/VD)✓ 执行,CEF 渲染稳定(加载错误页可正确上屏)。

### 🔴 排障:启动几秒即 `Maximum number of clients reached` + SIGSEGV
- 现象:fd 急涨、X 连接耗尽崩溃。strace 定位主进程几百次 `XOpenDisplay` 不关,栈在 `webview::blit` → softbuffer。
- 误区:先以为是 blit 每帧 `Context::new`(已改成缓存复用),但 minimal 实测 softbuffer 每帧建/弃**不泄漏**;真因不在此。
- 根因(blit 加诊断打印 softbuffer 错误后定位):**`init_crawler_window` 启动时隐藏创建的 crawler 窗口**,其 tao 窗口未实现 → `window_handle()` = `RawWindowHandle(Unavailable)` → blit 对它 `Surface::new` 每帧失败,而失败前 `Context::new` 开的 X 连接不回收 → 每帧泄漏一个,几百帧打满 X。
- ✅ 修复(`tauri-runtime-cef/src/webview.rs::blit`):创建 Context **之前**先 `window_handle().is_err()` 判断,隐藏/未实现窗口直接跳过,根本不开连接。验证:fd 稳定 171/172、存活无崩、错误页正确渲染。
- 顺带:`CefWebviewState` 持久化 softbuffer `Surface`(每窗口一次性创建后复用,参考 wry),消除每帧重建开销。

## 风险
- `setup` 闭包捕获/`AppHandle<R>` 推断:泛型化后类型推断可能需显式标注。
- CEF 非 Send/Sync 的后台任务:沿用 `content_io_provider` 的 channel 代理模式。
- 插件初始化顺序(pathes 必须在 Settings/Storage 前)——保持现有顺序。

## 锚点
- `lib.rs:320`(CEF run)、`lib.rs:333-640`(Wry run);`tauri::Builder<R>` / `generate_handler!` / `generate_context!`。
