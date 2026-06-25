# Linux 端用 CEF(Chromium)替换 WebKitGTK webview — 根计划

> **范围**:仅 **Linux 桌面**替换 webview 后端为 CEF(Chromium)。Windows(WebView2,本就是 Chromium)/ macOS(WKWebView)/ Android(系统 WebView)**全程不动**。
>
> **形态**:独立适配器 crate `src-tauri/tauri-runtime-cef/`,在 `tauri-runtime` 的 trait 契约上用 `cef`(tauri-apps/cef-rs)实现后端 —— 与官方 `tauri-runtime-wry` 对等。**不 fork Tauri**。
>
> **背景 / 技术调研 / 决策论证**:已完整固化在 `src-tauri/tauri-runtime-cef/README.md`,本文件不重复,只做**执行拆解**。本文件是**根计划**,后续按需细化为 `cef-linux-runtime-phaseN.md`。
>
> 每个 Phase 设计为**可独立完成的提交单元**:完成后分支应可编译、Linux 之外平台不受影响。

---

## 设计概览(共享前置知识)

### 为什么做(一句话)

Linux WebKitGTK 在 NVIDIA 上不丝滑、且在普通 UI 交互(下拉框)时 `free(): invalid pointer` native 堆崩溃,无法在应用侧定位/修复 → 换 Chromium 内核。

### 分层(决定工作量边界)

```
tauri(框架)
   │  Runtime / WebviewDispatch / WindowDispatch … traits
tauri-runtime-cef ★本项目(适配器)
   │  调用
cef(cef-rs,预编译 Chromium 内核)
```

- **窗口 / 事件循环 / 监视器 / DPI** 与引擎无关 → 可大段复用 tao / 抄 `tauri-runtime-wry`。
- **webview 部分**(导航、eval、cookie、IPC、自定义协议、init script)是真正要对接 CEF 的核心工作量。

### 长期维护契约(不 fork)

- 跟进 Tauri:`cargo update` 升 `tauri` / `tauri-runtime`(只在 trait 微调时改本 crate 几个签名)。
- 跟进 Chromium:升本 crate 的 `cef = "149"` 版本号(cef-rs 拉对应预编译包)。**绝不自己编译 Chromium。**

### 双平台门控(贯穿所有 Phase 的硬约束)

1. **依赖门控**(`src-tauri/kabegame/Cargo.toml`):
   ```toml
   [target.'cfg(target_os = "linux")'.dependencies]
   tauri-runtime-cef = { path = "../tauri-runtime-cef" }
   ```
2. **代码门控**(kabegame 入口):Linux → `Builder::<Cef<_>>`;其余 → `Builder::default()`(Wry)。
3. 任何 Phase 都**不得**让 Android / Windows / macOS 编译到 `cef` 或下载 Chromium。

### Trait 工作量表面积(实测)

| trait | 方法数 | 引擎相关 | 模块 |
|---|---|---|---|
| `Runtime<T>` | 11 | 部分 | `runtime.rs` |
| `RuntimeHandle` / `EventLoopProxy` | — | 线程转发 | `runtime.rs` |
| `WebviewDispatch<T>` | ~45 | **核心** | `webview.rs` |
| `WindowDispatch<T>` | ~78 | 否(抄 tao/wry) | `window.rs` |
| `WindowBuilder` | ~53 | 否(抄) | `window.rs` |

---

## Phase 拆解

> 标记:✅ 已完成 / ⬜ 待办。各 Phase「验收」即该提交单元的 Done 定义。

### ✅ Phase 0 — 骨架

- **目标**:建立 crate 结构与文档地基,不引入 CEF 构建负担。
- **交付物**
  - `src-tauri/tauri-runtime-cef/`:`Cargo.toml`(`cef` 挂默认关闭的 `cef-backend` feature)、`src/{lib,runtime,webview,window}.rs`(与 wry 对齐的类型脚手架 + 方法清单注释)、`README.md`。
  - 根 `Cargo.toml` workspace `members` 已加入。
- **验收**:`cargo check -p tauri-runtime-cef` 通过且**不下载 Chromium**(已验证 ✅)。

### ✅ Phase 1 — 环境验证(脱离 Tauri)— 已完成 2026-06-19

