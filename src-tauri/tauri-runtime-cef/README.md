# tauri-runtime-cef

Linux 桌面端的 Tauri runtime 适配器：用 CEF/Chromium 替换 WebKitGTK。

它实现 `tauri-runtime` trait，并只在 Linux 的 Kabegame GUI（`standard` / `light`）中被选用。Windows 继续使用 WebView2，macOS 使用 WKWebView，Android 使用系统 WebView。

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
- 窗口和 webview 操作统一通过 CEF UI 线程执行；主循环持续 pump GLib 与 CEF。
- `BrowserView` 尺寸由 CEF Window client area 布局，不转发 tao resize、鼠标、键盘或 IME 事件。
- `KABEGAME_CEF_WINDOW_MODE` 已废弃且不再读取；Linux CEF 始终 windowed。
- 不包含替代的离屏渲染、软件帧缓冲或 dmabuf/wgpu 合成路径。

`Ctrl+Shift+D` 由 CEF `KeyboardHandler` 打开 DevTools。

## Tauri 适配边界

| Tauri 能力 | CEF 实现 |
| --- | --- |
| 前端资源 | 每个 webview 的 `RequestContext` 注册 `tauri://` / `asset://` scheme handler |
| `invoke()` | `ipc://` 主路径与 `cef-ipc://` postMessage 后备桥接 |
| 初始化脚本 | CEF `LoadHandler::on_load_start` 注入 |
| 页面生命周期 | `LoadHandler` 映射到 Tauri page-load hook |
| 窗口事件 | CEF `WindowDelegate` 回流为 Tauri runtime events |

## 平台门控

`src-tauri/kabegame/Cargo.toml` 仅在 `target_os = "linux"` 声明本 crate；应用入口在 Linux `standard` / `light` 下使用：

```rust
tauri::Builder::<tauri_runtime_cef::Cef<tauri::EventLoopMessage>>::new()
```

非 Linux 平台不会把 CEF 放入 Kabegame 的依赖树。

## 开发与校验

真实 CEF 代码在 `cef-backend` feature 后，以避免普通的非 Linux 检查下载 Chromium：

```bash
cargo check -p tauri-runtime-cef --features cef-backend
```

`cef-rs` 默认下载对应的官方预编译 CEF；设置 `CEF_PATH` 可以复用已下载的运行时目录。不要自行构建 Chromium。

CEF 是多进程运行时。`execute_cef_subprocess_and_exit()` 必须在 Linux 应用 `main` 的最早阶段执行，使 renderer/GPU 子进程在进入 Tauri 初始化之前完成 CEF 子进程派发。

## 当前限制

- CEF Views 对部分 Tauri window API 没有等价能力；运行时对这些 API 返回保守值或 no-op。
- Linux 包仍需在发布阶段携带 `libcef.so`、resources、locales 和相关 Chromium 运行时文件。
- CEF 窗口固定采用 X11/ANGLE Vulkan 配置；原生 Wayland 路径尚未接入。
