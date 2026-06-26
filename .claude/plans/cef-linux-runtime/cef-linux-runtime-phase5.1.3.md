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

---

## 落地记录(2026-06-26)

> 注:实际可用的是**已发布的 `cef 149.0.0+149.0.2`**,其 `ImplWindow` 比 `/home/cm/code/cef-rs` clone 略少(例如**无 `is_frameless`**)。映射以 published crate 为准。

### 已完成
- 新增 `WindowedWindowState::with_cef_window(|w: &cef::Window| …)`:在窗口消息循环(= CEF UI 线程,与 `apply_windowed_window_set` 同线程)上用活的 CEF Views `Window` 执行查询,窗口未创建时回退缓存。
- **windowed getter 从"读缓存"改为"查真实 CEF Window"(缓存兜底)**:
  - `ScaleFactor` → `window.display().device_scale_factor()`(**修了原来硬编码 `1.0` 的 HiDPI bug**)。
  - `InnerSize/OuterSize` → `View::size()`;`InnerPosition/OuterPosition` → `View::position()`。
  - `IsMaximized/IsMinimized/IsFullscreen/IsVisible/IsAlwaysOnTop` → 对应 `is_*()`;`IsFocused` → `is_active()`。
- `WindowMessage::Center`(原 **no-op**)→ windowed 调 `Window::center_window(None)`。OSR(tao)无原生 center,维持原样。
- `cargo fmt` + `cargo check -p tauri-runtime-cef --features cef-backend` 通过(仅余既有 `protocol.rs` macro unused warning)。

### 映射 / 降级矩阵(windowed,CEF Views)
**✅ 可保持(直接映射)**:show/hide/close、set_title、maximize/minimize/unmaximize/unminimize(restore)、set_fullscreen、set_always_on_top、focus(activate)、center(center_window)、set_size/set_position(set_bounds);getter:size/position/scale_factor、is_maximized/minimized/fullscreen/focused(active)/visible/always_on_top。

**⚠️ 降级 = 创建期属性(运行期改动仅更新缓存,CEF Views 无运行期 setter)**:decorations(frameless)/resizable/maximizable/minimizable/closable —— 创建时由 `WindowDelegate` 的 `is_frameless`/`can_resize`/`can_maximize`/`can_minimize`/`can_close` 应用;`is_decorated` getter 也用缓存(published cef 无 `is_frameless` 查询)。`icon` 暂 no-op(CEF 有 `set_window_icon`,但需把 Tauri RGBA 转 `cef::Image`,后续)。

**❌ 不支持 / no-op(CEF Views 无对应)**:always_on_bottom、visible_on_all_workspaces、content_protected、skip_taskbar、progress_bar、badge、窗口级 enabled、theme(`set_theme_color` 未接)、窗口级 cursor(grab/visible/icon/position/ignore —— webview 内光标走 `DisplayHandler::on_cursor_change`)、request_user_attention。

### 点 3 复核(拖动/装饰/命中区)——**结论:Linux 下基本伪需求,经核对更正**

> 起初担心"无边框 + 自定义标题栏拖不动",**核对 `startup.rs` 后证伪**:

- **主窗口**(`create_main_window`,`startup.rs:127`)**未设 `decorations(false)`** → 默认 `decorations=true`。`create_window_now` 把 `frameless = !attrs.decorations = false` 传给 `WindowedTopLevelWindowDelegate` → CEF Views 建**带标题栏的装饰窗口**,**拖动/缩放由窗口管理器处理,不需要 `start_dragging`**。✅
- **壁纸窗口**(`decorations(false)`,`startup.rs:262`)是 `#[cfg(any(windows, macos))]` → **Linux 根本不创建**(Linux 壁纸走 desktop mount / 别的机制)。
- 整个前端 `apps/` + `packages/` **搜不到任何** `data-tauri-drag-region` / `-webkit-app-region` / `startDragging` → kabegame 无自定义标题栏拖拽逻辑。

