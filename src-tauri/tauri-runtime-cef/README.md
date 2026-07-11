# tauri-runtime-cef

Windows、macOS 与 Linux 桌面端的 Tauri runtime 适配器：统一使用 CEF/Chromium 作为 WebView 后端。

它实现 `tauri-runtime` trait，并在桌面 Kabegame GUI 的 `standard` 构建中被选用。Android 仍使用系统 WebView。

## Runtime 模型

CEF runtime 只支持一个渲染路径：**CEF Views/windowed**。

```text
Tauri Builder
  -> tauri-runtime-cef
    -> CEF Views Window
      -> CEF BrowserView
        -> Chromium GPU composition
```

- CEF 创建并拥有顶层原生窗口与 `BrowserView`；不创建 tao 顶层窗口。
- 窗口和 webview 操作统一通过 CEF UI 线程执行；主循环持续 pump 平台消息（Linux 为 GLib，Windows 为 Win32 message queue，macOS 为 NSApplication event queue）与 CEF。
- `BrowserView` 尺寸由 CEF Window client area 布局，不转发 tao resize、鼠标、键盘或 IME 事件。
- `KABEGAME_CEF_WINDOW_MODE` 已废弃且不再读取；CEF 始终 windowed。
- GPU 模式可用 `KABEGAME_CEF_GPU_MODE`（或 `CEF_WINDOWED_GPU_MODE`）覆盖：`default`（不加开关）/ `disabled` / 任意 ANGLE 后端名（`gl`、`d3d11`、`vulkan`…）。默认值：Linux `gl`（Vulkan 后端曾触发 GPU device-lost），Windows `default`（Chromium 自选，ANGLE D3D11）。
- 不包含替代的离屏渲染、软件帧缓冲或 dmabuf/wgpu 合成路径。

CEF `KeyboardHandler` 提供 DevTools 快捷键：macOS 使用 `Command+Shift+D`，
Windows/Linux 使用 `Ctrl+Shift+D`。

## Tauri 适配边界

| Tauri 能力 | CEF 实现 |
| --- | --- |
| 前端资源 | 全局 scheme handler factory 服务前端/asset 资源。Linux/macOS 走自定义 scheme（`tauri://localhost` / `asset://localhost`）；Windows 上 Tauri core 把自定义 scheme `X` 改写为 `http://X.localhost`（见 `tauri` manager `webview.rs`），故 CEF 改为对 `http` scheme + `X.localhost` 域注册 factory（`protocol::cef_scheme_and_domain`），否则 `http://tauri.localhost` 会当成真实网络请求 → `ERR_CONNECTION_REFUSED` |
| `invoke()` | `ipc://` 主路径与 `cef-ipc://` postMessage 后备桥接；内部 IPC scheme 允许绕过页面 CSP，以支持 surf 等第三方页面中的 Tauri IPC |
| 初始化脚本 | browser 创建时通过版本化 `extra_info` 传给 renderer，在每个新 V8 context 的 `RenderProcessHandler::on_context_created` 中同步执行，保证首次加载、刷新与跨页面导航均为 document-start |
| 页面生命周期 | `LoadHandler` 映射到 Tauri page-load hook |
| Cookie API | CEF 全局 `CookieManager` 映射到 Tauri `cookies_for_url` / `cookies` / `set_cookie` / `delete_cookie` |
| 窗口事件 | CEF `WindowDelegate` 回流为 Tauri runtime events |
| Raw window handle | Linux 返回 Xlib window，Windows 返回 Win32 HWND（+HINSTANCE）；macOS CEF Views 暂不暴露 NSView，返回 unavailable |

## 平台门控

`src-tauri/kabegame/Cargo.toml` 在 Windows、macOS 与 Linux 声明本 crate；应用入口在桌面 `standard` 下使用：

```rust
tauri::Builder::<tauri_runtime_cef::Cef<tauri::EventLoopMessage>>::new()
```

