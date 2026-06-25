# Phase 5.2 — 多窗口 / 多 webview

> 父:[phase5](cef-linux-runtime-phase5.md)。
>
> **目标**:支持 kabegame 的多窗口(`main` / `wallpaper` / 外部 `WebviewWindowBuilder`),每个 webview 的自定义协议与状态正确隔离。

## 现状锚点
- kabegame 实际多窗口:`commands/window.rs` 取 `main`/`wallpaper`;`commands/misc.rs`、`startup.rs` 用 `WebviewWindowBuilder`(含 `WebviewUrl::External`)。
- **Phase 3.1 技术债**(其落地记录原话):scheme handler factory 现挂在**全局 request context**,"多 webview 同 scheme 隔离需迁移到独立 `RequestContext`,列入后续技术债务"。
- Phase 3 渲染/输入按**单窗口单 webview**目标实现,多窗口路径未系统验证。

## 点 1 — 每 webview 独立 RequestContext
- **修改** `runtime.rs`/`protocol.rs`:每个 webview 用独立 `RequestContext` + 在其上注册 scheme factory,避免多窗口同名 scheme(`tauri://`/`ipc://`)串味、cookie/storage 串号。
  > 若 kabegame 需要多窗口共享会话(cookie/localStorage),则按"共享 vs 隔离"明确分组。

## 点 2 — 多窗口生命周期 / 事件路由
- **核对** `create_window` + `create_webview`:每窗口独立 tao 窗口 + windowless browser + 帧缓冲 + blit;输入/焦点/光标事件按窗口 id 正确路由(现状是否多实例安全?)。
- **核对** `wallpaper` 窗口(特殊:可能无边框/置底/全屏铺底)与 external URL 窗口的渲染与关闭清理。

## 点 3 — 弹窗 / `window.open` / target=_blank
- **新增** popup 处理(`LifeSpanHandler::on_before_popup`):决定阻止并改为新建 Tauri 窗口 / 外部浏览器打开(与点 5.3 的外链策略统一)。

## 验收
- main + wallpaper 同时存在、各自渲染/可交互、各自 IPC 正确;关闭某窗口不影响其余、资源回收。
- 打开 external URL 窗口正常显示。

## 风险
- 多 browser 实例下 external message pump / blit 的调度与单实例假设冲突。
- RequestContext 与 cookie/storage 共享语义需与产品期望对齐。
