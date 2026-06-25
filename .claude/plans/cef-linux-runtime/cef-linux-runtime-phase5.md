# Phase 5 — 功能对齐 + 性能(Linux CEF 与 wry 对等)

> 父:[cef-linux-runtime.md](cef-linux-runtime.md)。前置:Phase 3(渲染/窗口/输入/协议)+ Phase 4(IPC)已完成,前端可跑、事件 + invoke 通。
>
> **目标**:kabegame 在 Linux CEF 后端下日常功能与换引擎前一致;**NVIDIA 下滚动丝滑、原 `free()` 崩溃消失**(崩溃已由 Phase 3.3 的 sqlite version-script 修复)。

## 现状盘点(Phase 3/4 已顺带完成的"功能对齐")

实测代码(`src-tauri/tauri-runtime-cef/src/`),原 Phase 5 清单**大部分已落地**:

- **WindowDispatch**:`window.rs` 近全量 —— 装饰/全屏/置顶/置底/任务栏跳过/最大最小化/`start_dragging`/`start_resize_dragging`/进度条/badge/光标/主题/透明/多显示器/约束。**无 stub**。
- **WebviewDispatch**:`webview.rs` —— cookies(get/set/delete/for_url)、devtools(open/close/is_open)、`set_zoom`、`set_background_color`、`clear_all_browsing_data`、`eval_script(_with_callback)`、navigate/reload、auto_resize、IME/键鼠输入。**仅 `print` / `reparent` 仍 `unsupported()`**。

## 仍未解决 / 需对齐(本阶段真正的活)

| 子段 | 主题 | 为什么是缺口 |
|---|---|---|
| [5.1 性能与 GPU](cef-linux-runtime-phase5.1.md) | 滚动丝滑、软件 blit 优化、GPU 路径评估 | **项目初衷**;现仍 `disable-gpu` 软件 OSR(README §9.2.2) |
| [5.2 多窗口 / 多 webview](cef-linux-runtime-phase5.2.md) | 独立 `RequestContext`、scheme 隔离、wallpaper/external 窗口 | kabegame 有 main/wallpaper/external 多窗口;scheme factory 现为全局(Phase 3.1 技术债) |
| [5.3 系统集成补齐](cef-linux-runtime-phase5.3.md) | OS 文件拖放、HTML5 全屏、popup/外链、下载、剪贴板、对话框 | kabegame 重度用 drag/dialog/clipboard/download;OSR 下需显式接 |
| [5.4 剩余 dispatch + 边角](cef-linux-runtime-phase5.4.md) | `print` / `reparent` / `with_webview` 等 | 仅剩的 `unsupported()` |
| [5.5 稳定性与全功能回归](cef-linux-runtime-phase5.5.md) | shutdown/内存/长跑 + 画廊/爬虫/壁纸/设置/插件逐项验收 | "日常功能一致"需端到端核对 |

建议顺序:5.1(决定方案是否成立)→ 5.3 → 5.2 → 5.4 → 5.5(贯穿)。

> 范围边界:打包分发(.deb/AppImage 带 CEF runtime)仍归 **Phase 6**。