Android 不会把 CEF 放入 Kabegame 的依赖树。

## macOS 运行模型

- browser 主进程必须从 `.app/Contents/MacOS/kabegame` 启动；裸 `target/debug/kabegame` 不能运行。
- `execute_cef_subprocess_and_exit()` 会先用 `LibraryLoader` 加载 app 内 framework，再创建实现 `CefAppProtocol` 的 `KabegameCefApplication`。macOS browser 主进程不调用 `execute_process`。
- `Settings.browser_subprocess_path` 固定指向 `Kabegame Helper.app`；renderer/GPU/utility 全部由独立 `cef-helper` 处理。helper 同时承载初始化脚本的 renderer-side `on_context_created` hook。
- runtime 使用 `external_message_pump=1`，每轮非阻塞排空 NSApplication event queue，再执行 `do_message_loop_work()`。
- dev 的 `gen/Kabegame.app` 使用指向 `CEF_PATH` 的 framework 符号链接，因此 `framework_dir_path` 必须是 canonicalize 后的真实路径。

## Windows 注意事项

- **application manifest 是硬性要求**。Chromium GPU 进程用 `WS_EX_LAYERED` 子窗口做
  DirectComposition 呈现（`ui/gl/child_window_win.cc`），layered 子窗口只对声明了
  Windows 8+ 兼容性（`<compatibility>` supportedOS）的进程开放；不带 manifest 的
  cargo 默认 exe 会让 GPU 进程 `CreateWindowEx` 失败 → NOTREACHED 崩溃循环
  （CEF #3765）。`cef-example` crate 的 `build.rs` 为其二进制嵌入
  `windows-app.manifest`（本文件仍放在 `tauri-runtime-cef/`,供两处共享）；
  kabegame.exe 由 tauri-build 的
  `WindowsAttributes::app_manifest` 注入同样的段（`src-tauri/kabegame/windows-app.manifest`）。
- CEF 子进程 = re-exec 本 exe（`browser_subprocess_path`），`execute_cef_subprocess_and_exit()`
  必须在 `main` 最早期调用（与 Linux 相同）。Windows 无 zygote，`no-zygote` 开关仅 Linux 追加。
- cookies/localStorage 落 `%LOCALAPPDATA%\kabegame-cef`（Linux 为 XDG cache）。
  **dev 与安装态目录必须分开**：CEF 是 Chrome runtime，`cef_initialize` 会在该目录建
  Chrome profile 并注册进程级 ProcessSingleton（单实例锁）。若 `bun dev` 与已安装正式版
  共用目录，后启动者会命中对方 singleton → `Opening in existing browser session.` →
  `cef_initialize` 返回 false → panic。故按构建 profile 隔离：debug（`bun dev`）用
  `kabegame-cef-dev`，release（安装态）用 `kabegame-cef`（见 `cef_cache_dir_name`）。
- **前端/asset scheme 与 Linux 不同**：Windows/Android 上 Tauri core 用 `http://<scheme>.localhost`
  提供自定义 scheme 资源（`tauri_protocol_url` / `window_origin` 改写，默认 `http`，
  由 `use_https_scheme` 决定 http/https），主框架加载的是 `http://tauri.localhost`。因此
  `protocol.rs` 在 Windows 对 `http` scheme + `<scheme>.localhost` 域注册 factory，而非
  自定义 scheme（否则连接被当真实网络请求 → `ERR_CONNECTION_REFUSED`，页面 refused/白屏）。
  `cef-ipc`（runtime 自有 postMessage 通道）在所有平台仍是自定义 scheme。
- **请求 URI 还原**：Tauri 的 handler 仍按自定义 scheme 约定解析 URI（`protocol/tauri.rs`
  对整串 `strip_prefix("tauri://localhost")`）。CEF 拿到的是 `http://tauri.localhost/...`，
  strip 失败 → 空路径 → 回退 `index.html`（JS 模块被当 `text/html` → MIME 报错）。故
  `request_to_http` 在 Windows 把 `http(s)://<scheme>.localhost/<path>` 还原为
  `<scheme>://localhost/<path>` 再交给 handler，与 wry 行为对齐。
