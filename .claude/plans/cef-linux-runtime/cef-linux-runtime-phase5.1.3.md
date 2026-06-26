# Phase 5.1.3 — WindowDispatch 映射到 CEF Views(API 范围 + 降级矩阵)

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。前置:5.1.2。
>
> **目标**:把 `WindowDispatch` / `WindowBuilder` 的实现从 tao 改映射到 CEF Views `Window`,并明确"可保持 / 需降级 / 不支持"矩阵。

## 现状锚点
`window.rs`(~830 行)近全量 `WindowDispatch`,**全部基于 tao**(`build_tao_window`、`tao::window::*`、`gtk_window`/`default_vbox`)。windowed 路径下这些大多需要重指向 CEF Views Window。

## 点 1 — 产出 API 映射矩阵(先调研后改)
- **任务**:逐方法对照 CEF Views `Window`/`Panel`/`View` 能力,分三类:
  - **可保持**(CEF Views 直接支持):show/hide/close、set_title、set_size/inner_size、set_position/center、focus、maximize/minimize/restore、fullscreen、always_on_top、set_visible 等。
  - **需降级/近似**:decorations / 无边框 + 自定义标题栏(CEF Views 的 frameless 行为)、透明、阴影、cursor grab/ignore、skip_taskbar、progress bar、badge、传统 X11-only 技巧。
  - **不支持/暂缺**:列出并标注上层(kabegame)是否依赖。
- **产出**:矩阵写回本文件,指导点 2。

## 点 2 — 重写窗口方法(windowed 分支)
- **修改** `window.rs`:windowed 模式下窗口 getter/setter 落到 CEF Views `Window`;monitor/scale_factor 走 CEF Views display 信息;事件(resize/move/focus/close)从 WindowDelegate/LifeSpanHandler 回流为 Tauri `WindowEvent`。
- 保留 tao 实现于 OSR fallback 分支(不删,feature/mode 分流)。

## 点 3 — 拖拽 / 装饰 / 命中区
- **核对** kabegame 是否用无边框 + 自定义标题栏(`start_dragging`/`start_resize_dragging`)。CEF Views 下重新实现拖动/缩放命中。

## 验收
- kabegame 主窗口常用操作(缩放/最大最小化/标题/全屏/置顶/居中/关闭)在 windowed CEF 下可用。
- 降级/不支持项有明确矩阵 + 上层不依赖确认。

## 风险
- CEF Views frameless/自定义标题栏成熟度可能不如 tao/GTK;无边框拖拽是重点验证项。
- tray / 多显示器 / DPI 在 CEF Views 下的对应(tray 见根计划/5.2;DPI 见 5.1.5)。

## 锚点
- `window.rs`(现 tao 实现,作为映射对照)。
- cef `Window`/`Panel`/`View`(`/home/cm/code/cef-rs/cef/src/`)。
- `examples/minimal_windowed.rs` `TopLevelWindowDelegate`。