- **目标**:确认本机能链接 / 下载预编译 CEF 并跑起 Chromium —— 这是整个方案的地基,失败则一切免谈。
- **结果**:clone `tauri-apps/cef-rs`,`export-cef-dir` 下载 CEF `149.0.2`(Chromium 149.0.7827.53,源 spotifycdn,~1.5G)→ `bundle-cef-app` 编译 `cefsimple` → **成功弹出 Chromium 149 窗口加载本地 HTML**(8 子进程、中文/emoji/UA 正常,截图已验)。
- **关键结论**(全部写入 README §7):
  - NVIDIA+Wayland 必须 `--ozone-platform=x11`(否则 Wayland+Vulkan 合成冲突报错);
  - 必须 `--no-sandbox`(bundle 的 chrome-sandbox 非 SUID)——这两条 Phase 2 起需经 `CefSettings`/switches 注入;
  - Linux 单二进制兼任所有子进程;系统库依赖清单(供 Phase 6 .deb)。
- **风险(已消解)**:glibc/系统库本机全满足;NVIDIA GPU 路径用 x11 兜底已通。

### ✅ Phase 2 — 最小运行时闭环(开 `cef-backend`)— 已完成 2026-06-20(**改走 OSR**)

- **目标**:`tauri-runtime-cef` 自己能起一个窗口 + CEF 浏览器,加载本地 HTML(仍不接 Tauri 框架)。
- **结果**:`cargo run -p tauri-runtime-cef --example minimal --features cef-backend` 在 tao 窗口里渲染出本地 HTML(中文/emoji/UA=Chrome149,截图已验)。
- **关键转向(原计划的 parent 子窗口方案被否)**:本机 NVIDIA+XWayland 上,把 CEF parent 进 tao 的 GTK/X11 子窗口 → GPU 进程 SIGSEGV + 软件呈现器对子窗口 `XGetWindowAttributes` 失败(只出背景)。对照实验定位:问题在"X11 子窗口呈现",CEF 自建窗口则一切正常。→ **改用 OSR**:CEF windowless 软件光栅到 BGRA buffer(`on_paint`)→ `softbuffer` blit 到 tao 顶层窗口,绕开两个崩溃点。详见 README §9。
- **GPU(已 spike,结论须谨慎,2026-06-20)**:`examples/minimal.rs` 是**软件 OSR**(`--disable-gpu`)✅ 正确显示。GPU 加速 OSR 已搬进 `examples/minimal_gpu.rs`(wgpu+Vulkan dmabuf,`--use-angle=vulkan`):**CEF 在 GPU 持续出帧、dmabuf 零拷贝导入 OK、0 错误、不崩**,但**最终合成上屏纯黑**。根因:cef-rs `osr_texture_import::dmabuf` 创建 VkImage 时 initialLayout=UNDEFINED、无 layout 转换/外部队列族 ownership/同步 → wgpu 采样时被 NVIDIA 丢内容。属 **cef-rs 导入器缺陷**,要修需较深 Vulkan 工作。详见 README §9.2.2。
  - **当前能"GPU + 正确显示"的唯一已证路径 = 路线 A(CEF 自建窗口,Phase 1 已证)**;软件 OSR 显示正确但无 GPU;dmabuf OSR 待修。**Phase 3 渲染层方向需据此重新决策。**
- **交付物**:`examples/minimal.rs`、`Cargo.toml`(`cef-backend` 加 tao/softbuffer)、`src/{ipc,protocol}.rs` 占位。
- **风险(已消解/转移)**:message pump 调度 ✅(每 tick `do_message_loop_work`);窗口父子缩放焦点 → OSR 下变为「帧 blit + `was_resized`」,已通基础路径。

### ⬜ Phase 3 — 接入 Tauri:前端可跑

- **渲染层决策(2026-06-20)**:用**软件 OSR**(`examples/minimal.rs` 那条:`on_paint` BGRA → blit 到 tao 窗口)作 Phase 3 渲染层,**GPU 推迟**(修 cef-rs dmabuf 导入器或转路线 A,见 §9.2.2)。先把 Tauri 集成在软件路径打通。
- **目标**:kabegame 打包前端在 CEF 里跑起来(Linux)。
- **任务**
  - 实现 `Runtime<T>` / `RuntimeHandle` / `EventLoopProxy` 足够 `tauri::Builder::<Cef>` 启动。
  - `protocol.rs`:`CefSchemeHandlerFactory` + 异步 `CefResourceHandler` 提供 `tauri://` / `asset://` 内置资源。
  - init script 注入(render 进程 `on_context_created`,注入 `window.__TAURI__` bootstrap)。
  - kabegame 入口加双门控(依赖 cfg + Builder cfg 分流)。
