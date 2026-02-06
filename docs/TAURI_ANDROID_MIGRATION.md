# Tauri Android 迁移指南

本文档汇总 Kabegame 项目在 Tauri Android 平台适配时的注意事项，包括环境要求、迁移步骤及代码实现层面的考量。

---

## 一、环境要求

| 依赖项 | 要求 |
|--------|------|
| **Rust** | ≥ 1.77.2 |
| **Android Studio** | 需安装 |
| **JAVA_HOME** | 指向 Android Studio 的 JBR，例如：<br>`/Applications/Android Studio.app/Contents/jbr/Contents/Home` |
| **ANDROID_HOME** | 指向 Android SDK 目录 |
| **NDK_HOME** | **必须配置**，否则初始化/编译会失败，例如：<br>`$ANDROID_HOME/ndk/<版本号>` |

### SDK Manager 需安装的组件

- Android SDK Platform
- Android SDK Platform-Tools
- NDK (Side by side)
- Android SDK Build-Tools
- Android SDK Command-line Tools

### Rust Android 目标

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

---

## 二、项目结构调整

移动端需要将应用编译成**共享库**，桌面端入口调用该库。

### Cargo.toml

```toml
[lib]
name = "app_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

### lib.rs 入口函数

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tauri builder 等逻辑
}
```

### main.rs

```rust
fn main() {
    app_lib::run();
}
```

### 初始化 Android 工程

```bash
cd src-tauri/app-main
cargo tauri android init --ci
```

---

## 三、依赖与条件编译

### 桌面专属依赖

需用 `cfg` 限制为“非移动端”，否则 Android 编译会失败：

```toml
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-global-shortcut = "2"
dokan = "0.3.1"  # Windows 虚拟盘
unrar = "0.5.8"  # NDK 可能缺少部分 C API
```

### 系统库适配

Android 上无系统 OpenSSL，可用 vendored：

```toml
[target.'cfg(target_os = "android")'.dependencies]
openssl = { version = "0.10", features = ["vendored"] }
```

### 常见问题

| 问题 | 处理方式 |
|------|----------|
| `NDK_HOME` 未设置 | 设置环境变量，确保 `ndk/` 下有对应版本 |
| `aarch64-linux-android-clang` 找不到 | 检查 NDK 安装，将 `bin` 加入 PATH |
| OpenSSL 交叉编译失败 | 使用 `openssl` 的 `vendored` 特性 |
| Gradle 下载慢/超时 | 配置 Gradle 镜像或代理 |
| `no library targets found` | 确保定义了 `[lib]` 和 `crate-type` |

---

## 四、代码实现注意事项

### 1. 原生接口与平台 API

| 模块 / 插件 | Android 状态 | 建议 |
|-------------|--------------|------|
| `tauri-plugin-global-shortcut` | ❌ 不支持 | 用 `#[cfg(not(target_os = "android"))]` 条件编译 |
| `WebviewWindowBuilder::new()` 多窗口 | ❌ Android 仅单 WebView | 不创建额外窗口（如壁纸窗口） |
| `app.get_webview_window("xxx").show()` | ❌ 无多窗口 | 用前端路由或单窗口切换 |
| `runas`（ShellExecuteW） | 仅 Windows | Android 直接返回错误 |

### 2. 路径与数据目录

- `dirs::data_local_dir()` / `dirs::picture_dir()` 在 Android 上行为与桌面不同，可能返回 `None`。
- 建议使用 Tauri 的 `app.path().resolve()` + `BaseDirectory::AppData` 等，或 `tauri-plugin-android-fs` 处理 Android 存储。
- `kabegame_data_dir()` 依赖 `dirs`，需在真机上验证路径是否正确。

### 3. 打开文件 / 文件夹

#### 当前状态（shell_open.rs）

- `open_path`、`open_explorer`、`reveal_in_folder` 在 Android 上为占位实现，返回 `Err`。
- `runas` 仅支持 Windows，Android 已返回错误。

