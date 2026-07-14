# 视频摄入（Video Ingest）— 三平台统一 rsmpeg

## 背景

视频下载/导入需要生成预览缩略图并读取视频宽高。**桌面（Windows/macOS/Linux）与 Android 都用进程内 FFmpeg（rsmpeg/libav\*）**，但预览格式不同：
- **桌面**：H.264 MP4 预览缩略图（网格用 `<video>`，鼠标悬浮自动播放）+ H.264/AAC MP4 兼容副本。
- **Android**：**10fps 动图 GIF 预览**（`run_ffmpeg_gif`：`fps=10,scale,palettegen,paletteuse`）。安卓网格无鼠标悬浮，静帧 `<video>` 无意义，故用动图，前端以 `<img>` 展示（`ImageContent.vue` 的 `mode==='gif'`）。Android 不生成兼容副本。

此前 Android 走的慢速 Kotlin 编码插件（`tauri-plugin-compress`：`MediaMetadataRetriever` 抽帧 + Rust `image` crate GIF 编码）已删除，改由 rsmpeg 一步生成 GIF。

Android 的 FFmpeg 由 `bun run build:ffmpeg --target android` 用环境 NDK 交叉编译出 aarch64 静态库（产物在 `third/FFmpeg-build/android/aarch64/install/`，gitignore，不入库，靠命令复现，见 [../../scripts/build-ffmpeg.sh](../../scripts/build-ffmpeg.sh)）。

Android 视频源是 `content://` URI，FFmpeg 无法直接打开。改由 `ContentIoProvider.open_fd(uri)`（PickerPlugin Kotlin `openFileDescriptor(uri,"r").detachFd()`）拿到 detach 的原始 fd，Rust 侧用 `file` 协议打开 `/proc/self/fd/N` 交给 rsmpeg —— 不再把整段视频落盘/读进内存。fd 由 `OwnedFd` 在转码结束后关闭。

原始视频始终保留不变，前端优先使用 `compatible_path` 播放。

## 平台关系

| 构建目标 | 视频实现 |
|---------|---------|
| Windows/macOS/Linux standard desktop | rsmpeg/FFmpeg（本机静态库 `third/FFmpeg-build/install/`）；兼容副本 H.264/AAC MP4，预览 H.264 MP4 |
| kabegame-cli | rsmpeg/FFmpeg（同桌面） |
| Android（aarch64） | rsmpeg/FFmpeg（交叉编译静态库 `third/FFmpeg-build/android/aarch64/install/`，含 gif 编码器/muxer + palettegen/paletteuse/fps 滤镜）；预览为 **10fps GIF**（`run_ffmpeg_gif`），`content://` 经 `open_fd` → `/proc/self/fd/N` 读取。视频**宽高**仍由 `ContentIoProvider.get_video_dimensions`（Kotlin `MediaMetadataRetriever`）提供 |

依赖门控（[../../src-tauri/kabegame-core/Cargo.toml](../../src-tauri/kabegame-core/Cargo.toml)）：`rsmpeg`/`rusty_ffmpeg` 现在 `cfg(not(target_os = "ios"))`（桌面 + Android，仅排除 iOS），与 V8/deno 同块。

图片推断、图片维度读取、图片缩略图与图片兼容副本不使用 FFmpeg：MIME 推断走 `infer`，尺寸与压缩/转 PNG 走 `image` crate。`scripts/build-ffmpeg.sh` 的最小化 FFmpeg 配置只保留视频容器/视频解码/视频编码/音频转码所需组件，不启用 `image2`、图片解码器或 `mjpeg` 图片编码器。

## 涉及文件