- `WindowBuilder::owner` / `parent` 通过创建后的 `SetWindowLongPtrW(GWLP_HWNDPARENT)` /
  `SetParent` 尽力实现（CEF Views 不暴露创建参数）；kabegame 当前无调用方。
  `shadow` 无运行时等价物，no-op。不设置 AppUserModelID（与 tauri-runtime-wry 对齐，
  由安装器快捷方式承载）。

## 开发与校验

`tauri-runtime-cef` crate 本身就是 CEF 后端，不再需要额外 backend feature：

```bash
CEF_PATH=... cargo check -p tauri-runtime-cef
```

`cef-rs` 默认下载对应的官方预编译 CEF（**不含 H.264/AAC**）；必须设置 `CEF_PATH` 指向自编运行时目录（见 `.cursor/rules/cef-path-set.mdc`）。构建脚本回退约定：Linux `~/i/cef-{dev,prod}`，Windows `H:\cef-{dev,prod}`，macOS `/Volumes/KIOXIA/cef-{dev,prod}`（`scripts/plugins/mode-plugin.ts`）。

Windows 构建 `libcef_dll_wrapper` 需要 cmake + ninja + MSVC；cef-dll-sys 的 build.rs 会把整个 CEF runtime 拷进 `target/{debug,release}/`，dev 运行免手工拷贝。

CEF 是多进程运行时。`execute_cef_subprocess_and_exit()` 必须在应用 `main` 的最早阶段执行；Linux/Windows 在此派发 re-exec 子进程，macOS 在此完成 framework 与 NSApplication 的 browser 进程早期初始化。

## Example / demo(`cef-example` / `cef-helper`)

独立于本 crate 的两个 workspace 成员,用于在不接入 Tauri 的情况下验证 CEF 自身的窗口/多进程链路(Linux/Windows/macOS 三平台):

- `src-tauri/cef-example`:浏览器(主)进程,CEF Views 顶层窗口 + 事件测试页。
- `src-tauri/cef-helper`:唯一的 CEF 子进程入口(renderer/GPU/utility)。三平台都用**独立于主进程的可执行文件**,主进程不会重新执行自己 —— macOS 要求子进程是独立 helper(且主进程需在 `.app` bundle 内运行),Linux/Windows 沿用同一套模型以保持三平台代码路径一致。

运行:

```bash
bun b -c cef-helper       # 先构建 helper(cef-example 会检查其存在,不会代为构建)
bun b -c cef-example       # Linux/Windows:cargo build;macOS:另在 gen/CEFExample.app 生成最小 bundle(含 Helper.app、CEF 框架符号链接)
bun start -c cef-example   # Linux/Windows:cargo run;macOS:直接运行 gen/CEFExample.app(需先 bun b)
```

macOS 上 `cargo run -p cef-example` 不可用 —— CEF 浏览器进程要求运行于 app bundle 内(读取主 bundle Info.plist),裸 exe 直跑不成立,详见 `scripts/plugins/os-plugin.ts` 的 `buildCEFExampleApp`。

macOS 适配的四个硬性要点(实测踩坑,移植主 runtime 时同样适用):

