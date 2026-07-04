# 视频摄入（Video Ingest）— 平台门控

## 背景

视频下载/导入需要生成预览缩略图并读取视频宽高。桌面端（Windows/macOS/Linux）使用进程内 FFmpeg（rsmpeg/libavformat + libavcodec）；Android 不编译 FFmpeg/rsmpeg，改走 Kotlin `AndroidVideoCompressProvider` 与系统媒体 API。

Linux 的 CEF/Chromium runtime 已使用带 H.264/AAC/MP4 支持的构建，因此桌面三平台的视频兼容副本统一为 **H.264/AAC MP4**，视频预览缩略图统一为 **H.264 MP4**。原始视频始终保留不变，前端优先使用 `compatible_path` 播放。

视频能力不再由 Cargo feature 门控：standard、light、kabegame-cli 桌面构建都支持新视频下载/导入；Android 支持 content URI 视频摄入但不链接 FFmpeg。

图片推断、图片维度读取、图片缩略图与图片兼容副本不使用 FFmpeg：MIME 推断走 `infer`，尺寸与压缩/转 PNG 走 `image` crate。`scripts/build-ffmpeg.sh` 的最小化 FFmpeg 配置应只保留视频容器/视频解码/视频编码/音频转码所需组件，不启用 `image2`、图片解码器或 `mjpeg` 图片编码器。

## 平台关系

| 构建目标 | 视频实现 |
|---------|---------|
| Linux standard/light desktop | rsmpeg/FFmpeg；兼容副本为 H.264/AAC MP4，视频缩略图为 H.264 MP4 |
| Windows/macOS standard/light desktop | rsmpeg/FFmpeg；兼容副本为 H.264/AAC MP4，视频缩略图为 H.264 MP4 |
| kabegame-cli | rsmpeg/FFmpeg |
| Android | Kotlin `AndroidVideoCompressProvider` + `MediaMetadataRetriever` / content resolver |

依赖位置：`src-tauri/kabegame-core/Cargo.toml` 将 `rsmpeg` 放在非 Android target dependencies 下。Android target 不依赖 `rsmpeg`。

## 涉及文件

| 文件 | 作用 |
|------|------|
| `src-tauri/kabegame-core/src/crawler/downloader/compress.rs` | 视频预览生成与浏览器兼容副本。桌面三平台兼容副本输出 H.264/AAC MP4、视频预览输出 H.264 MP4。Android `compress_video_for_preview(&str)` 接收 content URI，走 provider/GIF 替代实现。 |
| `src-tauri/kabegame-core/src/media_dimensions.rs` | 非 Android `resolve_video_dimensions_sync` / 视频兼容探测用 rsmpeg 读取视频宽高与容器信息；图片尺寸仍走 `image` crate。Android 同步 stub 返回 `None`，content URI 宽高由 async ContentIoProvider 路径读取。 |
| `src-tauri/kabegame-core/src/crawler/downloader/mod.rs` | 下载入库 postprocess：Android content URI 视频直接传 URI 给 provider；非 Android 视频直接调用 FFmpeg 压缩。 |
| `src-tauri/kabegame-core/src/local_folder/import.rs` | 本地导入：桌面视频始终尝试生成 FFmpeg 预览；Android 本地导入路径保持不生成视频预览。 |
| `src-tauri/kabegame-core/src/image_type.rs` | `supported_video_extensions()` 始终返回内置视频扩展名列表。 |
| `src-tauri/kabegame/src/compress_provider.rs` | Android Rust 侧 provider bridge，调 `tauri-plugin-compress` 提帧并由 Rust 编码 GIF。 |
| `src-tauri-plugins/tauri-plugin-compress/android/src/main/java/app/kabegame/plugin/CompressPlugin.kt` | Android Kotlin 替代实现：通过 content URI 读取视频、提帧、读宽高。 |
| `scripts/plugins/mode-plugin.ts` | 桌面 standard/light 注入 `FFMPEG_PKG_CONFIG_PATH` 并在 Windows 复制 FFmpeg DLL；Android 不注入 FFmpeg 环境。 |

## 调用规则

1. 新增视频处理调用点按平台分流：Android 用 content URI/provider；非 Android 可直接调用 rsmpeg/FFmpeg 实现。桌面兼容副本统一使用 H.264/AAC MP4，视频缩略图统一使用 H.264 MP4。
2. “补充兼容格式”只补缺失的 `compatible_path`。已有兼容副本不做 Linux 平台迁移式重建。
3. 不要新增 `video` / `video-ingest` Cargo feature gate。视频能力现在不是构建模式开关。
4. Android 代码不得依赖本地 FFmpeg、rsmpeg 或要求先把 content URI 落盘为普通文件。
5. 桌面 FFmpeg 依赖由 `bun run build:ffmpeg` 产出，构建脚本通过 `FFMPEG_PKG_CONFIG_PATH` 等环境变量定位。

## 画廊播放

画廊展示已存入 DB 的视频无需 FFmpeg：
- `isVideoBackground` / `isVideoMediaType`：检查 `image.type.startsWith("video/")`。
- `<video>` 元素直接加载 `local_path` 或 thumbnail，播放不经过 rsmpeg。

## FFmpeg 构建依赖

- `bun run build:ffmpeg` → 在 `third/FFmpeg-build/install/` 生成 libav* 静态库（Unix）或 DLL+导入库（Windows）。Linux 另需系统 `libx264-dev`，以编入 H.264 编码器。
- `FFMPEG_PKG_CONFIG_PATH` 与 Linux 的 `FFMPEG_LINK_MODE=static` 由 `mode-plugin.ts prepareEnv` 注入；Linux 会显式静态链接 FFmpeg 与 `libx264`，其余系统集成库保持动态链接。
- `scripts/build-ffmpeg.sh` 三平台都保留 `webm` muxer，供 MSE 多流合流时 stream-copy 输出 VP9/Opus WebM；这不再意味着 Linux 后处理会转码生成 WebM。
- Android 不注入该变量，也不编译 rsmpeg。
- 版本耦合：`rsmpeg` crate 版本、`features = ["ffmpeg8_1"]`、DLL 文件名后缀（libav major version）三者须同步更新。
