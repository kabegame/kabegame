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
| `invoke()` | 普通 invoke 强制走 `cef-ipc://` postMessage(JSON)桥（`ipc.rs::force_postmessage_ipc_transport`：上游 `fetch(ipc://)` 路径的 `Tauri-*` 自定义头触发 CORS 预检，而 CEF scheme handler 收不到 network process 发起的 preflight → `ERR_UNKNOWN_URL_SCHEME`）；**二进制 body**（`InvokeBody::Raw`，如 `crawl_fs_fwrite` 流式写）走 `cef-ipc://localhost/raw` 帧化通道——元数据在 body 前缀、请求零自定义头不触发预检，Rust 侧解帧后转发给 Tauri `ipc` 协议 handler（完整 invoke 解析 + ACL），页面侧入口为 shim 注入的 `window.__kb_raw_invoke__`；内部 IPC scheme 允许绕过页面 CSP，以支持 surf 等第三方页面中的 Tauri IPC |
| 初始化脚本 | browser 创建时通过版本化 `extra_info` 传给 renderer，在每个新 V8 context 的 `RenderProcessHandler::on_context_created` 中同步执行，保证首次加载、刷新与跨页面导航均为 document-start |
| 页面生命周期 | `LoadHandler` 映射到 Tauri page-load hook |
| Cookie API | CEF 全局 `CookieManager` 映射到 Tauri `cookies_for_url` / `cookies` / `set_cookie` / `delete_cookie` |
| 窗口事件 | CEF `WindowDelegate` 回流为 Tauri runtime events |
| Linux 窗口身份 | CEF Views 默认不设 X11 `WM_CLASS` / Wayland app_id，桌面环境无法把窗口关联到 `.desktop`（任务栏双条目、StartupNotify 转圈超时）；`WindowDelegate::get_linux_window_properties` 显式提供（优先 `RuntimeInitArgs::app_id`，回退可执行文件名），deb 模板 `StartupWMClass={{exec}}` 与之匹配 |
| Raw window handle | Linux 返回 Xlib window，Windows 返回 Win32 HWND（+HINSTANCE）；macOS CEF Views 暂不暴露 NSView，返回 unavailable |
| 文件拖放 | `TauriCefDragHandler` 把 CEF 的拖放回调翻成 Tauri 的四态 `WindowEvent::DragDrop`（Enter/Over/Drop/Leave），前端 `onDragDropEvent` 因此可用。挂载与否遵循 `webview_attributes.drag_drop_handler_enabled`（默认 true），关掉即回落 CEF 默认行为。**依赖 `third-patches/cef/0002`**：上游 CEF 只有 `OnDragEnter`，它唯一的能力是取消整个拖放，既拿不到落点也无法在保留拖放的前提下抑制 Chromium 默认的「导航到被拖入的文件」；patch 补出 `OnDragOver`/`OnDragLeave`/`OnDrop`，`OnDrop` 返回 true 即中止投递给渲染进程。语义对齐 wry 的 `with_drag_drop_handler`。Enter 回调不带坐标，按原点上报（紧随的首个 Over 会带来真实位置）；Drop 不带坐标，沿用最后一次 Over 的位置 |
| 渲染进程看门狗 | `TauriCefRequestHandler` 对所有 webview 无条件挂载（导航闸门为可选字段）。`on_render_process_unresponsive`（渲染进程约 15s 未回执输入）直接 `terminate()`；`on_render_process_terminated`（含真崩溃）自动 `browser.reload()` 恢复。`crawler-*` 标签的隐藏爬虫窗口在两个回调中均被排除——其卡死由 kabegame-core 调度器的 60s/120s 心跳看门狗判定并结束任务（见 `cocs/crawler/CRAWLER_JS_FLOW.md` 3.6） |

## 平台门控

`src-tauri/kabegame/Cargo.toml` 在 Windows、macOS 与 Linux 声明本 crate；应用入口在桌面 `standard` 下使用：

```rust
tauri::Builder::<tauri_runtime_cef::Cef<tauri::EventLoopMessage>>::new()
```

Android 不会把 CEF 放入 Kabegame 的依赖树。

## macOS 运行模型

