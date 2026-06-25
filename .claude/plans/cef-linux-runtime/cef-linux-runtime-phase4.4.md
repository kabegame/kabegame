# Phase 4.4 — 全应用回归 + 收尾

> 父:[phase4](cef-linux-runtime-phase4.md)。前置:4.3(IPC 通)。把"命令能调"推进到"应用基本可用"。

## 现状锚点
- setup 内有 http_server(缩略图/视频资源)、tray、organize service、窗口创建等。
- `lib.rs` 仍有诊断钩子 `KABEGAME_CEF_URL`(Phase 3.3 加,env-gated)。
- 事件回推(`emit` → 前端监听)在 4.3 可能未覆盖。

## 点 1 — http_server 资源经 CEF 加载
- **验证** 缩略图/视频走 http_server 的 URL(`http://127.0.0.1:port/...`)在 CEF 里能 fetch/显示;CSP(tauri.conf 的 `connect-src`/`img-src`/`media-src`)对 CEF 是否需调整。

## 点 2 — 事件 `emit` 方向
- **验证/补全** Rust → 前端事件(`app.emit` / `window.emit`)能到达页面监听器(画廊刷新 `images-change`、任务计数等依赖)。若 4.3 只做了 invoke 单向,这里补事件注入(`__TAURI_INTERNALS__` 的事件通道,通常经 init script + eval)。

## 点 3 — tray / 窗口生命周期 / 退出
- **验证** tray 图标与菜单(4.1 泛型化后)在 CEF 下显示与点击;窗口关闭/退出流程(`RunEvent::ExitRequested` 等)正常;无残留子进程。

## 点 4 — 清理与门控回归
- **决定** `KABEGAME_CEF_URL` 钩子:保留为 dev 钩子(标注)或删除。
- **回归** `cargo check`/构建在 **Android / Windows / macOS** 未触达 `tauri-runtime-cef`,行为与改造前一致。
- **更新** README §9 / 本计划落地记录。

## 验收
- kabegame 在 Linux CEF 下:**画廊浏览、设置读写、缩略图/视频显示、基本交互**可用。
- 事件驱动的刷新(下载完成、画册变更)在 CEF 下生效。
- 其余平台不受影响。

## 风险
- CSP 对 `http://127.0.0.1:*` / `ipc:` / 自定义 scheme 的放行需与 CEF 实际请求对齐。
- 大图/视频经 http_server 的 Range / 流式(与 3.1 ResourceHandler 的 Range 协同)。
- 长时间运行的稳定性(内存、子进程、GPU 关闭下的软件渲染负载)。

## 锚点
- `http_server.rs`、`tray.rs`、setup 闭包(`lib.rs`);tauri.conf `security.csp`。

## 落地记录(2026-06-25)

- CEF runtime 已接上 `PendingWebview.on_page_load_handler`:主 frame 的 load start / load end 分别触发 `PageLoadEvent::Started` / `Finished`,覆盖 Tauri 全局 `on_page_load` 与 plugin page-load hook 的事件入口。
- `tauri.conf.json.handlebars` 的 CSP 已补 `cef-ipc:` 到 `default-src` / `connect-src`;`http://127.0.0.1:*`、`img-src *`、`media-src *` 已能覆盖本地 http_server 的缩略图/视频资源请求。
- `KABEGAME_CEF_URL` 已不在当前源码中,本计划的现状锚点为过期信息;本次仅清理 CEF cache 目录名,从诊断期 `tauri-runtime-cef-phase3` 改为稳定的 `kabegame-cef`。
- Android 目标依赖图检查:`cargo tree -p kabegame --features android --target aarch64-linux-android -i tauri-runtime-cef` 返回 `package ID specification tauri-runtime-cef did not match any packages`,说明该 target 的 kabegame 依赖图未包含 CEF runtime。
- Windows/macOS 目标依赖图检查已尝试并按权限要求提权重试,但当前环境的 crates.io 访问被本地代理 `127.0.0.1:20171` 阻断,缺失 target crates 无法下载;平台门控仍由 `Cargo.toml` 的 `target_os = "linux"` 依赖门控与 Android 依赖图结果覆盖。

## 验证记录(2026-06-25)

- `cargo fmt --package tauri-runtime-cef`
- `cargo check -p tauri-runtime-cef --features cef-backend`
- `FFMPEG_PKG_CONFIG_PATH=/home/cm/code/kabegame/third/FFmpeg-build/install/lib/pkgconfig cargo check -p kabegame --features standard`

以上检查通过;输出仍包含仓库既有 warning。未启动 GUI 做人工 smoke,因为本仓库规约要求默认用 lint/check 诊断,不跑完整构建。
