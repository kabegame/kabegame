# ✅ Phase 3.2 — OSR 输入转发(让前端可交互)

> 父:[phase3](cef-linux-runtime-phase3.md)。前置:3.1(前端能加载)。
>
> **目标**:把 tao 的鼠标/键盘/滚轮/IME 事件转发给 CEF OSR browser,让前端**可点击、可滚动、可输入**(OSR 模式 CEF 不自己收输入,必须我们喂)。

## 现状锚点
**无任何输入转发**(`grep send_mouse|send_key|send_wheel|ime` 在 `src/` 为空)。窗口里 CEF 只渲染、不接收事件。

## 点 1 — 鼠标(`runtime.rs` 的 tao window_event 派发处)
- **新增** 处理 `CursorMoved` / `MouseInput` / `MouseWheel`:
  - `host.send_mouse_move_event(MouseEvent{ x, y, modifiers }, leaving)`
  - `host.send_mouse_click_event(MouseEvent, button, mouse_up, click_count)`
  - `host.send_mouse_wheel_event(MouseEvent, dx, dy)`
  - 坐标:tao 物理坐标 → 除以 `scale_factor` 得 CEF 期望的 DIP(与 `view_rect`/`screen_info` 的 scale 一致)。

## 点 2 — 键盘 / 修饰键 / IME
- **新增** `KeyboardInput` / `ModifiersChanged` → `host.send_key_event(KeyEvent{ type: RAWKEYDOWN/KEYUP/CHAR, windows_key_code, native_key_code, modifiers, character })`。
- **新增** IME(`Event::WindowEvent::Ime`)→ CEF `ime_set_composition` / `ime_commit_text`(中文输入必需,kabegame 搜索框等)。

## 点 3 — 焦点 / 光标
- **修改** focus:窗口 focus 变化 → `host.send_focus_event(focused)`(已有 `set_focus` 调 `host.set_focus(1)`,补 blur)。
- **新增** 光标:CEF `OnCursorChange`(RenderHandler / 通过 client)→ 设 tao 窗口光标图标。

## 验收
- 前端按钮可点击、画廊可滚动、输入框可打字(含中文 IME)。
- 悬停光标随内容变化(链接→手型等)。

## 风险
- 坐标 DPI/缩放一致性(与 OSR `view_rect` 对齐,错位会导致点击偏移)。
- 键码映射(tao keycode → CEF windows_key_code)需查表,易漏。
- 滚轮方向/步长与平台习惯。

## 锚点(CEF API,`BrowserHost`)
- `send_mouse_move_event` / `send_mouse_click_event` / `send_mouse_wheel_event`
- `send_key_event` / `send_focus_event` / `ime_set_composition` / `ime_commit_text`
- RenderHandler `on_cursor_change`(光标)

## 落地记录(2026-06-24)

已完成:

- tao `CursorMoved` / `CursorEntered` / `CursorLeft` / `MouseInput` /
  `MouseWheel` 已转成 CEF mouse event;维护按钮 modifier 与 500ms/4 DIP 的
  双击、三击计数。
- 鼠标物理坐标与 pixel wheel delta 按窗口 scale factor 转成 DIP;
  `RenderHandler::screen_info` 同步声明 CEF device scale factor,resize/DPI 变化同时
  调用 `notify_screen_info_changed` + `was_resized`。
- `KeyboardInput` 已转成 RAWKEYDOWN/KEYUP,覆盖字母、数字、编辑/导航、修饰键、
  小键盘、F1-F24 与常用 OEM 键的 Chromium/Windows VK code;携带左右键、
  keypad、repeat 和当前 modifiers。文本提交生成 CHAR 或 IME commit。
- tao 0.35.3 Linux 内部只使用 `GtkIMContextSimple` 且源码明确留有
  “TODO actual IME”。CEF backend 因此额外挂载 `GtkIMMulticontext`:
  - GTK preedit/commit 先进入 per-webview 队列;
  - 在 tao 键盘事件送出 RAWKEYDOWN 后刷新队列,保证 CEF 输入顺序;
  - preedit 走 `ime_set_composition`(UTF-16 range/selection),非 ASCII commit 走
    `ime_commit_text`,支持中文等系统输入法;
  - blur 时 focus out/reset/cancel composition。
- CEF 149 没有计划文本所写的 `send_focus_event`;实际 API 使用
  `BrowserHost::set_focus(1/0)`。
- `DisplayHandler::on_cursor_change` 已映射到 tao cursor icon,并处理隐藏光标。

验证:

- `cargo check -p tauri-runtime-cef --all-targets --features cef-backend` 通过。
- `cargo clippy` 在排除 Phase 3 骨架既有的三类告警后以 `-D warnings` 通过。
- `CEF_PATH=/home/cm/.local/share/cef cargo test -p tauri-runtime-cef \
  --features cef-backend --lib`:6 tests passed。
- 实际 kabegame 点击/滚动/中文输入验收与候选窗位置调优归 Phase 3.3 的端到端启动。