| 文件 | 作用 |
|------|------|
| `scripts/build-ffmpeg.sh` | 三平台本机 + `--target android` 交叉编译。Android 用环境 NDK（`NDK_HOME` 等定位）编 x264 + FFmpeg 到独立 abi 目录；`--enable-protocol=fd` 供 fd 读取。 |
| `scripts/plugins/mode-plugin.ts` | 桌面注入 `FFMPEG_PKG_CONFIG_PATH`（+ Windows 复制 DLL）。**Android 现也注入** `FFMPEG_PKG_CONFIG_PATH`（指向 android install）、`FFMPEG_LINK_MODE=static`、`BINDGEN_EXTRA_CLANG_ARGS`（NDK sysroot + target）、`PKG_CONFIG_ALLOW_CROSS=1`、以及 NDK 交叉 linker/CC/CXX/AR（供 `check --mode android` 独立 `cargo check`）。 |
| `src-tauri/kabegame-core/src/crawler/downloader/compress.rs` | 桌面（`#[cfg(not(android))]`）：`run_ffmpeg_transcode` / `filter_encode_write` / `generate_video_preview_from_path` 产 H.264 MP4，`compress_video_for_preview(&Path)` 直调。Android：`compress_video_for_preview(&str uri)` 经 `open_fd` → `/proc/self/fd/N` → `run_ffmpeg_gif`（`#[cfg(android)]`）产 10fps GIF。`encode_write` 两侧共用。 |
| `src-tauri/kabegame-core/src/crawler/content_io.rs` | `ContentIoProvider` 新增 `open_fd(uri) -> i32`。 |
| `src-tauri/kabegame/src/content_io_provider.rs` | Channel 代理新增 `OpenFd` 请求/响应，转发到 PickerPlugin `open_fd`。 |
| `src-tauri-plugins/tauri-plugin-picker/**` | 新增 `openFd` 命令（models/commands/mobile/lib/build/permissions + Kotlin `openFd` = `openFileDescriptor().detachFd()`）。 |
| `src-tauri/kabegame-core/src/media_dimensions.rs` | 桌面 `resolve_video_dimensions_sync` 用 rsmpeg 读 codecpar；Android 同步 stub 返回 `None`，`content://` 视频宽高由 async `ContentIoProvider.get_video_dimensions` 提供。 |
| `src-tauri/kabegame-core/src/crawler/downloader/mod.rs` | 下载入库 postprocess：Android content URI 视频把 URI 传给 `compress_video_for_preview`；桌面直接传文件路径。 |
| `src-tauri/kabegame-core/src/storage/organize.rs` | `RegenerateVideo` 缩略图重建同样按平台分流调 `compress_video_for_preview`。 |
| `src-tauri/kabegame-core/src/local_folder/import.rs` | 桌面本地导入生成 rsmpeg 预览；Android 本地导入 `build_thumbnail_path` 仍为 stub（不生成视频预览，未在本次扩展范围）。 |
| ~~`src-tauri/kabegame/src/compress_provider.rs`~~ | 已删除（原 Android Kotlin provider bridge）。 |
| ~~`tauri-plugin-compress`~~ | 整个插件已删除（原 Kotlin 抽帧/字节拷贝 + 权限 + 注册）。 |

## 调用规则

1. 新增视频处理调用点：桌面传文件路径；Android 传 `content://` URI，由 `compress_video_for_preview` 内部经 `open_fd` → `/proc/self/fd/N` 解析。桌面兼容副本 H.264/AAC MP4、预览 H.264 MP4；Android 无兼容副本、预览为 10fps GIF。
2. “补充兼容格式”只补缺失的 `compatible_path`。已有兼容副本不做平台迁移式重建。
3. 不要新增 `video` / `video-ingest` Cargo feature gate。视频能力不是构建模式开关。
4. Android 视频**预览/兼容处理**现在直接用 rsmpeg；但读取 `content://` 必须经 `open_fd` 拿 fd，不要把 URI 当普通文件路径，也不要先整段落盘。视频**宽高**仍走 `ContentIoProvider.get_video_dimensions`（`MediaMetadataRetriever`，快，非编码插件）。
5. 桌面 FFmpeg 依赖由 `bun run build:ffmpeg` 产出，Android 由 `bun run build:ffmpeg --target android` 产出；构建脚本通过 `FFMPEG_PKG_CONFIG_PATH` 等环境变量定位。

## 画廊播放

画廊展示已存入 DB 的视频无需 FFmpeg：
- `isVideoBackground` / `isVideoMediaType`：检查 `image.type.startsWith("video/")`。
- `<video>` 元素直接加载 `local_path` 或 thumbnail，播放不经过 rsmpeg。

## FFmpeg 构建依赖

- `bun run build:ffmpeg` → 在 `third/FFmpeg-build/install/` 生成本机 libav\* 静态库（Unix）或 DLL+导入库（Windows）。Linux 另需系统 `libx264-dev`……实际由脚本从 `third/x264` 源码编入，无需系统 libx264。
- `bun run build:ffmpeg --target android` → 用环境 NDK 交叉编 aarch64 静态库到 `third/FFmpeg-build/android/aarch64/install/`（gitignore）。API level 由 `ANDROID_API` 覆盖（默认 24）。缺产物时 `mode-plugin` 会在 android 命令下报错并提示该命令。
- `FFMPEG_PKG_CONFIG_PATH` 与 Linux/Android 的 `FFMPEG_LINK_MODE=static` 由 `mode-plugin.ts prepareEnv` 注入；Android 另注入 `PKG_CONFIG_ALLOW_CROSS=1`（rusty_ffmpeg 的 pkg-config crate 默认拒绝交叉编译；我们的 `.pc` 用绝对路径，放行即可）与 `BINDGEN_EXTRA_CLANG_ARGS`（NDK sysroot + android target）。
- `scripts/build-ffmpeg.sh` 三平台都保留 `webm` muxer，供 MSE 多流合流时 stream-copy 输出 VP9/Opus WebM。
- 版本耦合：`rsmpeg` crate 版本、`features = ["ffmpeg8_1"]`、DLL 文件名后缀（libav major version）三者须同步更新。

## check 支持

`bun check -c kabegame --mode android` 现直接跑 `cargo check -p kabegame --features android --target aarch64-linux-android`（不经 tauri android）。所需交叉环境（NDK linker/CC/CXX/AR、FFmpeg、rusty_v8、`PKG_CONFIG_ALLOW_CROSS`）全部由 `mode-plugin.ts` 注入。前提：已 `bun run build:ffmpeg --target android`、`bin/android/` 有 rusty_v8 产物、装好 NDK（见 [../crawler/V8_RUNTIME.md](../crawler/V8_RUNTIME.md)）。
