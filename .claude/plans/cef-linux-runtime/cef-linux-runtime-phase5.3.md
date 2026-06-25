# Phase 5.3 — 系统集成补齐(拖放 / 全屏 / 弹窗外链 / 下载 / 剪贴板 / 对话框)

> 父:[phase5](cef-linux-runtime-phase5.md)。
>
> **目标**:把 kabegame 重度使用、但 OSR 下需显式接的系统集成能力补齐到与 wry 一致。

## 现状锚点(kabegame 用量,粗扫)
`download` 131×、`drag` 100+×、`dialog` 50+×、`clipboard` 15×、`fullscreen` 8×。OSR 模式下这些不会"自动"工作,需逐项确认/接线。

## 点 1 — OS 文件拖放进 webview(drag-drop)
- **核对/新增**:Tauri 的 `PendingWebview.drag_drop_handler`(拖文件进窗口)在 CEF OSR 下是否触发。OSR 不自带 OS DnD,需从 tao 的拖放事件转 CEF `DragHandler` / `drag_target_*`,或直接喂给 Tauri 的 drag_drop_handler。
- **区分**:HTML5 应用内拖拽(Chromium 内部处理,通常 OK)vs OS→窗口文件拖放(需接线)。

## 点 2 — HTML5 全屏 API
- **新增**:`element.requestFullscreen()`(`DisplayHandler::on_fullscreen_mode_change`)→ 调 tao `set_fullscreen`。窗口级全屏已实现(`window.rs`),此处是页面 API 触发的全屏。

## 点 3 — 弹窗 / 外链
- **新增**:`window.open` / `target=_blank` / 外部 http(s) 链接策略 —— `on_before_popup` 拦截,按 kabegame 期望:站内新 Tauri 窗口 or 系统浏览器打开(与 5.2 点 3 统一)。

## 点 4 — 下载
- **核对**:kabegame 的 "download" 多为后端任务(Rust),非浏览器下载;但若前端有 `<a download>`/blob 下载,需 `DownloadHandler`(`on_before_download`/`on_download_updated`)。先确认是否真有 webview 触发的下载,有才接。

## 点 5 — 剪贴板 / 对话框验收
- **核对**:webview 内复制/粘贴(Chromium 内建,通常 OK)、`tauri-plugin-clipboard-manager`(走 OS,独立于引擎)。
- **核对**:`tauri-plugin-dialog` 文件选择器在 CEF 窗口下能正确以该 tao 窗口为 parent 弹出(gtk/xdg portal)。

## 验收
- 拖文件进 kabegame 触发预期处理;页面全屏、外链、复制粘贴、文件对话框均正常。

## 风险
- OSR + OS DnD 在 X11/XWayland 的坐标与 enter/leave 时序。
- 对话框 parent/模态与 tao 窗口的关系。