→ **`set_draggable_regions` / `start_dragging` 在 kabegame Linux 路径上不需要实现**(YAGNI),保持 no-op。

**若将来新增 Linux 无边框窗口**:CEF Views 原生路径是
`DragHandler::on_draggable_regions_changed` → `Window::set_draggable_regions`(配合前端 `-webkit-app-region: drag` CSS),**不是** Tauri 的 `start_dragging`(CEF Views 无交互式移动 API,硬要支持需裸 X11 `_NET_WM_MOVERESIZE`)。后端接缝已确认:`create_window_now` 在建 `browser_view`(`runtime.rs:1457`)前已先建 `shared`(`:1444`),可把 `shared.clone()` 传入 `create_cef_browser_view`,给 `ViewsClient` 挂一个持 `shared` 的 `DragHandler`。

### ⚠️ 已知小降级:`min_inner_size` 不强制
kabegame 主窗口设了最小尺寸(`startup.rs:155`,Linux 1200×800)。windowed 下 `MinSize/SizeConstraints` no-op:**published `cef 149.0.0` 的 `ViewDelegate` 没有可重写的 `get_minimum_size`**(只有 C ABI 槽,无 Rust trait 默认方法),无法经 delegate 强制。影响:窗口可被拖到小于 1200×800。**非功能性 break,低优先**;若上游 cef-rs 后续暴露该方法再补。

### 窗口事件回流(✅ 已完成,2026-06-26)
windowed 下接通 `WindowDelegate` → Tauri `WindowEvent`:
- 新增 `Message::CefWindowEvent(WindowId, WindowEvent)` + 类型擦除 `WindowEventEmitter`(`Arc<dyn Fn(WindowEvent)+Send+Sync>`)。`create_windowed_window_on_cef_ui` 构造的 emitter 捕获 `CefContext` + `window_id`,把事件 `enqueue` 进内部队列。
- delegate 新增 `on_window_bounds_changed`(→ `Resized` + `Moved`,DIP×scale 换算物理像素)、`on_window_activation_changed`(→ `Focused`)。
- 主循环 `handle_message` 收到 `CefWindowEvent` → 新增 `emit_mapped_window_event(id, WindowEvent, callback)`(从 `emit_window_event` 抽出)→ 分发到该窗口 `listeners` + `RunEvent::WindowEvent`。
- 解决了"listeners 在 `CefWindowState`、delegate 仅持 `shared`"的耦合:**不把 listeners 搬给 delegate,而是 delegate 把事件投回主循环**(callback 在主循环 scope)。
- `cargo check`/`fmt` 通过。

> 仍未做(低优先):`CloseRequested`(可阻止关闭)—— 现 `can_close` 已决定是否关窗,但未发 Tauri 可 `preventDefault` 的 `CloseRequested` 事件;需协调关闭决策与 signal,后续按需补。`on_window_fullscreen_transition` 未发事件(Tauri 无对应 WindowEvent;getter 已实时查 `is_fullscreen`)。

### 5.1.3 收尾结论
- ✅ getter 映射真实 CEF Window + `Center` + scale_factor(HiDPI 修复)
- ✅ 窗口事件回流(Resized/Moved/Focused)
- ✅ 降级矩阵;点 3 拖动证伪(Linux 主窗口系统装饰,不需要);min-size 记为无法实现的小降级
- ⏭ 仅 `CloseRequested` 可阻止关闭未做(低优先)

### GUI 验收(需交互式运行,未在本环境完成)
```sh
CEF_PATH=$HOME/.local/share/cef LD_LIBRARY_PATH=$CEF_PATH:$LD_LIBRARY_PATH \
KABEGAME_CEF_WINDOW_MODE=windowed bun dev -c kabegame
# 验:最大化/最小化/还原/全屏/置顶/居中/标题、HiDPI 缩放正确;
#     无边框拖动 + 最小尺寸 = 已知缺口(上方 🔴)。
```
