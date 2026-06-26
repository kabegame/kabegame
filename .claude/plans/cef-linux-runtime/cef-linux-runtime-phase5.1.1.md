# Phase 5.1.1 — windowed 模式骨架:GPU 开关 + CEF/GLib 外部泵

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。路线 A 迁移第 1 步:把 `minimal_windowed` 的循环产品化进 runtime,先不接 Tauri `create_window`。
>
> **目标**:runtime 多出一条 **windowed(CEF Views + GPU)** 运行路径,能起一个 CEF 自建顶层窗口、GPU 渲染、external GLib pump 驱动交互;OSR 路径保留为 fallback。

## 现状锚点
**a. 硬关 GPU + OSR settings**(`runtime.rs:446` / `:510`)
```rust
cl.append_switch(Some(&CefString::from("disable-gpu")));            // 现状:windowed 要去掉
cl.append_switch(Some(&CefString::from("disable-gpu-compositing")));
// ...
windowless_rendering_enabled: 1,                                     // 现状:OSR;windowed 不设
```
**b. 循环 = tao run_return + do_message_loop_work**(`runtime.rs:740/865/870`)。
**c. 已验证范例**(`examples/minimal_windowed.rs`):`window_create_top_level` + `browser_view_create`;`run_external_pump` = `MainContext::default()` `.pending()/.iteration(false)` + `do_message_loop_work()` + 空闲 sleep 1ms。

## 点 1 — 模式开关
- **新增**:`WindowMode { Osr, Windowed }`(env/feature 决定;默认先留 OSR,windowed 显式开,便于对照与回退)。
- **完成**:`KABEGAME_CEF_WINDOW_MODE=windowed` / `views` 启用 windowed;未设置时仍为 OSR。

## 点 2 — GPU 命令行(windowed 分支)
- **修改** `on_before_command_line_processing`:windowed 模式注入 `--ozone-platform=x11`、`--use-angle=vulkan`、`--enable-features=Vulkan`,**不加** `disable-gpu(-compositing)`;保留 `--no-sandbox`(+ 现有 `--no-zygote` 等约束)。OSR 分支维持原样。
- **完成**:命令行开关按 `WindowMode` 分支;OSR 继续注入 `disable-gpu` / `disable-gpu-compositing`。

## 点 3 — external GLib pump 循环
- **新增** windowed 的 `run`/`run_return`:照 `run_external_pump` —— `MainContext` 迭代 + `do_message_loop_work()` + 空闲 1ms;用 `on_schedule_message_pump_work` 的 delay 调优空转(可选)。
  > 关键经验(来自 5.1 验证):Linux external pump **必须同时泵 GLib/X11 事件队列**,只调 `do_message_loop_work()` 会"显示正常但拖选等交互不全"。
- **完成**:`run_return` / `run` 在 windowed 模式进入 CEF/GLib 外部泵;`run_iteration` 也泵 GLib + CEF。

## 点 4 — settings 分支
- **修改** `initialize`:windowed 模式不设 `windowless_rendering_enabled`;`external_message_pump = 1` 仍保留(我们自泵)。
- **完成**:CEF settings 按模式分支;windowed 模式由 `browser_process_handler.on_context_initialized` 创建 `BrowserView + Window` 顶层窗口。

## 完成记录(2026-06-26)
- `src-tauri/tauri-runtime-cef/src/runtime.rs` 增加 `WindowMode`、windowed CEF app handler、Views 顶层窗口 delegate/client、GLib pump helper 和 windowed `run_loop` 分支。
- 固定 URL 默认 `https://example.com`;可用 `KABEGAME_CEF_WINDOWED_URL` 覆盖,并兼容实验变量 `CEF_WINDOWED_URL`。
- 默认 OSR fallback 未变;windowed 必须显式设置 `KABEGAME_CEF_WINDOW_MODE=windowed`。
- 验证:`env CEF_PATH=/home/cm/.local/share/cef cargo check -p tauri-runtime-cef --features cef-backend` 通过。当前仅余既有 `protocol.rs` macro unused warning。
- GUI 交互验收需用 runtime/app 入口运行,并显式打开 windowed 模式,例如:
  ```sh
  CEF_PATH=/home/cm/.local/share/cef \
  LD_LIBRARY_PATH=/home/cm/.local/share/cef:$LD_LIBRARY_PATH \
  KABEGAME_CEF_WINDOW_MODE=windowed \
  KABEGAME_CEF_WINDOWED_BOOTSTRAP=1 \
  KABEGAME_CEF_WINDOWED_URL=https://example.com \
  bun dev -c kabegame
  ```

## 验收
- windowed 模式:runtime 起一个 CEF Views 窗口加载固定 URL,GPU 渲染(无 `disable-gpu`),鼠标拖选/滚动/点击/关闭退出正常。
- OSR 模式不回归(默认路径仍可跑)。

## 风险
- external pump 空转策略影响 CPU/功耗(对照 `windowless_frame_rate` 不再适用,windowed 是真实合成)。
- `no-zygote`/sandbox 与 GPU 进程在 windowed 下的组合需再确认不崩。

## 锚点
- `examples/minimal_windowed.rs`(`run_external_pump` / `pump_glib` / `window_create_top_level`)。
- `runtime.rs:446`(GPU 开关)、`:510`(OSR settings)、`:740/865`(tao 循环)。
