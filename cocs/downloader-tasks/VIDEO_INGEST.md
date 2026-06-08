# 视频摄入（Video Ingest）— Cargo Feature 门控

## 背景

视频下载/导入需要进程内 FFmpeg（rsmpeg/libavformat + libavcodec）。FFmpeg 构建产物体积大，light 模式（无虚拟磁盘、仅商店）无需视频压缩，因此通过 Cargo feature `video-ingest` 显式门控，避免 light 模式引入不必要的 FFmpeg 依赖。

## Feature 开关关系

| 构建目标 | feature |
|---------|---------|
| standard | `kabegame-core/video-ingest` ✓ |
| light | 无（不链接 rsmpeg，不需要 `bun run build:ffmpeg`） |
| kabegame-cli | `video-ingest` ✓（直接声明在 dep features 中） |
| android | 无（走 Kotlin `AndroidVideoCompressProvider`，不用 rsmpeg） |

定义位置：`src-tauri/kabegame-core/Cargo.toml` → `[features] video-ingest = ["dep:rsmpeg"]`

## 涉及文件

| 文件 | 作用 |
|------|------|
| `src-tauri/kabegame-core/src/crawler/downloader/video_compress.rs` | rsmpeg 转码主逻辑。`compress_video_for_preview` 函数整体门控：`#[cfg(any(target_os="android", feature="video-ingest"))]`；helper fn 门控：`#[cfg(all(not(target_os="android"), feature="video-ingest"))]` |
| `src-tauri/kabegame-core/src/media_dimensions.rs` | `resolve_video_dimensions_sync`（rsmpeg 版）门控：`#[cfg(all(not(target_os="android"), feature="video-ingest"))]`；dispatcher `resolve_media_dimensions_sync` 内部视频分支门控 |
| `src-tauri/kabegame-core/src/crawler/downloader/mod.rs` | 下载入库 postprocess：`is_video` 分支使用 `#[cfg(feature="video-ingest")]` / `#[cfg(not(feature="video-ingest"))]` 双分支，后者返回 `Err`（下载失败） |
| `src-tauri/kabegame-core/src/local_folder/import.rs` | 本地导入：检测到 video 且 `not(feature="video-ingest")` 时 `return Err`；`compress_video_for_preview` 的 use 声明同样门控 |
| `src-tauri/kabegame-core/src/image_type.rs` | `supported_video_extensions()`：light 模式返回 `vec![]`，使前端 `get_supported_image_types` 不含视频类型 |
| `scripts/plugins/mode-plugin.ts` | `prepareEnv`：light 模式不设置 `FFMPEG_PKG_CONFIG_PATH`（rsmpeg build.rs 不执行）；`copyBin`：light 模式不复制 FFmpeg DLL |

## 调用规则

**新增视频处理代码必须遵守：**

1. 调用 `compress_video_for_preview` 或 `resolve_video_dimensions_sync` 前必须有 `#[cfg(feature = "video-ingest")]` 门控，否则 light 模式编译失败。
2. 对应的 `#[cfg(not(feature = "video-ingest"))]` 分支应返回 `Err(...)` 或 `None`，不能静默 no-op。
3. `video_compress::compress_video_for_preview` 在 light 模式下不存在（函数未定义），直接调用是编译错误，这是有意为之。

## 画廊播放

画廊展示已存入 DB 的视频无需 FFmpeg：
- `isVideoBackground` / `isVideoMediaType`：检查 `image.type.startsWith("video/")`，与 `video-ingest` 无关。
- `<video>` 元素直接加载 `local_path` 或 thumbnail，播放不经过 rsmpeg。
- 因此 light 模式仍可正常播放历史下载的视频，只是不能新增。

## FFmpeg 构建依赖

- `bun run build:ffmpeg` → 在 `third/FFmpeg-build/install/` 生成 libav* 静态库（Unix）或 DLL+导入库（Windows）。
- `FFMPEG_PKG_CONFIG_PATH` 由 `mode-plugin.ts prepareEnv` 注入，rsmpeg 的 `rusty_ffmpeg` build.rs 用它定位头文件与库。
- **light 模式不注入该变量**，rsmpeg 不被编译，`bun run build:ffmpeg` 可跳过。
- 版本耦合：`rsmpeg` crate 版本、`features = ["ffmpeg8"]`、DLL 文件名后缀（libav major version）三者须同步更新，详见 `CLAUDE.md` 及 memory 中的 `ffmpeg-version-coupling`。
