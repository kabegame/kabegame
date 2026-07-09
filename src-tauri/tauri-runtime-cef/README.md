# tauri-runtime-cef

Linux 与 Windows 桌面端的 Tauri runtime 适配器：用 CEF/Chromium 替换 WebKitGTK（Linux）/ WebView2（Windows）。

它实现 `tauri-runtime` trait，并只在 Linux/Windows 的 Kabegame GUI（`standard` / `light`）中被选用。macOS 使用 WKWebView，Android 使用系统 WebView。

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
- 窗口和 webview 操作统一通过 CEF UI 线程执行；主循环持续 pump 平台消息（Linux 为 GLib，Windows 为 Win32 message queue）与 CEF。
- `BrowserView` 尺寸由 CEF Window client area 布局，不转发 tao resize、鼠标、键盘或 IME 事件。
- `KABEGAME_CEF_WINDOW_MODE` 已废弃且不再读取；CEF 始终 windowed。
- GPU 模式可用 `KABEGAME_CEF_GPU_MODE`（或 `CEF_WINDOWED_GPU_MODE`）覆盖：`default`（不加开关）/ `disabled` / 任意 ANGLE 后端名（`gl`、`d3d11`、`vulkan`…）。默认值：Linux `gl`（Vulkan 后端曾触发 GPU device-lost），Windows `default`（Chromium 自选，ANGLE D3D11）。
- 不包含替代的离屏渲染、软件帧缓冲或 dmabuf/wgpu 合成路径。

`Ctrl+Shift+D` 由 CEF `KeyboardHandler` 打开 DevTools。

## Tauri 适配边界

| Tauri 能力 | CEF 实现 |
| --- | --- |
| 前端资源 | 全局 scheme handler factory 服务前端/asset 资源。Linux/macOS 走自定义 scheme（`tauri://localhost` / `asset://localhost`）；Windows 上 Tauri core 把自定义 scheme `X` 改写为 `http://X.localhost`（见 `tauri` manager `webview.rs`），故 CEF 改为对 `http` scheme + `X.localhost` 域注册 factory（`protocol::cef_scheme_and_domain`），否则 `http://tauri.localhost` 会当成真实网络请求 → `ERR_CONNECTION_REFUSED` |
| `invoke()` | `ipc://` 主路径与 `cef-ipc://` postMessage 后备桥接；内部 IPC scheme 允许绕过页面 CSP，以支持 surf 等第三方页面中的 Tauri IPC |
| 初始化脚本 | CEF `LoadHandler::on_load_start` 注入 |
| 页面生命周期 | `LoadHandler` 映射到 Tauri page-load hook |
| Cookie API | CEF 全局 `CookieManager` 映射到 Tauri `cookies_for_url` / `cookies` / `set_cookie` / `delete_cookie` |
| 窗口事件 | CEF `WindowDelegate` 回流为 Tauri runtime events |
| Raw window handle | Linux 返回 Xlib window，Windows 返回 Win32 HWND（+HINSTANCE） |

## 平台门控

`src-tauri/kabegame/Cargo.toml` 在 `target_os = "linux"` 与 `target_os = "windows"` 声明本 crate；应用入口在两平台 `standard` / `light` 下使用：

```rust
tauri::Builder::<tauri_runtime_cef::Cef<tauri::EventLoopMessage>>::new()
```

macOS / Android 不会把 CEF 放入 Kabegame 的依赖树。

## Windows 注意事项

- **application manifest 是硬性要求**。Chromium GPU 进程用 `WS_EX_LAYERED` 子窗口做
  DirectComposition 呈现（`ui/gl/child_window_win.cc`），layered 子窗口只对声明了
  Windows 8+ 兼容性（`<compatibility>` supportedOS）的进程开放；不带 manifest 的
  cargo 默认 exe 会让 GPU 进程 `CreateWindowEx` 失败 → NOTREACHED 崩溃循环
  （CEF #3765）。本 crate 的 `build.rs` 为 example 二进制嵌入
  `windows-app.manifest`；kabegame.exe 由 tauri-build 的
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

`cef-rs` 默认下载对应的官方预编译 CEF（**不含 H.264/AAC**）；必须设置 `CEF_PATH` 指向自编运行时目录（见 `.cursor/rules/cef-path-set.mdc`）。构建脚本回退约定：Linux `~/i/cef-{dev,prod}`，Windows `H:\cef-{dev,prod}`（`scripts/plugins/mode-plugin.ts`）。

Windows 构建 `libcef_dll_wrapper` 需要 cmake + ninja + MSVC；cef-dll-sys 的 build.rs 会把整个 CEF runtime 拷进 `target/{debug,release}/`，dev 运行免手工拷贝。

CEF 是多进程运行时。`execute_cef_subprocess_and_exit()` 必须在应用 `main` 的最早阶段执行，使 renderer/GPU 子进程在进入 Tauri 初始化之前完成 CEF 子进程派发。

## 打包

- **Linux**：`bin/linux/` 收集 `libcef.so` + 资源 + locales 白名单，注入 deb 到 `/usr/lib/kabegame/`（见 `cocs/build/PLATFORM_SHARED_LIBS.md`）。
- **Windows**：`scripts/plugins/os-plugin.ts` 的 `collectWindowsCefRuntime()` 把 `WINDOWS_CEF_RUNTIME_FILES` + locales 白名单收进 `src-tauri/kabegame/resources/cef/`，随 `resources/**/*` 进 NSIS 安装包；`nsis/installer-hooks.nsh` 的 POSTINSTALL 再把它们搬到 `$INSTDIR`（exe 同目录）与 `$INSTDIR\locales\`。

## 当前限制

- CEF Views 对部分 Tauri window API 没有等价能力；运行时对这些 API 返回保守值或 no-op。
- Linux CEF 窗口固定采用 X11/ANGLE GL 配置；原生 Wayland 路径尚未接入。
- Windows 下 tauri `theme` 恒报 Light；`shadow` / `drag_and_drop` 为 best-effort。