- **验收**:Linux 上 `bun dev -c kabegame` 用 CEF 渲染出 kabegame 前端(可有功能缺口);其余平台行为不变。
- **风险**:scheme handler 的异步流式响应、MIME、Range 请求(图库大图/视频);CSP。

### ⬜ Phase 4 — 挂全 app + IPC 打通 → 细化见 [phase4](cef-linux-runtime-phase4.md)(拆 4.1–4.4)

> 实际范围比"IPC"更大:还要把插件/命令/setup 挂上 `Builder::<Cef>`(去残留 `Wry` 硬编码)。子段:4.1 泛型化 → 4.2 共享 builder 挂全 app → 4.3 IPC 往返 → 4.4 回归收尾。

- **目标**:`invoke()` ↔ Rust `#[command]` 全链路通。
- **任务**
  - `ipc.rs`:render 进程注入 `window.ipc.postMessage` JS binding → process message → browser 进程 → 回调 Tauri ipc handler;响应回传。
  - 校验 `tauri-runtime` 期望的 IPC 形态(initialization scripts、response 协议)与 wry 一致。
- **验收**:kabegame 关键命令(画廊浏览、设置读写等)在 CEF 下可用。
- **风险**:多进程消息序列化/大 payload;事件(`emit`)方向。

### 🔄 Phase 5 — 功能对齐 + 性能(详见 [phase5](cef-linux-runtime-phase5.md) + 5.1–5.5)

- **目标**:kabegame 在 Linux CEF 下日常功能与未换引擎前一致;NVIDIA 滚动丝滑、原 `free()` 崩溃消失(崩溃已由 Phase 3.3 sqlite version-script 修复)。
- **现状**:原"补齐方法"清单大部分已在 Phase 3/4 顺带完成(window 近全量;webview 的 cookie/devtools/zoom/背景色/clear-data 已实现,仅剩 `print`/`reparent` stub)。
- **剩余拆分**(各为可独立提交单元):
  - [5.1 性能与 GPU](cef-linux-runtime-phase5.1.md) —— **最关键**,仍 `disable-gpu` 软件 OSR(§9.2.2)。
  - [5.2 多窗口 / 多 webview](cef-linux-runtime-phase5.2.md) —— 独立 RequestContext / scheme 隔离。
  - [5.3 系统集成补齐](cef-linux-runtime-phase5.3.md) —— 拖放/全屏/弹窗外链/下载/剪贴板/对话框。
  - [5.4 剩余 dispatch + 边角](cef-linux-runtime-phase5.4.md) —— `print`/`reparent`/`with_webview`。
  - [5.5 稳定性与全功能回归](cef-linux-runtime-phase5.5.md) —— shutdown/内存/长跑 + 主路径逐项验收。
- **风险**:软件 OSR 性能天花板;多实例调度;OSR 下系统集成(DnD/全屏/对话框)细节。

### ⬜ Phase 6 — 打包分发

- **目标**:Linux 安装产物自带 CEF 运行时 + helper 子进程,终端用户开箱即用。
- **任务**
  - `tauri-bundler` Linux 产物(.deb / AppImage)纳入 CEF runtime 文件 + helper 可执行;rpath / 资源路径(参考 `cocs/build/PLATFORM_SHARED_LIBS.md`)。
  - 体积评估(CEF ≈ +170MB)、签名、启动初始化延迟(可延迟到首帧后)。
- **验收**:干净 Linux 机器上安装包可直接运行 CEF 版 kabegame。
- **风险**:体积;不同发行版系统库;与现有 FUSE/FFmpeg 打包流程的协同。

---

## 收尾(全部完成后)

- 在 `cocs/README.md` 增补条目,指向本 crate README + 本计划(届时流程已成型)。
- README 路线图勾选、构建前置条件补全。
- 评估是否把 `tauri-runtime-cef` 拆为独立 repo(若需复用);当前 YAGNI,留在 monorepo。

## 关键参考

- 本项目 README:`src-tauri/tauri-runtime-cef/README.md`(背景/调研/决策)
- 只读范文源码:`/home/cm/code/tauri-tauri-v2.10.0/crates/tauri-runtime{,-wry}/`
- 官方 cef-rs:<https://github.com/tauri-apps/cef-rs>(crate `cef` 149)
- 同类适配器范例:<https://github.com/versotile-org/tauri-runtime-verso>
- 实战踩坑:<https://getatrium.dev/blog/embedding-real-browser-tauri>
