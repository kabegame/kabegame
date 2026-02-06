# Tauri 发布说明摘要

本文档汇总 Tauri 2.0 之后

---

## 2.1.0

### 新功能

#### 安全与协议

- **安全响应头**：新增配置 `app > security > headers`，可为 Tauri 返回给 WebView 的**所有 HTTP 响应**统一加自定义头（不包含 IPC 和错误响应），方便做 CSP、X-Frame-Options 等。
- **自定义协议 HTTPS**：新增 `app > windows > useHttpsScheme` 以及 `WebviewWindowBuilder/WebviewBuilder::use_https_scheme`，在 Windows 和 **Android** 上可把自定义协议从 `http://<scheme>.localhost` 改为 `https://<scheme>.localhost`，利于混合内容策略和安全性。

#### Android

- **PathResolver::home_dir()**：在 Android 上新增 `PathResolver::home_dir()`，方便拿用户主目录路径，做 Android 适配时会更顺手。

#### 窗口与 WebView

- **窗口背景色**：新增 `Window::set_background_color` 和 `WindowBuilder::background_color`，可设置窗口背景色，减少白闪或与主题不一致。
- **单窗口 DevTools**：新增 `app > windows > devtools` 以及 `WebviewWindowBuilder/WebviewBuilder::devtools`，可按窗口/WebView 开关开发者工具，不必全局开。
- **WebView 创建时是否聚焦**：新增 `WebviewBuilder::focused`，控制新建 WebView 是否自动获得焦点。
- **Windows 窗口类名**：新增 `app > windows > windowClassname` 和 `WindowBuilder/WebviewWindowBuilder::window_classname`，可指定 Windows 窗口类名，便于与系统/辅助功能集成。

#### 前端 ↔ Rust（IPC / DPI）

- **DPI 类型直接 invoke**：`PhysicalSize`、`PhysicalPosition`、`LogicalSize`、`LogicalPosition` 等 DPI 类型实现了 `SERIALIZE_TO_IPC_FN`，可在前端直接通过 `invoke` 传给 Rust，无需手写转换；并新增 `Size`、`Position` 类及 `SERIALIZE_TO_IPC_FN` 常量，方便为自定义类型做 IPC 序列化。
- **运行时检查命令作用域**：新增 `WebviewWindow::resolve_command_scope`，可在前端运行时检查某命令在当前窗口/WebView 下的权限（scope），便于做权限 UI 或分支逻辑。

### 增强

- **async command 与引用**：使用 async command 且参数为引用时的错误信息更清晰，便于排查。
- **ACL I/O 错误**：ACL 相关 I/O 错误现在会包含路径信息，调试权限/路径问题更方便。

### Bug 修复

- **子 WebView 铺满窗口**：修复在 macOS/Windows 上创建子 WebView 时无法正确铺满父窗口的回归。
- **Linux cursor_position**：修复在 Linux 上调用 `cursor_position` 时触发 “GDK may only be used from the main thread” 的问题。
- **EventTarget::AnyLabel**：修复使用 `EventTarget::AnyLabel` 创建的监听器收不到事件的问题。
- **托盘事件**：修复在 async command 里创建的托盘图标的托盘事件不触发的问题。
- **WebView 焦点**：新建 WebView 现在会按预期获得焦点（与 `WebviewBuilder::focused` 配合）。

---

## 2.2.0

### 新功能

#### 托盘

- **全局托盘事件**：新增 `tauri::Builder::on_tray_icon_event`，可在 builder 层统一处理所有托盘图标的点击等事件，不必在每个 `TrayIconBuilder` 上单独设。
- **左键菜单命名**：新增 `TrayIconBuilder::show_menu_on_left_click`，并**弃用** `menu_on_left_click`，命名更一致；Windows 上已支持该方法及 `TrayIcon::set_show_menu_on_left_click`。

#### 权限 / 安全