#### 实现方式

| 方式 | 说明 | 推荐度 |
|------|------|--------|
| `tauri-plugin-opener` | **Android 仅支持 `open`/`openUrl`**，不支持 `openPath` | 仅适合打开 URL |
| Kotlin + Intent | 用 `Intent.ACTION_VIEW` 打开文件/目录，Rust 通过 JNI 调用 | ✅ 推荐 |
| Storage Access Framework | Android SAF 选文件/目录，适合需要持久权限的场景 | 按需选用 |

#### Intent 打开文件示例（Kotlin）

```kotlin
val intent = Intent(Intent.ACTION_VIEW).apply {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.provider", File(path))
    setDataAndType(uri, getMimeType(path))
    flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
}
context.startActivity(Intent.createChooser(intent, "打开方式"))
```

### 4. 窗口管理

| 项目 | 说明 |
|------|------|
| **单 WebView 限制** | Android 仅支持一个主窗口，不能创建多个 `WebviewWindow` |
| 壁纸窗口 | 已有 `#[cfg(target_os = "windows")]`，Android 不创建 ✓ |
| `restore_main_window_state` | 使用 `main_window.show()`，在 Android 上可能需验证 |
| `toggle_fullscreen` | 已在 `invoke_handler` 中 `#[cfg(not(target_os = "android"))]` 排除 ✓ |
| `hide_main_window` | 配合托盘使用，Android 无托盘，需确认业务逻辑 |
| Splash 屏幕 | 用前端加载页或 Android 原生 Splash，不能新建 WebviewWindow |

### 5. 与 Kabegame 代码对应关系

| 模块 | 当前处理 | 建议 |
|------|----------|------|
| `shell_open.rs` | Android 返回 Err | 后续通过 Intent+JNI 实现 |
| `tauri-plugin-global-shortcut` | 未按平台条件编译 | 改为 `cfg(not(any(android, ios)))` |
| `init_shortcut` | 始终执行 | 在 Android 上应跳过 |
| `restore_main_window_state` | 调用 `main_window.show()` | Android 上可加条件或验证 |
| `app_paths::kabegame_data_dir()` | 依赖 `dirs` | 真机验证，必要时改用 Tauri path |

---

## 五、开发服务器配置

移动端使用隧道连接，需用 `TAURI_DEV_HOST`：

```js
// Vite 配置
const host = process.env.TAURI_DEV_HOST;
server: {
  host: host || false,
  hmr: host ? { protocol: 'ws', host, port: 1430 } : undefined,
}
```

---

## 六、发布与打包

- **生成 AAB**：`cargo tauri android build --aab`
- 需配置 Play Console 账号与代码签名。
- 版本号通常来自 `tauri.conf.json`。

---

## 七、检查清单

- [ ] `NDK_HOME`、`ANDROID_HOME`、`JAVA_HOME` 已配置
- [ ] Rust 目标已安装
- [ ] `[lib]` 与 `crate-type` 已配置
- [ ] `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 已添加
- [ ] 桌面专属依赖已用 `cfg` 排除 Android
- [ ] `tauri-plugin-global-shortcut` 在 Android 上不加载
- [ ] `init_shortcut` 在 Android 上跳过
- [ ] 不在 Android 上创建多窗口
- [ ] `open_path` / `open_explorer` / `reveal_in_folder` 在 Android 上返回 Err 或通过 Intent 实现
- [ ] 路径与存储逻辑在真机上验证

---

## 八、参考链接

- [Tauri 2 前置要求（含 Android）](https://v2.tauri.app/zh-cn/start/prerequisites/)
- [Tauri 1.0 到 2.0 迁移（含移动端）](https://v2.tauri.app/start/migrate/from-tauri-1/)
- [tauri-plugin-opener 平台支持](https://v2.tauri.app/plugin/opener/)