- libcef 由**构建期直链**（`third/cef-rs` 的 cef-dll-sys，经 `third-patches/cef-rs/0001`）：framework 的 install_name `@executable_path/../Frameworks/Chromium Embedded Framework.framework/...` 写入 exe 的 LC_LOAD_DYLIB，dev 经 cef-dll-sys build.rs 创建的 `target/Frameworks` 符号链接（→ `$CEF_PATH`）解析，release 经 bundle `Contents/Frameworks/` 解析。dyld 在 `main` 前完成绑定——不存在 `LibraryLoader` 加载顺序问题，`cef_load_library` 在 fork 里是 no-op stub。
- browser 主进程 dev 下直接裸跑 `target/debug/kabegame`（不再生成 `gen/Kabegame.app`）；release 打包仍是 `.app`。裸跑时 `src-tauri/kabegame/macos/embedded-Info.plist` 经 `-sectcreate __TEXT __info_plist` 内嵌进 exe，提供 Retina/进程名/GPU 切换元数据（bundle 内运行时以 bundle 的 Info.plist 为准）。
- `dispatch_cef_subprocess()` 创建实现 `CefAppProtocol` 的 `KabegameCefApplication`。macOS browser 主进程不调用 `execute_process`。
- `Settings.browser_subprocess_path` 指向 exe 旁的扁平 `kabegame-cef-helper`（与 Linux/Windows 相同布局）；renderer/GPU/utility 全部由它承载，helper 与 browser 复用 runtime 内唯一的 `CefRuntimeApp` 和 renderer initialization-script handler。**release（bundled）依赖 `third-patches/cef/0001-flat-subprocess-path.patch`**（见「CEF 依赖与 patch」），否则 Chromium 会把路径改写为 5 个 helper `.app` 变体；dev 裸跑时 `AmIBundled()==false`，stock CEF 本就不做变体改写。
- runtime 使用 `external_message_pump=1`，每轮非阻塞排空 NSApplication event queue，再执行 `do_message_loop_work()`。
- `framework_dir_path` 仍显式设为 canonicalize 后的真实路径（dev 的 `target/Frameworks` 是符号链接），与 dyld 实际加载路径一致；留空或不一致会导致 GPU 合成黑屏（JS/输入正常、画面全黑）。

## Windows 注意事项

- **application manifest 是硬性要求**。Chromium GPU 进程用 `WS_EX_LAYERED` 子窗口做
  DirectComposition 呈现（`ui/gl/child_window_win.cc`），layered 子窗口只对声明了
  Windows 8+ 兼容性（`<compatibility>` supportedOS）的进程开放；不带 manifest 的
  cargo 默认 exe 会让 GPU 进程 `CreateWindowEx` 失败 → NOTREACHED 崩溃循环
  （CEF #3765）。`kabegame` package 的 build.rs 通过 tauri-build
  `WindowsAttributes::app_manifest` 同时为主程序、helper 和 Cargo example target 注入
  `src-tauri/kabegame/windows-app.manifest`。
- CEF 子进程 = exe 旁的独立 `kabegame-cef-helper.exe`（`browser_subprocess_path`，三平台统一），
  `dispatch_cef_subprocess()` 必须在 `main` 最早期调用（与 Linux 相同）。Windows 无
  zygote，`no-zygote` 开关仅 Linux 追加。
- cookies/localStorage 落 `%LOCALAPPDATA%\kabegame-cef`（Linux 为 XDG cache）。
  **dev 与安装态目录必须分开**：CEF 是 Chrome runtime，`cef_initialize` 会在该目录建
  Chrome profile 并注册进程级 ProcessSingleton（单实例锁）。若 `deno task dev` 与已安装正式版
  共用目录，后启动者会命中对方 singleton → `Opening in existing browser session.` →
  `cef_initialize` 返回 false → panic。故按构建 profile 隔离：debug（`deno task dev`）用
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

`cef-rs` 默认下载对应的官方预编译 CEF（**不含 H.264/AAC**）；必须设置 `CEF_PATH` 指向自编运行时目录（见 `.cursor/rules/cef-path-set.mdc`）。默认目录统一为 `bin/{platform}/{arch}/cef-build-{dev,prod}`（`scripts/plugins/mode-plugin.ts`）。

Windows 构建 `libcef_dll_wrapper` 需要 cmake + ninja + MSVC；cef-dll-sys 的 build.rs 会把整个 CEF runtime 拷进 `target/{debug,release}/`，dev 运行免手工拷贝。

CEF 是多进程运行时。`dispatch_cef_subprocess()` 必须在 Tauri Builder 前执行 browser 初始化；三平台的子进程都由 `kabegame` package 内的独立 `kabegame-cef-helper` binary 承载，macOS 额外完成 CefAppProtocol NSApplication 的早期初始化。

## Example / demo

`cef-example` 是 `kabegame` package 的 Cargo example target，配合 `kabegame-cef-helper` binary target，用于在不接入 Tauri 的情况下验证 CEF 自身的窗口/多进程链路:

- `examples/cef-example.rs`:浏览器(主)进程,CEF Views 顶层窗口 + 事件测试页。
- `src/bin/kabegame-cef-helper.rs`:极薄的 CEF 子进程入口，调用 runtime 的 `run_cef_subprocess()`。

运行(三平台一致):

```bash
CEF_PATH=... cargo build -p kabegame --features standard --bin kabegame-cef-helper
CEF_PATH=... cargo run -p kabegame --features standard --example cef-example
```

macOS 适配的硬性要点(实测踩坑,移植主 runtime 时同样适用):

1. **构建期直链框架**:cef-dll-sys(`third/cef-rs` + `third-patches/cef-rs`)在 macOS 直接链接 framework 二进制,dyld 按 LC_LOAD_DYLIB(install_name `@executable_path/../Frameworks/...`)在 `main` 前加载。dev 裸跑依赖 `target/Frameworks` 符号链接(build.rs 自动创建/校正指向 `$CEF_PATH`);切换 `CEF_PATH` 会触发 cef-dll-sys 重跑并更新链接。历史上的运行时 `LibraryLoader` 加载顺序坑(先调 CEF API → SIGSEGV 跳零地址)已随直链消失。
2. **helper 变体改写已被 patch 豁免**:stock Chromium 在 bundled 状态下按子进程类型改写路径找 `<name> Helper (Renderer).app` 等 5 个 `.app` 变体,变体缺失时 renderer **静默失败**(初始导航 `ERR_ABORTED`、黑屏无日志)。`third/cef` 的 `kabegame_flat_subprocess_path` patch 让显式 `browser_subprocess_path` 对所有子进程类型原样生效,单一扁平 `kabegame-cef-helper` 即可;dev 裸跑(非 bundled)时 stock CEF 本就不改写,不依赖该 patch。
3. **CefAppProtocol NSApplication**:`cef_initialize` 前必须用实现 `CrAppProtocol`/`CrAppControlProtocol`/`CefAppProtocol`(binding 在 `cef::application_mac`)的 NSApplication 子类创建 shared application(cefsimple 的 `SimpleApplication` 等价物),否则窗口无标题栏按钮、事件循环异常。协议类由 libcef 注册,直链模式下 dyld 已在 `main` 前加载 libcef,无时序约束。
4. **framework_dir_path 与符号链接**:`target/Frameworks`(dev)是符号链接,`Settings.framework_dir_path` 必须显式设为 canonicalize 后的真实路径,与 dyld 实际加载路径一致;留空或不一致会导致 GPU 合成黑屏(JS/输入正常、画面全黑)。发布打包时框架整份拷入 bundle 则无此问题。
5. **裸跑 exe 的 Info.plist**:`kabegame/build.rs` 按 binary 分别嵌入主程序/example plist 与带 `LSUIElement` 的 helper plist(`-sectcreate __TEXT __info_plist`);bundle id 一致性见第 6 点。
6. **MachPortRendezvous 的 bundle id 一致性**(实测踩坑,症状是窗口壳正常但内容全空/黑屏):Chromium 子进程通过 bootstrap 服务 `<BaseBundleID>.MachPortRendezvousServer.<browser pid>` 从 browser 拿 Mojo/共享内存句柄;不一致时子进程 `bootstrap_look_up ... Unknown service name (1102)`、起来即退、"Network service crashed" 循环。**browser 注册名与子进程查找名必须完全相同**,而这个 id 有四处来源,全部必须等于 `tauri.conf.json.handlebars` 的桌面 `identifier`(当前 `Kabegame`,也即 release `.app/Contents/Info.plist` 的 `CFBundleIdentifier`,是 release 下 browser 的注册名):
   - `kabegame/macos/embedded-Info.plist`(主程序 / example 裸跑内嵌 plist);
   - `kabegame/macos/kabegame-cef-helper-Info.plist`(helper 内嵌 plist;**实测子进程即使位于 `.app` 内也优先取内嵌 `__info_plist` 而非 bundle 的 Info.plist**,这是 release 黑屏的直接原因);
   - `runtime.rs` 的 `macos_unbundled_main_bundle` 生成的 `<exe>/kabegame-main-bundle/Contents/Info.plist`(仅裸跑,配合 `settings.main_bundle_path` 令 browser 注册名对齐);
   - 上述 tauri 桌面 `identifier` 本身。

   改动 identifier 时四处同步。dev 裸跑与 release bundled 走的注册名来源不同(前者是生成的 main-bundle,后者是 `.app` 的 Info.plist),但只要四者同值即两条路径都成立。