- **显式禁止路径**：新增 `Scope::is_forbidden`，可检查某路径是否被显式禁止访问，便于做权限 UI 或调试。

#### 窗口角标 / 覆盖图标

- **Badging API**（按平台）：
  - Linux / macOS / iOS：`Window/WebviewWindow::set_badge_count`（如 Dock/任务栏数字角标）。
  - 仅 Windows：`Window/WebviewWindow::set_overlay_icon`（任务栏图标上的小覆盖图标）。
  - 仅 macOS：`Window/WebviewWindow::set_badge_label`（Dock 角标文字）。

#### WebView 配置

- **macOS**：`WebviewWindowBuilder/WebviewBuilder::data_store_identifier`，可为 WebView 指定数据存储标识，便于多实例/隔离。
- **Linux / Windows**：`WebviewWindowBuilder/WebviewBuilder::extensions_path`，可指定扩展路径（如 Chromium 扩展）。

### 增强

- **Windows WebView2**：依赖 `webview2-com` 升级到 0.34。**若使用 `with_webview` 等直接操作 WebView2 的 API，可能有破坏性变更**，需要对照新版本检查。

### Bug 修复

- **运行时添加的 capability**：修复在运行时通过 `Manager::add_capability` 添加 capability 后，执行插件命令时的 **panic**。
- **未托管 state 的 command**：对使用未托管 state 的 command 的 invoke，改为返回错误而不是 **panic**，行为更可预期。
- **resource 随机 id 冲突**：修复当 resource 的随机 id 已被使用时触发的 **assert panic**。
- **能力文件**：修复在开启 `config-json5` 时 `.json5` capability 文件仍不被识别的问题。
- **specta**：修复启用 specta 时的 `specta-util dependency not found` 错误。
- **自动生成权限**：将 webview/window 的 color 相关 setter 加入自动生成的权限，避免前端调用被误拦。

---

## 2.3.0

### 新功能

- **Emitter::emit_str\***：`Emitter` trait 新增 `emit_str*` 方法，可直接发送已 JSON 序列化的数据，无需在 Rust 侧再序列化。
- **ExitRequestApi**：导出 `tauri::ExitRequestApi` 结构体，便于在应用内显式请求退出。

### 增强

- **后台节流策略**：新增选项以修改默认后台节流策略（目前仅 WebKit）。
- **PathResolver::Clone**：为 `PathResolver` 派生 `Clone`，便于在多个地方持有或传递。
- **Windows 无边框窗口**：无边框且带阴影的窗口，现可在窗口客户区外使用原生调整大小手柄。
- **wry / windows / webview2-com / objc2 升级**：wry 升至 0.50，windows 升至 0.60，webview2-com 升至 0.36，objc2 升至 0.6。**若使用 `with_webview` 等直接操作 WebView 的 API，可能有不兼容变更**，需对照新版本检查。

### Bug 修复

