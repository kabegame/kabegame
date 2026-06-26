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