另:dev 下追加 `use-mock-keychain` 开关,避免 Chromium Safe Storage 初始化弹系统 Keychain 密码框。example 仍使用 CEF 自持 `run_message_loop`；主 runtime 已实现 CefAppProtocol NSApplication external pump。

cef-rs `wrap_window_delegate!` 的宏默认值坑(未实现的方法一律返回 0):macOS 上 `with_standard_window_buttons` 默认 0 → 窗口没有红绿灯;`can_resize`/`can_maximize`/`can_minimize` 默认 0 → 绿灯置灰、窗口不可缩放。Views 窗口 delegate 需要显式实现这些方法返回 1。

## 打包

- **Linux**：`bin/linux/` 收集 `libcef.so` + 资源 + locales 白名单，注入 deb 到 `/usr/lib/kabegame/`（见 `cocs/build/PLATFORM_SHARED_LIBS.md`）。
- **Windows**：`scripts/plugins/os-plugin.ts` 的 `collectWindowsCefRuntime()` 把 `WINDOWS_CEF_RUNTIME_FILES` + locales 白名单收进 `src-tauri/kabegame/resources/cef/`，随 `resources/**/*` 进 NSIS 安装包；`nsis/installer-hooks.nsh` 的 POSTINSTALL 再把它们搬到 `$INSTDIR`（exe 同目录）与 `$INSTDIR\locales\`。
- **macOS dev**：`deno task dev -c kabegame` 的 ComponentPlugin `beforeBuild` 先构建 `kabegame-cef-helper`，再直接运行裸 `target/debug/kabegame`。CEF framework 经 `target/Frameworks` 符号链接由 dyld 解析，helper 在同目录。
- **macOS release**：Tauri 在打 dmg 前通过原生 `macOS.frameworks` 注入 CEF framework 到 `Contents/Frameworks/`，`macOS.files` 把单一扁平 `kabegame-cef-helper` 放进 `Contents/MacOS/`；扁平 helper 依赖含 `kabegame_flat_subprocess_path` patch 的 CEF 构建。

## CEF 依赖与 patch(`third/cef-rs`、`third/cef`)

两个子模块**都直接 pin 官方上游**，Kabegame 的分歧一律以编号 patch series 独立维护，
submodule 的 gitlink 永远不提交本地改动：

- **`third/cef-rs`**跟随官方 `tauri-apps/cef-rs` 的 `149-wrapper-path` 分支，pin 在
  `ed6cd5b`。Kabegame 的改动位于 `third-patches/cef-rs/`：
  - `0001-direct-link-cef-framework-macos.patch`：cef-dll-sys 在 macOS 改为构建期直链
    framework(`rustc-link-lib=framework`)、提供 no-op `cef_load_library` stub、
    不再跑 cmake 编 `cef_dll_wrapper`。
  - `0002-recreate-env-gate.patch`：创建/校正 `target/Frameworks` 符号链接，并用
    `CEF_PATH`/`FLATPAK` 门控「是否允许改指向已存在的链接」——没配置时只在缺失或悬空
    才建，避免后台 `cargo check`(rust-analyzer)把运行时 framework 悄悄换成官方无编解码器的构建。
  - `0003-drag-handler-bindings-macos.patch`：重新生成的 macOS bindings，带上
    `third-patches/cef/0002` 给 `CefDragHandler` 加的三个回调。

  根 `Cargo.toml` 以 `[patch.crates-io]` 同时接入 `cef-dll-sys = { path = "third/cef-rs/sys" }`
  与 `cef = { path = "third/cef-rs/cef" }`——**两层必须同源**：只 patch sys 而让安全层走
  registry 会让新回调在 Rust 侧不存在、且两份 bindings 对同一个 C 结构体的字段数不一致。
  与 `third/cef` 不同，这里的 bindings **必须**进 patch series：`{cef,sys}/src/bindings/*.rs`
  是入库源码、被上面的 path patch 直接编译，不打就编不过。Linux/Windows bindings 尚未重生成
  （需在各自平台跑 `update-bindings`），故 `tauri-runtime-cef` 目前只在 macOS 可构建。
- **`third/cef`**直接跟随官方 `chromiumembedded/cef` 的 `7827` 分支，pin 在
  `0d0eeb611`（Chromium 149.0.7827.201）。Kabegame 的改动位于
  `third-patches/cef/`：
  - `0001-flat-subprocess-path.patch`：向 CEF patch 配置加入
    `kabegame_flat_subprocess_path`，令 `ChildProcessHost::GetChildPath()` 读到显式
    `--browser-subprocess-path` 时原样返回，跳过 macOS helper `.app` 变体改写。
    **只影响 release(bundled)**；dev 裸跑不依赖。
  - `0002-drag-drop-client-events.patch`：给 `CefDragHandler` 补 `OnDragOver` /
    `OnDragLeave` / `OnDrop`（`added=experimental`），让 client 能观察完整拖放序列
    并消费落点。详见 `third-patches/cef/README.md`。生成的 C API 与 `libcef_dll`
    胶水不入 patch——它们由 `cef_create_projects.sh` 里的 `version_manager.py` 产出。

`scripts/build-chromium.ts` 在构建前以仓库内 `third/cef` 为本地源码引用:
把它的路径和当前提交分别传给 `automate-git.py --url` / `--checkout`。首次或
`--clean` 构建会从该引用创建 `third/chromium/chromium_git/cef`，增量构建会把已有
checkout 的 origin 校正到该引用、同步当前提交，并由 CEF 标准 patch 流程将
`kabegame_flat_subprocess_path` 应用到 Chromium 源码。构建前需初始化子模块并手动
应用 Kabegame patch series：

```bash
git submodule update --init third/cef
deno task patch cef
deno task build:chromium dev
deno task build:chromium prod
```

**automate-git 只认提交，固化由构建脚本自动完成。** `automate-git.py` 对
`third/chromium/chromium_git/cef` 做的是 `git fetch` + `git checkout <hash>`，有两个后果：

1. **只看提交，不看工作区。** `deno task patch cef` 只改工作区，若直接把 `rev-parse HEAD`
   （= 上游 pin）交给它，产出的 CEF 里一个 kabegame patch 都没有，且全程无任何报错。
2. **必须在分支上。** `git fetch` 只取 `refs/heads/*`；游离提交 fetch 不到，
   `git checkout <hash>` 直接 `exit 128`。

`scripts/build-chromium.ts` 的 `stageCefPatchesAsCommit()` 在构建前自动满足这两点：把工作区
状态经临时 index + `commit-tree` 固化成分支 `kabegame-build` 上的一个提交，再把该提交交给
automate。它**不触碰工作区、也不动仓库 index**，构建前后 `git status` 一致；工作区若没有
任何 patch（说明忘了 `deno task patch cef`），它会直接报错拦下而不是静默产出无 patch 的 CEF。

因此 `third/cef` 的 gitlink **始终指向官方上游 pin**（当前 `0d0eeb611`），Kabegame 的分歧
只以 `third-patches/cef/*.patch` 为准，与其它 `third/` 子模块完全同构。

> 历史包袱：这里一度靠人工维护一条 `kabegame-7827` fork 分支，且父仓库 gitlink 误指向该
> 分支的 tip —— 那个提交只存在于本地，别人 clone 后 `git submodule update` 必然失败。
> 2026-08 已回到上游 pin + 标准 patch 系列，分支删除。

升级 CEF 大版本时两边都走同一套 re-vendor 流程：先 `deno task patch <dir> -r` 还原成
干净的上游树，再 bump 官方 pin，最后修复 context 漂移并重新生成整个 patch series，
同步更新 `third-patches/<dir>/README.md` 的 vendor base。cef-rs 侧还要重跑
`update-bindings` 并把结果作为新编号 patch 追加。

## 当前限制

- CEF Views 对部分 Tauri window API 没有等价能力；运行时对这些 API 返回保守值或 no-op。
- Linux CEF 窗口固定采用 X11/ANGLE GL 配置；原生 Wayland 路径尚未接入。
- Windows 下 tauri `theme` 恒报 Light；`shadow` 为 best-effort。`WindowBuilder::drag_and_drop`
  （tao 层的 OLE drop target）仍是 best-effort 且实际不生效——CEF 的 browser view 覆盖在
  tao 窗口之上，拖放命中的是 CEF；文件拖放走 `TauriCefDragHandler`，见「Tauri 适配边界」。
- `OnDrop` 挂在 `WebContentsViewDelegate` 上，而窗口外（OSR/windowless）浏览器不创建该
  delegate。kabegame 用的是 windowed CEF Views，不受影响；OSR 场景只会收到
  Enter/Over/Leave，没有 Drop。
- `third/cef-rs` 的 bindings 目前只重新生成了两个 macOS target（`aarch64/x86_64-apple-darwin`）。
  Linux/Windows 的 bindings 需在对应平台上跑
  `cargo run -p update-bindings -- --bindgen --target <triple>`（bindgen 要该平台的
  sysroot），与该平台的 CEF 重编一并进行。
