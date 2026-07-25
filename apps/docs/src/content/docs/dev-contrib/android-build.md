---
title: Android 开发
description: 配置 Android 工具链，并在真机或模拟器上运行、构建和调试 Kabegame。
---

Android 开发建立在[从源码构建](/dev-contrib/building/)的通用环境之上，还需要 Android SDK、NDK 与 Rust 交叉编译目标。Kabegame 最低支持 **Android 8.0（API 26+）**，Gradle 配置为 `minSdk = 26`。

## 前置要求

安装 Android Studio，并配置以下环境变量：

- `JAVA_HOME`：指向 Android Studio 自带的 JBR。
- `ANDROID_HOME`：指向 Android SDK 目录。
- `NDK_HOME`：指向 Android NDK，**必须配置**，否则 Rust、V8 与 FFmpeg 的交叉编译都会失败。

然后安装 Rust Android 目标：

```bash
rustup target add \
  aarch64-linux-android \
  armv7-linux-androideabi \
  i686-linux-android \
  x86_64-linux-android
```

当前仓库自建的 V8 与 FFmpeg 产物以 aarch64 为主，因此常规开发和构建应优先使用 arm64 设备。

## 在真机或模拟器上运行

Android 开发必须显式指定 `--mode android`：

```bash
deno task dev -c kabegame --mode android
```

省略该参数会启动桌面版。连接多台设备时，先从 `adb devices` 取得第一列设备 ID，再把它放在 `--` 之后：

```bash
adb devices
deno task dev -c kabegame --mode android -- <设备ID>
```

## 远程调试 WebView

Debug 构建默认启用 Android WebView 调试。保持设备已连接且开启 USB 调试，然后在桌面 Chrome 访问：

```text
chrome://inspect/#devices
```

勾选 “Discover USB devices”，找到 Kabegame 后点击 “inspect”。如果设备没有自动出现，可以先用 ADB 转发 DevTools 端口：

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

仍无法发现设备时，检查 USB 调试和 ADB 驱动，并尝试：

```bash
adb kill-server
adb start-server
```

## 准备 V8 与 FFmpeg

Android 上的 V8 插件后端使用仓库自建的 aarch64 `rusty_v8` 静态库与 binding。官方包不提供所需的 Android 产物，因此需要在受支持的 Linux 环境运行：

```bash
deno task build:v8
```

产物写入 gitignore 的 `bin/android/`，Android 模式通过 `RUSTY_V8_ARCHIVE` 与 `RUSTY_V8_SRC_BINDING_PATH` 自动接入。完整构建原理和磁盘、clang 要求见 [`cocs/crawler/V8_RUNTIME.md`](https://github.com/kabegame/kabegame/blob/main/cocs/crawler/V8_RUNTIME.md) 与 [`third-patches/rusty_v8/README.md`](https://github.com/kabegame/kabegame/blob/main/third-patches/rusty_v8/README.md)。

Android 视频摄入还需要交叉编译 FFmpeg / x264：

```bash
deno task build:ffmpeg --target android
```

这些产物位于 `third/FFmpeg-build/android/`，不提交到 Git，由命令按需复现。

## 深入阅读

- [`docs/TAURI_ANDROID_MIGRATION.md`](https://github.com/kabegame/kabegame/blob/main/docs/TAURI_ANDROID_MIGRATION.md)：Tauri Android 工程、环境配置与迁移背景。
- [`cocs/tauri/TAURI_CLI_FORK.md`](https://github.com/kabegame/kabegame/blob/main/cocs/tauri/TAURI_CLI_FORK.md)：fork CLI、Android package 与 applicationId 的接线。
- [`cocs/downloader-tasks/VIDEO_INGEST.md`](https://github.com/kabegame/kabegame/blob/main/cocs/downloader-tasks/VIDEO_INGEST.md)：Android FFmpeg 与媒体摄入链路。