1. **运行时加载框架**:cef-dll-sys 在 macOS 不链接 libcef,任何 CEF 调用(含 `api_hash`)之前必须先 `cef::library_loader::LibraryLoader::load()`;主进程 `helper=false`(解析 `../Frameworks`),helper 进程 `helper=true`(解析 `../../..`)。顺序错了直接 SIGSEGV(跳零地址)。
2. **helper 变体**:Chromium 按子进程类型选 helper `.app` **变体**(renderer 找 `<name> Helper (Renderer).app`,另有 GPU/Plugin/Alerts/plain 共 5 个,见 cef-rs `build_util/mac.rs` 的 `HELPERS`)。变体缺失时 renderer 启动**静默失败**,初始导航 `ERR_ABORTED`、页面黑屏且无任何错误日志。五个变体可共用同一二进制。
3. **CefAppProtocol NSApplication**:`cef_initialize` 前必须用实现 `CrAppProtocol`/`CrAppControlProtocol`/`CefAppProtocol`(binding 在 `cef::application_mac`)的 NSApplication 子类创建 shared application(cefsimple 的 `SimpleApplication` 等价物),否则窗口无标题栏按钮、事件循环异常。注意类注册要在框架加载之后(协议由 libcef 注册)。
4. **framework_dir_path 与符号链接**:bundle 内框架若是符号链接(dev 模式指向 CEF_PATH),`Settings.framework_dir_path` 必须显式设为 canonicalize 后的真实路径,与 LibraryLoader 实际加载路径一致;留空(走 bundle 默认符号链接路径)会导致 GPU 合成黑屏(JS/输入正常、画面全黑)。发布打包时框架整份拷入 bundle 则无此问题。

另:dev 下追加 `use-mock-keychain` 开关,避免 Chromium Safe Storage 初始化弹系统 Keychain 密码框。example 仍使用 CEF 自持 `run_message_loop`；主 runtime 已实现 CefAppProtocol NSApplication external pump。

cef-rs `wrap_window_delegate!` 的宏默认值坑(未实现的方法一律返回 0):macOS 上 `with_standard_window_buttons` 默认 0 → 窗口没有红绿灯;`can_resize`/`can_maximize`/`can_minimize` 默认 0 → 绿灯置灰、窗口不可缩放。Views 窗口 delegate 需要显式实现这些方法返回 1。

## 打包

- **Linux**：`bin/linux/` 收集 `libcef.so` + 资源 + locales 白名单，注入 deb 到 `/usr/lib/kabegame/`（见 `cocs/build/PLATFORM_SHARED_LIBS.md`）。
- **Windows**：`scripts/plugins/os-plugin.ts` 的 `collectWindowsCefRuntime()` 把 `WINDOWS_CEF_RUNTIME_FILES` + locales 白名单收进 `src-tauri/kabegame/resources/cef/`，随 `resources/**/*` 进 NSIS 安装包；`nsis/installer-hooks.nsh` 的 POSTINSTALL 再把它们搬到 `$INSTDIR`（exe 同目录）与 `$INSTDIR\locales\`。
- **macOS dev**：`bun dev -c kabegame` 显式 cargo build 后生成 `gen/Kabegame.app`，框架使用 `CEF_PATH` 符号链接，随后自行启动 Vite 和 app 内可执行文件。前端保留 HMR，Rust 修改需重启命令。`Contents/Resources` 为真实目录（逐项符号链接 crate 内容），根下必须有 `icon.icns` + `CFBundleIconFile`：CEF Views 的 `set_window_app_icon` 只在运行期设 Dock 图标，Chromium 下载进度的 NSDockTile 重绘用的是 bundle 图标（`imageNamed:NSApplicationIcon`），bundle 无图标会在启动闪默认图标、下载时打回空白。
- **macOS release**：Tauri 在打 dmg 前通过原生 `macOS.frameworks`/`macOS.files` 将 CEF framework 与 5 个 helper app 变体注入 `Contents/Frameworks/`；dmg 一次成型，无需事后手术或重签。Apple Silicon linker 的 ad-hoc 签名在未改写 Mach-O 时天然有效。

## 当前限制

- CEF Views 对部分 Tauri window API 没有等价能力；运行时对这些 API 返回保守值或 no-op。
- Linux CEF 窗口固定采用 X11/ANGLE GL 配置；原生 Wayland 路径尚未接入。
- Windows 下 tauri `theme` 恒报 Light；`shadow` / `drag_and_drop` 为 best-effort。