- **Manager::unmanage 弃用**：弃用 `Manager::unmanage` 以修复 use-after-free 导致的未定义行为，详见 [#12721](https://github.com/tauri-apps/tauri/issues/12721)。
- **navigate 借用**：`Webview::navigate` 和 `WebviewWindow::navigate` 改为借用 `&self`，不再不必要地借用 `&mut self`。

### 依赖

- tauri-runtime@2.4.0
- tauri-runtime-wry@2.4.0
- tauri-utils@2.2.0
- tauri-macros@2.0.5
- tauri-build@2.0.6

---

## 2.4.0

### 新功能

#### 窗口与 WebView

- **置顶查询**：新增 `Window::is_always_on_top()` 与 `WebviewWindow::is_always_on_top()`，可查询窗口是否置顶。
- **禁用 JavaScript**：新增 `WebviewBuilder::disable_javascript` 与 `WebviewWindowBuilder::disable_javascript`，可在构建时关闭 WebView 的 JavaScript。
- **刷新**：新增 `Webview::reload` 与 `WebviewWindow::reload`，用于刷新页面。
- **macOS 红绿灯位置**：新增 `WebviewWindowBuilder::traffic_light_position` 及配置项 `trafficLightPosition`，可设置 macOS 窗口红绿灯按钮位置。

#### Cookie 与标识

- **Cookie API**：新增 `Webview::cookies()`、`Webview::cookies_for_url()`、`WebviewWindow::cookies()`、`WebviewWindow::cookies_for_url()`，用于读写 Cookie。
- **应用标识**：新增 `getIdentifier()`，可获取 `tauri.conf.json` 中配置的应用标识。

#### 运行与退出

- **App::run_return**：新增 `App::run_return`，与 `App::run` 不同之处在于不直接退出进程，而是返回退出码，便于宿主在 Tauri 退出后做清理。**iOS 上不可用**，会回退到 `App::run`。同时**弃用** `App::run_iteration`（循环调用会导致忙等）。
- **请求重启**：新增 `AppHandle::request_restart()`，作为 `AppHandle::restart()` 的替代，能更可靠地触发 exit 事件后再重启。

#### 缩放与路径（含 Android）

- **滚轮缩放**：当配置 `zoom_hotkeys_enabled` 为 true 时，支持通过鼠标滚轮改变 WebView 缩放。
- **Android Content URI**：path 的 `basename`、`extname` 现支持 Android content URI（如 dialog 插件返回的路径）；新增 `PathResolver::file_name`，在 Android 上可从 content URI 解析文件名（其他平台沿用 `std::path::Path::file_name`）。

#### 构建与权限

- **移除未用命令**：新增配置 `build > removeUnusedCommands`，可根据 capability 定义在构建时移除未使用的命令并触发相应构建脚本/宏。**不会**处理动态添加的 ACL，使用动态 ACL 时需自行核对。

### 增强

- **docs.rs**：修复移动端目标下 docs.rs 的构建。
- **Android 插件**：为移动端插件新增 `Plugin#startIntentSenderForResult` Android API。

### Bug 修复

- **Channel**：移除对 `Channel<TSend>` 的 `TSend: Clone` 要求，改为手动实现 `Clone`。
- **Android path**：path 插件在 SDK < 24 时改用旧的 `dataDir` API。
- **AssetResolver**：修复 `tauri::AssetResolver::get` 与 `tauri::AssetResolver::get_for_scheme` 在路径首字符不是 `/` 时仍被错误跳过的问题。
- **缩放快捷键**：监听 Ctrl+ / Cmd+ 以支持瑞典语键盘布局下的缩放。
- **restart**：`AppHandle::restart()` 现会等待 `RunEvent::Exit` 派发后再执行重启。

### 性能

- **全局 Tauri 脚本**：当配置 `app > withGlobalTauri` 为 false 时，不再打包 `bundle.global.js`，减小体积。

### 依赖

- tauri-runtime@2.5.0
- tauri-runtime-wry@2.5.0
- tauri-utils@2.3.0
- tauri-build@2.1.0
- tauri-macros@2.1.0

---

## 2.5.0

### 新功能

#### macOS

- **Dock 可见性**：新增 `set_dock_visibility`，可控制应用在 Dock 中的显示/隐藏。

#### 窗口与 WebView

- **全帧初始化脚本**：新增在所有 frame 上执行初始化脚本的 API：`WebviewBuilder::initialization_script_on_all_frames`、`WebviewWindowBuilder::initialization_script_on_all_frames`、`WebviewAttributes::initialization_script_on_all_frames`。
- **防止窗口溢出显示器**：新增 `preventOverflow` 配置及 `WindowBuilder::prevent_overflow`、`WebviewWindowBuilder::prevent_overflow`，以及带边距的 `prevent_overflow_with_margin`，避免窗口创建时超出显示器范围。
- **链接预览**（macOS/iOS）：新增 `WebviewBuilder::allow_link_preview`、`WebviewWindowBuilder::allow_link_preview`，可关闭或开启 WebKit 默认的链接预览。

#### iOS

- **输入附件视图**：新增 `WebviewWindowBuilder::with_input_accessory_view_builder`、`WebviewBuilder::with_input_accessory_view_builder`，用于自定义输入附件视图。

### 增强

- **未托管 state 获取失败**：获取未托管 state 时的 panic 信息更清晰，便于排查。
- **eval 参数**：`Webview::eval`、`WebviewWindow::eval` 现接受 `impl Into<String>`，传参更灵活、可避免多余分配。
- **Builder::invoke_system**：`Builder::invoke_system` 现接受 `AsRef<str>`。

### Bug 修复

- **Channel 回调**：修复附着在窗口上的 Channel 回调在窗口关闭后未被清理的问题。
- **ACL 错误信息**：修复被引用命令在 ACL 错误信息中缺少 `core:` 前缀的问题。
- **Windows 栈溢出**：修复 Windows Debug 构建下，大量命令且参数为大型结构体时导致的栈溢出。
- **invoke headers**：修复 `invoke` 在 `options.headers` 含非 ASCII 时未正确抛错、以及传入 `Headers` 时被忽略的问题。
- **run_return 重启**：修复 `run_return` 下对 `restart` 与 `request_restart` 无响应的问题。

### 性能

- **Channel**：在发送少量数据（如单个数字）时，Channel 性能有所提升。

### 依赖

- tauri-utils@2.4.0
- tauri-runtime@2.6.0
- tauri-runtime-wry@2.6.0
- tauri-macros@2.2.0
- tauri-build@2.2.0
- webview2-com@0.37
- windows@0.61

### 破坏性变更

- **移除误导出的 WebviewAttributes**：不再从 tauri 重导出 tauri-runtime 的 `WebviewAttributes`（此前为误导出，未在任何对外 API 中使用）。

---

## 2.6.0

### 新功能

#### 前端 API

- **WebView 自动调整大小**：在 `@tauri-apps/api` 中暴露 WebView 的 `setAutoResize` API，可在前端控制 WebView 随窗口自动调整大小。

#### 窗口与显示器

- **Monitor::work_area**：新增 `Monitor::work_area` getter，可获取显示器的工作区（扣除任务栏等后的可用区域）。
- **PhysicalRect / LogicalRect**：新增 `tauri::PhysicalRect` 与 `tauri::LogicalRect` 类型，便于处理物理/逻辑坐标与尺寸。

#### 安全与协议

- **Service-Worker-Allowed 响应头**：在 `app > security > headers` 中新增配置项，可设置 HTTP 响应头 `Service-Worker-Allowed`，便于控制 Service Worker 作用域。

#### Linux / Wayland

- **x11 可选 feature**：新增 Cargo feature `x11`（默认开启）。仅支持 Wayland 的应用可关闭该 feature 以减小体积。**注意**：若手动关闭 tauri 的 default features，需显式启用 `x11` 才能支持 X11。

### 增强

- **WebView 创建前检查**：创建 WebView 时会检查 webview 运行时是否可用，若不可用则返回错误，避免后续异常。

### Bug 修复

- **Channel 与已关闭 WebView**：修复在 WebView 已无对应 channel 回调时仍派发 channel 事件导致 JavaScript 运行时崩溃的问题。
- **macOS work area**：修复 macOS 上工作区（work area）的计算错误。
- **iOS 插件事件监听**：修复 iOS 插件多次注册事件监听的问题。
- **path.join**：修复 `path.join('', 'a')` 错误返回 `"/a"` 而非 `"a"` 的拼接行为。
- **set_window_effects 线程**：修复 `set_window_effects` 未在主线程执行的问题（WindowBuilder 场景）。
- **TrayIcon.getById**：修复 `TrayIcon.getById` 返回新 resource ID 而非复用 `TrayIcon.new` 已创建 ID 的问题。
- **Webview 构造与 proxyUrl**：修复在 Webview 构造函数中使用 `proxyUrl` 时 JavaScript API 未生效的问题。
- **事件 unlisten**：修复在调用 unlisten 后未立即注销事件监听的问题。

### 性能

- **开发态 async command**：开发模式下对 async command 使用动态分发，可明显加快编译速度并显著缩短增量编译时间。

### 其他变更

- **dynamic-acl feature**：将动态 ACL 放入 feature `dynamic-acl`（当前默认开启以保持原有行为）。可通过 `default-features = false` 并自行按需启用以减小最终体积（不包含 ACL 引用）。
- **transformCallback 注册位置**：`transformCallback` 现将在 `window.__TAURI_INTERNALS__.callbacks` 中注册回调，而不再直接挂在 `window['_{id}']` 上。

### 依赖

- tauri-utils@2.5.0
- tauri-runtime-wry@2.7.0
- tauri-macros@2.3.0
- tauri-build@2.3.0
- tauri-runtime@2.7.0
- tao@0.34、wry@0.52、webview2-com@0.38

### 破坏性变更

- **tauri-utils HTML 操作代码**：tauri-utils 中与 HTML 操作相关的代码改为由 feature 控制，以缩短编译时间。若依赖该部分行为，需在配置中启用对应 feature。

---

## 2.7.0

### 新功能

- **插件在所有 frame 上的 JS 初始化脚本**：新增 `tauri::plugin::Builder::js_init_script_on_all_frames`，允许插件注入在所有 frame 上运行的初始化脚本（此前 `js_init_script` 仅在主 frame）。

### 增强

- **插件以 trait 对象形式添加**：新增 `AppHandle::plugin_boxed` 与 `Builder::plugin_boxed`，支持以 `Box<dyn Plugin>` 形式动态添加插件。
- **js_init_script 参数类型**：`tauri::plugin::Builder::js_init_script` 现接受 `impl Into<String>` 而非 `String`，传参更灵活。

### Bug 修复

- **Windows 隔离模式**：修复隔离模式（isolation pattern）在 Windows 上会创建嵌套 iframe（iframes within iframes）的问题。
- **移动端开发模式**：修复移动端开发模式下无法正确加载外部 URL 的问题。
- **移动端代理**：修复移动端前端代理未转发请求 body 的问题。

### 依赖

- tauri-runtime-wry@2.7.2
- tauri-utils@2.6.0
- tauri-runtime@2.7.1
- tauri-macros@2.3.2
- tauri-build@2.3.1

---

## 2.8.0

### 新功能

#### 窗口与 WebView

- **窗口可聚焦属性**：新增窗口 `focusable` 属性及 `set_focusable` API，可控制窗口是否可获焦点。
- **文档标题与新窗口回调**：新增 `WebviewBuilder::on_document_title_changed`、`WebviewWindowBuilder::on_document_title_changed`，以及 `WebviewBuilder::on_new_window`、`WebviewWindowBuilder::on_new_window`，用于监听标题变化和新窗口请求。
- **简单全屏**：新增 `Window::set_simple_fullscreen`。

#### Cookie

- **Cookie 写入与删除**：新增 `Webview::set_cookie()`、`Webview::delete_cookie()`，以及 `WebviewWindow::set_cookie()`、`WebviewWindow::delete_cookie()`。

#### 移动端与安全

- **设备事件过滤**：`App::set_device_event_filter` 现也可通过 `AppHandle` 使用（`AppHandle::set_device_event_filter`）。
- **移动端开发代理根证书**：支持从 CLI 设置的环境变量加载根证书，并用于移动端开发服务器代理。
- **移动端插件异步执行**：新增 `PluginHandle::run_mobile_plugin_async`，作为 `run_mobile_plugin` 的异步版本。

### 增强

- **WebviewWindow 的 on_webview_event**：`Webview::on_webview_event` 现也在 `WebviewWindow` 上实现，便于统一监听 WebView 事件。
- **单位与样式导出**：重新导出 `PixelUnit`、`PhysicalUnit`、`LogicalUnit`；`TitleBarStyle` 现对所有平台导出。
- **托盘图标**：新增 `with_inner_tray_icon`，可访问 TrayIcon 内部平台相关托盘图标。因 tray-icon 可能在 minor 版本中更新，建议在使用该 API 时至少固定 Tauri 的 minor 版本。
- **二进制缓冲 Debug**：减小二进制缓冲的 Debug 格式体积。
- **remove_plugin 参数**：`AppHandle::remove_plugin` 的参数类型由 `&'static str` 改为 `&str`。
- **子菜单图标**：子菜单（Submenu）现支持图标：Rust 侧可通过 builder 与专用方法设置；前端 `SubmenuOptions` 增加 `icon` 字段，`Submenu` 提供 `setIcon`、`setNativeIcon`。与现有菜单项行为一致，向后兼容。

### 依赖

- tauri-utils@2.7.0
- tauri-runtime-wry@2.8.0
- tauri-runtime@2.8.0
- tauri-macros@2.3.3
- tauri-build@2.3.2

---

## 2.9.0

### 新功能

#### 窗口与 WebView

- **滚动条样式**：Webview 与 WebviewWindow 的 builder 新增 `scroll_bar_style` 选项，可自定义滚动条样式；该选项受条件编译控制，若需自定义需在代码中用条件编译启用对应取值。

#### 移动端

- **退出与返回键**：新增移动端应用插件，支持监听 **exit** 与 **返回键按下** 事件。
- **Android 生命周期钩子**：新增 Android 插件钩子 `onStop`、`onDestroy`、`onRestart`、`onConfigurationChanged`，便于在生命周期或配置变更时执行逻辑。
- **iOS Swift 异步插件**：PluginManager 支持 Swift 插件的异步方法（`completionHandler:`）。

### Bug 修复

- **Android 插件参数**：修复 Android 插件中参数名以 `is` 开头的字段被错误反序列化（此前被当作 getter 而非字段名）的问题。
- **invoke 栈溢出**：修复 release 构建下单个 invoke handler 内注册过多命令时导致的栈溢出。

### 依赖

- tauri-utils@2.8.0
- tauri-runtime-wry@2.9.0
- tauri-runtime@2.9.0
- tauri-build@2.5.0
- tauri-macros@2.5.0

---

## 2.10.0

### 新功能

#### 窗口与 WebView

- **WebviewWindow 简单全屏**：新增 `WebviewWindow::set_simple_fullscreen`，与 `Window` 上的同名方法一致。在 macOS 上可切换全屏且不创建新 Space；其他平台回退为普通全屏。

### Bug 修复

- **Android 外部存储视频**：修复在 Android 上通过 `convertFileSrc` 访问外部存储目录中的本地视频文件时返回 500 错误的问题；并改进外部存储访问的错误处理与日志，便于排查权限与可访问性问题。
- **specta 与 Channel**：修复 specta 下不应将 `#[specta(rename = ...)]` 与 `tauri::ipc::Channel` 一起使用的问题。
- **WindowConfig::focus 默认值**：`WindowConfig::focus` 的默认值改为 `false`。

### 其他变更

- **bundle 类型信息**：变更二进制中 bundle 类型信息的写入方式，改为直接查找默认值而非变量值。

### 依赖

- tauri-utils@2.8.2
- tauri-build@2.5.4
- tauri-runtime-wry@2.10.0
- tauri-runtime@2.10.0
- tauri-macros@2.5.3
- webkit2gtk-rs@2.0.2（**with_webview 用户破坏性变更**：需对照新版本检查）
- wry@0.54
