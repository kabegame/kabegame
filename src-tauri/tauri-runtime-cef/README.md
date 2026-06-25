# tauri-runtime-cef

**用 CEF(Chromium)替换 Tauri 在 Linux 桌面端的 webview 后端。**

这是一个 *适配器* crate:它在 [`tauri-runtime`](https://crates.io/crates/tauri-runtime) 的 trait 契约之上,用 [`cef`(tauri-apps/cef-rs)](https://github.com/tauri-apps/cef-rs) 实现一套 Chromium 渲染后端 —— 角色和官方的 `tauri-runtime-wry` 完全对等,只是引擎从系统 WebView 换成了内嵌 Chromium。

> 状态:**Phase 4.4 集成阶段**。`cef-backend` 已实现 Tauri runtime/window/webview
> 骨架、软件 OSR 渲染、自定义资源协议、browser-process initialization script
> 注入、鼠标/键盘/滚轮/GTK IME/光标转发、全 app builder 复用与 `invoke`
> IPC 往返,并接入 page-load hook 与 `cef-ipc://` CSP 放行。真实 CEF 代码挂在
> 默认关闭的 `cef-backend` feature 后面,避免非 Linux 目标或轻量检查下载
> Chromium。打包和完整 GUI smoke 仍在后续阶段。

---

## 1. 背景与动机

Tauri 刻意不打包渲染引擎,改用各平台自带的 WebView:

| 平台 | 引擎 |
|---|---|
| Windows | WebView2(本身就是 Chromium) |
| macOS | WKWebView(WebKit) |
| Linux | **WebKitGTK** |
| Android | 系统 WebView(Chromium) |

问题出在 **Linux 的 WebKitGTK**:

- **NVIDIA 渲染不丝滑**:即便用 `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE` 等环境变量绕过了崩溃,作为一个**图库**应用,滚动/渲染仍然不够顺滑。
- **难以定位的 native 崩溃**:在普通 UI 交互(例如打开一个下拉框)时出现

  ```
  free(): invalid pointer
  ```

  这是 **native 堆被写坏**(double-free / 越界),发生在 WebKitGTK 的 C++ 内部。Rust / JS 层**碰不到现场**,gdb 抓到的栈也全是 WebKit 符号 —— 无法在应用侧定位或修复。

由于 **Windows 本来就跑 Chromium(WebView2),macOS 的 WKWebView 一般没问题**,所以本方案**只替换 Linux 后端**,其余平台保持现状。

## 2. 技术调研结论

### 2.1 Tauri 的分层架构(可插拔 runtime)

Tauri 不是铁板一块,webview 后端是**官方支持的可插拔扩展点**:

```
  你的 kabegame(Vue UI + Rust #[command])
        │  只会说 invoke() / 事件 / 窗口 API
 ┌──────▼─────────────────────────────────────┐
 │  tauri  (框架本体)                          │  只认一个"插座":Runtime trait
 └──────┬─────────────────────────────────────┘
        │  Runtime / WebviewDispatch / WindowDispatch …  ← 契约
 ┌──────▼──────────────────┐   ┌───────────────▼────────────┐
 │  tauri-runtime-wry       │   │  tauri-runtime-cef ★本crate │  ← 适配器
 └──────┬──────────────────┘   └───────────────┬────────────┘
        │ 调用                                   │ 调用
 ┌──────▼──────────────────┐   ┌───────────────▼────────────┐
 │  wry  (引擎绑定)         │   │  cef  (cef-rs 引擎绑定)     │
 └──────┬──────────────────┘   └───────────────┬────────────┘
        │                                       │
   系统 WebView(WebKitGTK…)            CEF / Chromium 内核
```

源码证据(实测自 `tauri` 2.10.0,2.11.x 同理):

- `tauri` 永远依赖 `tauri-runtime`(纯 trait),而 `tauri-runtime-wry` 是 **optional**,挂在默认 feature `wry` 后面 → 可 `default-features = false` 摘掉。
- `Builder<R: Runtime>` 是**泛型**;`crates/tauri/src/app.rs` 里只有 `impl Default for Builder<crate::Wry>` 把"默认值"钉死成 wry,但 `impl<R: Runtime> Builder<R>` 允许任意 Runtime。`Wry` 自己也只是 `pub type Wry = tauri_runtime_wry::Wry<...>` 的别名。

→ **只要提供一个实现了 `Runtime` trait 的类型,Tauri 就认。** 官方的 `tauri-runtime-verso`(Servo 后端)正是以**仓库外独立 crate**的形式存在、对着发布版 Tauri 工作,从未 fork Tauri。

### 2.2 `cef`(cef-rs)做了什么,为什么还需要本 crate

- **`cef`(cef-rs)** = Chromium 内核(libcef,一个巨大的 C/C++ 库)的 **Rust FFI 绑定**:包装 C API、管理引用计数、把 CEF 的回调接口暴露成 Rust、并自动下载/链接官方**预编译** CEF 二进制。用它单独就能写一个弹出 Chromium 窗口加载网页的 Rust 程序(官方 `cefsimple` 例子)。
  → 它给你"一台能用 Rust 点火的 Chromium 引擎",但**完全不知道 Tauri 的存在**。

- **本 crate(`tauri-runtime-cef`)** = 把这台引擎装进 Tauri 底盘的**适配板 + 线束**。Tauri 框架要的不是"打开网页",而是一堆 Tauri 专属能力,必须有人翻译成 CEF 调用:

  | Tauri 框架要求 | 适配器要做的事 |
  |---|---|
  | 加载打包好的 Vue 前端(`tauri://` / `asset://` 自定义协议) | 注册 CEF `CefSchemeHandlerFactory`(见 `protocol.rs`) |
  | `invoke()` IPC(JS ↔ Rust `#[command]`) | `ipc://` custom protocol 透传 + `cef-ipc://` postMessage 后备(见 `protocol.rs` / `ipc.rs`) |
  | 注入 `window.__TAURI__` 启动脚本 | CEF load start 执行 `InitializationScript` |
  | 窗口/事件/devtools/eval/cookie…(~45+78 个 trait 方法) | 逐个映射到 CEF / tao API |

### 2.3 长期可维护方案(不 fork,只升版本号)

本 crate 谁的源码都不改。要"跟进"的是两条**官方主线**,且都只是改依赖版本号:

| 跟进对象 | 怎么跟进 | 是否 fork |
|---|---|---|
| **官方 Tauri** | `cargo update` 升 `tauri` / `tauri-runtime` | ❌ semver 依赖 |
| **官方 CEF / Chromium** | 升本 crate 的 `cef = "149"` 版本(cef-rs 拉对应预编译 Chromium) | ❌ |

唯一长期成本:`tauri-runtime` 的 trait 在 v2 小版本间**偶尔会微调**(源码中 cookie API 注释明确写了 "might receive updates in minor Tauri releases")。升 Tauri 时可能要跟着改本 crate 里**几个方法签名** —— 与"fork 整个 Tauri、每次升级解 merge 冲突"相比是两个量级的事。

> ⚠️ 不要"自己编译 CEF":那是一次完整 Chromium 构建(数小时 / 上百 GB / 专用机)。一律用 cef-rs 拉的官方预编译包,升级 = 改版本号。

## 3. 最终决策

1. **路线 A:只换 Linux 后端**(Windows/macOS 保持 WebView2 / WKWebView,不背 Chromium 的体积与复杂度)。
2. **落点**:`src-tauri/tauri-runtime-cef/`,加入根 `Cargo.toml` 的 workspace `members`(与 `kabegame-core` / `kabegame-cli` 同级)。
3. **独立 crate,不 fork Tauri**:只依赖发布版 `tauri-runtime`。克隆的 `tauri-tauri-v2.10.0` 源码仅作**参考范文**(从 `tauri-runtime-wry` 抄与引擎无关的窗口/事件循环样板,MIT/Apache 许可,注明出处)。
4. **双平台门控,锁死 Linux-only**:
   - **依赖门控** —— `src-tauri/kabegame/Cargo.toml`:
     ```toml
     [target.'cfg(target_os = "linux")'.dependencies]
     tauri-runtime-cef = { path = "../tauri-runtime-cef" }
     ```
     Android(`target_os = "android"`)与 Win/macOS 都不会拉它 → 永不编译 CEF / 不下载 Chromium。`cargo build -p kabegame`(`bun b` 按包构建)只编依赖树,未被依赖的成员不会被编。
   - **代码门控** —— kabegame 入口按平台分流 Builder:
     ```rust
     #[cfg(target_os = "linux")]
     let builder = tauri::Builder::<tauri_runtime_cef::Cef<_>>::new();
     #[cfg(not(target_os = "linux"))]
     let builder = tauri::Builder::default(); // = Wry
     ```
   - 小坑:在 macOS/Windows 上跑 `cargo build --workspace` 会顺带编译本 crate(cef-rs 跨平台,会去下载该平台 CEF,不报错但变慢)。按本仓库规约(用 lint 诊断、`bun check -c kabegame` 按包检查、不跑全量 build)日常碰不到。

## 4. 要实现的 trait 清单(工作量表面积)

实测自 `tauri-runtime`(~2500 行 trait)/ `tauri-runtime-wry`(~6500 行实现):

| trait | 方法数 | 与引擎相关? | 模块 |
|---|---|---|---|
| `Runtime<T>` | 11 | 部分(`create_webview` 接 CEF;其余接 tao) | `runtime.rs` |
| `RuntimeHandle<T>` / `EventLoopProxy<T>` | — | 线程转发到主线程 | `runtime.rs` |
| `WebviewDispatch<T>` | ~45 | **是,核心工作量** | `webview.rs` |
| `WindowDispatch<T>` | ~78 | 否,基本可抄 tao/wry | `window.rs` |
| `WindowBuilder` | ~53 | 否,基本可抄 | `window.rs` |

窗口/事件循环那一大半与引擎无关,可大段复用 `tauri-runtime-wry`;真正要重写的是 webview 部分。

## 5. 已知难点(CEF 特有,wry 已替你做掉)

1. **多进程架构**:CEF 是 browser + render + GPU 多进程,必须打包一个**独立 helper 子进程可执行文件**;helper 崩溃可能静默(白屏无日志),需自带 tracing / panic handler。
2. **IPC**:Tauri 2 优先使用 `fetch(ipc://localhost/<cmd>)`;CEF 侧必须把 method/body/header 原样转给 Tauri 的 URI scheme handler。`window.ipc.postMessage` fallback 由 `cef-ipc://` bridge 回调 `PendingWebview.ipc_handler`。
3. **自定义协议**:`tauri://` / `asset://` 用 `CefSchemeHandlerFactory` + 异步 `CefResourceHandler` 提供内置前端(`protocol.rs`)。
4. **init script 全帧注入**:走 render handler 的 `on_context_created`。
5. **message pump 调度**:reentrant pump 调用会 panic,需异步调度而非内联 pump。
6. **打包 / 体积**:CEF ≈ **+170 MB**;初始化重(数百 ms ~ 2s,可延迟到首帧后);`tauri-bundler` 的 Linux 产物(.deb / AppImage)要带上 CEF 运行时 + helper 子进程。
7. **devtools 是净收益**:CEF 自带 Chrome DevTools / CDP,比 WebKitGTK 强。

## 6. 路线图

- [x] **Phase 0 — 骨架**(本次):crate 结构、`Cargo.toml`、workspace 接入、与 wry 对齐的类型脚手架、本 README。
- [x] **Phase 1 — 环境验证**(已完成,2026-06-19):本机跑通上游 cef-rs 的 `cefsimple`,弹出 Chromium 149 窗口加载本地 HTML(截图见验收记录,中文 / emoji / `navigator.userAgent` 正常)。确认预编译 CEF 下载、链接、多进程运行、NVIDIA+Wayland 配置均 OK。详见 §7。
- [x] **Phase 2 — 最小闭环**(已完成 2026-06-20,**改走 OSR**):`cef-backend` feature 在本 crate 编译+链接通过;CEF windowless 渲染到 BGRA buffer(`on_paint`),用 `softbuffer` blit 到 tao 顶层窗口;external message pump 挂进 tao `run_return`。截图验证:中文/emoji/UA=Chrome149 满屏正确。见 `examples/minimal.rs` 与 §9。
  - ⚠️ **当前是纯软件渲染(无 GPU 加速)**,见 §9 的「GPU 现状与后续」。
- [ ] **Phase 3 — 前端可跑**:runtime/window/webview 骨架与软件 OSR 已落地;
  **Phase 3.1** 自定义 scheme handler + init script、**Phase 3.2** OSR 输入转发
  已完成。端到端启动与方法补齐继续按
  `.claude/plans/cef-linux-runtime/cef-linux-runtime-phase3.{3,4}.md` 推进。
- [x] **Phase 4 — IPC / 应用回归收口**(已完成到 4.4,2026-06-25):Linux CEF 入口复用全 app builder;`invoke()` 通过 `ipc://` custom protocol 命中 Rust 命令,并提供 `cef-ipc://` postMessage fallback;CEF CSP 与 page-load hook 已补齐。完整 GUI smoke 和打包继续看后续阶段。
- [ ] **Phase 5 — 补齐 dispatch**:窗口/webview 其余 trait 方法、devtools、cookie、事件。
- [ ] **Phase 6 — 打包**:`tauri-bundler` Linux 产物带 CEF + helper;签名 / 体积优化。

## 7. 构建前置条件(Phase 1 实测,2026-06-19)

> 实测环境:Ubuntu 25.10 / glibc 2.42 / x86_64,Rust 1.91.1,NVIDIA RTX 4070(driver 580),**KDE Plasma Wayland 会话**(带 XWayland `DISPLAY=:1`)。

### 7.1 工具链 / 版本

- Rust:cef-rs 的示例用 **edition 2024**(需 ≥1.85;本机 1.91.1 OK)。本 crate 自身用 edition 2021,但启用 `cef-backend` 后引入对较新工具链的要求。
- CEF 版本:`cef = 149.0.0+149.0.2`,对应 **Chromium 149.0.7827.53**。下载源 **`cef-builds.spotifycdn.com`**(Spotify CDN,**不是** GitHub,与本机 GitHub API 偶发超时无关),`.tar.bz2` + SHA1 校验。

### 7.2 一次性准备预编译 CEF(强烈建议,避免每个 crate 各下一份)

```sh
cd /home/cm/code/cef-rs                       # 上游 cef-rs 仓库
cargo run -p export-cef-dir -- --force "$HOME/.local/share/cef"
export CEF_PATH="$HOME/.local/share/cef"
export LD_LIBRARY_PATH="$CEF_PATH:$LD_LIBRARY_PATH"
```

- 解压后 `~/.local/share/cef` ≈ **1.5 GB**(含调试信息的 `libcef.so` 单文件 1.3 GB;`--release` bundle 会瘦身)。
- 关键产物:`libcef.so`、`*.pak`(resources/chrome_*）、`icudtl.dat`、`v8_context_snapshot.bin`、`locales/`、`chrome-sandbox`(SUID helper)、SwiftShader 软渲染兜底(`libvk_swiftshader.so` / `libvulkan.so.1`)。
- 设了 `CEF_PATH` 后,`cef-dll-sys` 的 `build.rs` 会**复用**它,不再重复下载。

### 7.3 跑通 `cefsimple`(脱离 Tauri 的地基验证)

```sh
cd /home/cm/code/cef-rs
cargo run --bin bundle-cef-app -- cefsimple -o target/bundle --release   # ~18s 增量
cd target/bundle
export LD_LIBRARY_PATH="$PWD:$LD_LIBRARY_PATH"
./cefsimple --no-sandbox --ozone-platform=x11 --url=file:///path/to/test.html
```

- Linux bundle 由 `bundle-cef-app` 把整个 CEF 运行时(`libcef.so`/`*.pak`/`locales/`…)+ 编译出的单一可执行文件拷到 `target/bundle/`。**Linux 上同一个二进制兼任 browser/render/GPU 子进程**,不像 macOS 需要独立 helper。
- 验证结果:进程起 **8 个子进程**(多进程 Chromium 正常),稳定常驻,加载 `file://` 本地 HTML 渲染成功(中文 / emoji / `Chrome/149.0.0.0`)。

### 7.4 运行期必备 flag(⚠️ 关键坑,会直接影响最终方案)

| flag | 为什么 | 不加的后果 |
|---|---|---|
| `--no-sandbox` | bundle 里的 `chrome-sandbox` 非 SUID root(`0755`)。默认 `sandbox` feature → `no_sandbox=0` 要求 SUID helper | sandbox 初始化失败 |
| `--ozone-platform=x11` | **NVIDIA + Wayland 的核心坑**:默认 ozone=wayland 时报 `'--ozone-platform=wayland' is not compatible with Vulkan`(`wayland_surface_factory.cc`)。强制 x11(走 XWayland)后**零报错、窗口稳定**。 | Wayland+Vulkan 合成路径冲突 |

> 这两条决定了 Phase 2+ 在 kabegame 里**必须**通过 `CefSettings` / command-line switches 注入(`no_sandbox=true`、`ozone-platform=x11`)。生产分发可二选一处理 sandbox:打包时 `chmod u+s chrome-sandbox`(需 root),或保持 `--no-sandbox`。x11 强制是 NVIDIA 机器的兜底,后续可探测 GPU 再决定是否放开 Wayland 原生。

### 7.5 终端用户机器所需系统库(Phase 6 打包用)

`libcef.so` 依赖一组标准桌面浏览器系统库(本机已全部满足):
`libgtk` 系、`libX11`/`libxcb`/`libxkbcommon`、`libnss3`/`libnspr4`、`libgbm`/`libdrm`(GPU)、`libasound`(音频)、`libcups`、`libdbus`、`libpango`/`libcairo`/`libatk`。
→ Phase 6 的 `.deb` 需声明这些依赖;AppImage 则需自带或依赖宿主。

### 7.6 本 crate 自身

- 真实 CEF 代码默认关闭。开启:`cargo check -p tauri-runtime-cef --features cef-backend`(会触发 cef-rs 工具链,设了 `CEF_PATH` 则复用、否则下载)。
- 体积:运行时 ≈ +170 MB(`--release` bundle 后)。

## 8. 参考资料

- 官方 CEF 绑定:<https://github.com/tauri-apps/cef-rs>(crate `cef`,当前 149 / Chromium 149)
  - 例子:`examples/cefsimple`、`examples/osr`(off-screen rendering)
- 官方 Verso 后端(同类适配器范例,基于 Servo):
  - <https://github.com/versotile-org/tauri-runtime-verso>
  - <https://v2.tauri.app/blog/tauri-verso-integration/>
- 实战踩坑(把 CEF 嵌入 Tauri):<https://getatrium.dev/blog/embedding-real-browser-tauri>
- Tauri 社区讨论:<https://github.com/tauri-apps/tauri/discussions/8524>
- 本地参考源码(只读范文,勿改):`/home/cm/code/tauri-tauri-v2.10.0`
  - trait 契约:`crates/tauri-runtime/src/{lib,webview,window}.rs`
  - wry 实现范文:`crates/tauri-runtime-wry/src/lib.rs`

## 9. Phase 2 实测结论与架构决策(2026-06-20)

### 9.1 三种窗口集成路径,实测取舍

| 路径 | 本机(NVIDIA RTX 4070 + KDE Wayland/XWayland)实测 | 结论 |
|---|---|---|
| **windowed 子窗口**(CEF parent 进 tao 的 GTK/X11 窗口) | 独立 GPU 进程 `exit_code=139`(SIGSEGV);改 `--in-process-gpu` 整进程段错误;回退软件呈现器又对 X11 子窗口 `XGetWindowAttributes failed`,只画背景 | ❌ 放弃(两条渲染路径全断) |
| **CEF 自建窗口**(Views/顶层) | GPU(Phase 1 cefsimple)与软件渲染都满屏正确 | ✅ 可用,但窗口归 CEF,丢 tao,作 GPU 备选(路线 A) |
| **OSR 离屏 + tao** ✅ 采用 | windowless 软件光栅 → `on_paint` BGRA → `softbuffer` blit 到 tao 顶层窗口;满屏正确,无崩溃 | ✅ **Phase 2 采用** |

判别实验:`examples/minimal.rs` 里 `PHASE2_NO_PARENT=1` 让 CEF 自建窗口 → 渲染正常;parent 进 tao → 失败。**问题精确定位在"parent 成 X11 子窗口"这条路**,非软件渲染本身。

### 9.2 ⚠️ GPU 现状与后续(关键)

**当前 OSR 走的是纯软件渲染,GPU 完全没用上**:
- `--disable-gpu`:CEF 用 Skia **CPU 光栅**(NVIDIA 的 GPU 进程在本机会崩,只能先关)。
- `on_paint` 把整帧 BGRA 通过 CPU 交给我们;`blit()` 再用 CPU 逐像素拷进 `softbuffer`。
- 后果:对**图库这种大图/滚动密集**场景,软件路径可能仍不够丝滑(高分辨率下每帧 CPU memcpy + 软件光栅是瓶颈)—— 这恰是本项目要解决的问题,**必须验证 GPU 路径**。

GPU 不是没戏(Phase 1 已证明本机 CEF 自建窗口 + GPU 正常),后续有两条加速路线:
1. **加速 OSR / shared texture**(首选,**已 spike 验证可用**):CEF 在 GPU 上渲染到一块共享纹理(dmabuf),通过 `on_accelerated_paint` 把**纹理句柄**(零 CPU 回读)交给我们,用 wgpu/GL 合成。即 cef-rs `examples/osr` 的 `accelerated_osr` + wgpu 路线。
2. **路线 A(CEF 自建窗口 + GPU)**:Phase 1 已证明可用,作为加速 OSR 失败时的兜底(代价见 §9.1)。

### 9.2.1 加速 OSR spike 结论(2026-06-20,本机 NVIDIA 验证)

直接跑 cef-rs 上游 `examples/osr`(`accelerated_osr` 默认开,wgpu + Vulkan dmabuf 导入)实测:

- **默认(ANGLE GL 后端):失败**。GPU 进程不崩,但反复报
  `OzoneImageBacking::ProduceSkiaGanesh failed to create GL representation` +
  `incompatible backing: CompoundImageBacking`,**`on_accelerated_paint` 被调用 0 次**(一帧 GPU 画面都产不出)。
- **加 `--use-angle=vulkan` + `--enable-features=Vulkan`:成功** ✅。
  `on_accelerated_paint` 正常回调、cef-rs 的 Vulkan 导入器 `import_texture` 返回 OK
  (**dmabuf 共享纹理零拷贝进 wgpu**)、**0 个 GPU 错误、不崩**。

> **结论**:GPU 加速 OSR(零 CPU 回读)在本机 NVIDIA 上**可行**,关键是强制
> **`--use-angle=vulkan`** 让 CEF 的 GPU 合成走 Vulkan,与 cef-rs 的 Vulkan dmabuf
> 导入器对齐(默认 GL/Ganesh 后端在 NVIDIA 上产不出共享纹理的 GL 表示)。
>
> 这意味着真正的 `tauri-runtime-cef` 渲染层应走 **accelerated OSR + wgpu**(而非
> Phase 2 minimal 的 softbuffer 软件 blit),才能拿到 GPU 加速、真正解决图库丝滑。
>
> （上游 osr 用 winit,窗口在 Wayland 下不易被 X 截图抓取,故当时以日志计数为证。）

### 9.2.2 ⚠️ 搬进本仓库后的修正结论(`examples/minimal_gpu.rs`,2026-06-20)

把 accelerated OSR + wgpu 用 **tao**(X11 可截图)搬进本 crate 后,得到比 §9.2.1 更完整、也更**谨慎**的结论:

- ✅ CEF 在 GPU 上持续出帧:`on_accelerated_paint` 连续回调(#1/#2/#3…),cef-rs 的
  **Vulkan dmabuf 导入 `import OK`**,**0 GPU 错误、不崩**(需 `--use-angle=vulkan`)。
- ❌ **但最终合成到窗口是纯黑**。即"GPU 渲染 + 零拷贝导入"通了,"采样导入的纹理上屏"没通。

根因(读 `cef/src/osr_texture_import/dmabuf.rs` 定位):该导入器创建 VkImage 时
**initialLayout = UNDEFINED,且不做 image layout 转换、无跨上下文同步 / 队列族
ownership(`VK_QUEUE_FAMILY_FOREIGN_EXT`)acquire**。于是 wgpu 首次采样时从
UNDEFINED 转换 layout → **NVIDIA 驱动丢弃 dmabuf 既有内容 → 黑屏**。这是 **cef-rs
导入器的真实缺陷**,非本 crate 的 bug。

> **修正结论**:加速 OSR 在本机"渲染+导入"层面可行,但 **cef-rs 现成的 dmabuf 导入器
> 不能直接把内容正确上屏**。要让它显示,需**修补导入路径**(正确的 image layout +
> 外部队列族 ownership acquire barrier + GPU 同步),属于较深的 Vulkan 工作,且要长期
> 维护一份打补丁的导入器。
>
> 当前各路径对照(GPU + 正确显示):
> - **路线 A(CEF 自建顶层窗口 + GPU)**:Phase 1 已证 ✅ 正确显示(代价:窗口归 CEF、丢 tao)。
> - **OSR + 软件渲染**:✅ 正确显示,但无 GPU(`examples/minimal.rs`)。
> - **OSR + GPU dmabuf**:导入 OK 但上屏黑(本节);需修 cef-rs 导入器。
> - **windowed 子窗口 + GPU**:❌ 崩(§9.1)。
>
> 待补:若修通 dmabuf layout/sync,再验持续渲染(滚动/视频)帧率与稳定性。

> TODO(Phase 2 minimal 自身):`examples/minimal.rs` 仍是软件 softbuffer 路径;
> 其 `blit()` 逐像素循环可优化(整行拷贝/SIMD 或让 softbuffer 直接吃 BGRA)。

### 9.3 Phase 2 交付物

- `examples/minimal.rs`:**软件 OSR** + tao 最小闭环 ✅ 正确显示(`PHASE2_NO_PARENT` / `PHASE2_URL` / `PHASE2_GPU_SWITCHES` 诊断开关)。
- `examples/minimal_gpu.rs`:**GPU 加速 OSR**(wgpu + Vulkan dmabuf 导入,`--use-angle=vulkan`);CEF 出帧+导入 OK 但上屏黑(§9.2.2),保留作 GPU 路径基线 + 复现。
- `Cargo.toml`:`cef-backend = ["dep:cef","dep:tao","dep:softbuffer"]`;`accelerated-osr = ["cef-backend","cef/accelerated_osr","dep:wgpu","dep:pollster","dep:bytemuck"]`。
- `src/{ipc,protocol}.rs`:占位(Phase 3/4 实现)。
- 运行期开关(经 `on_before_command_line_processing` 注入,见 README §7.4):软件版 `--ozone-platform=x11`/`--no-sandbox`/`--disable-gpu`;GPU 版 `--ozone-platform=x11`/`--no-sandbox`/`--use-angle=vulkan`/`--enable-features=Vulkan`。

## 9.4 ⚠️⚠️ 致命坑:内置 SQLite 符号冲突 → CEF 启动 SIGSEGV(2026-06-24,Phase 3.3)

**症状**:kabegame 接 CEF 后端后,启动时窗口闪现即退;直接跑二进制 SIGSEGV,日志停在 `[cef-runtime] first OSR frame`。`minimal.rs` / 上游 `cefsimple` / `osr` 都不崩。

**根因**(core dump + `eu-stack` 定位,栈不可用时勿信 gdb——它会被损坏的堆拖挂):
- 崩溃栈:`net::CertVerifyProcBuiltin → net::TrustStoreNSS::GetTrust → NSS_InitReadWrite → SECMOD_LoadModule → 系统 libsqlite3 → 调空指针`。
- CEF/Chromium 做 **TLS 证书验证**时用 NSS,softokn `dlopen` 系统 `libsqlite3` 打开 cert DB。
- **kabegame 静态链接了 rusqlite 的内置 SQLite(3.45.0),并把 51 个 `sqlite3_*` 导出到动态符号表**。主可执行文件符号全局优先级最高 → softokn 的 `sqlite3_*` 绑到了 kabegame 的 3.45.0,而非它编译时依赖的系统 3.46.1 → VFS/结构布局不匹配 → 空指针。
- `cefsimple`/`osr` 不链接 sqlite,所以用系统 libsqlite3,正常。证书验证启动即触发(与加载的页面无关,`about:blank` 也崩)。

**修复**(`src-tauri/kabegame/build.rs`,Linux + standard/light):linker version script 把 `sqlite3_*` 本地化:
```rust
std::fs::write(&map, "{\n  local:\n    sqlite3_*;\n};\n").unwrap();
println!("cargo:rustc-link-arg=-Wl,--version-script={}", map.display());
```
- 导出 `sqlite3_` 由 **51 → 0**;softokn 改绑系统 libsqlite3;kabegame 自身 rusqlite 走**静态解析**不受影响。
- 验证:不再崩,正确渲染 `https://example.com`(HTTPS+证书验证全通)。

**通用教训**:任何**静态链接 SQLite**(或其它系统库的不同版本)且导出其符号的 **Tauri/Electron 之外 + 嵌 Chromium/CEF** 应用,都可能在 NSS 证书验证时撞这个坑。排查口诀:`nm -D 主程序 | grep sqlite3_`;通用排查见同坑的其它系统库(libssl、libxml2 等)。

> 排障副产物:删除了多余且致崩的 `--single-process`(Chromium 单进程模式已弃用)。结论:**CEF crash 与 tao 运行时无关**,tao 路线成立。
