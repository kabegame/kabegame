# Linux / Windows 原生壁纸图片兼容副本

## 背景

Chromium 可显示的图片格式不一定能被操作系统的原生桌面壁纸引擎解码。例如 WebP 和
AVIF 可直接用于画廊，但部分 GNOME `gdk-pixbuf` 环境及 Windows 原生壁纸 API 无法稳定
渲染。浏览器兼容副本 `images.compatible_path` 不能承担这一职责，否则会让画廊优先显示
降级后的 JPEG/PNG。

## 数据与路径

- `images.wallpaper_compatible_path` 只记录原生壁纸专用的派生副本；新图片初始为 `NULL`。
- 副本与浏览器兼容副本共用 `AppPaths::compatibles_dir()`，文件名使用独立 UUID。
- `ImageInfo` 和前端查询不包含该字段，画廊继续使用原图或 `compatible_path`。

## 设置流程

Linux 和 Windows 的 `NativeWallpaperManager` 在把路径交给系统前统一调用
`kabegame_core::wallpaper_compat::ensure_native_wallpaper_path`：

1. 按 `local_path` 查找图片记录；非入库路径直接保持原样。
2. 已有 `wallpaper_compatible_path` 且文件存在时直接复用。
3. JPEG、PNG、BMP、GIF、TIFF 直接使用原图。
4. WebP、AVIF、HEIC、HEIF 等格式强制转码为 JPEG（无 alpha）或 PNG（有 alpha），再落库。
5. 查询、转码或落库失败时记录警告并回退原路径，保持 best-effort 行为。

Linux 修改原生壁纸样式时会重新应用当前壁纸，因此 GNOME 和 Plasma 的样式路径也经过
同一解析器。Windows 样式重应用会回到 `set_wallpaper_path`，自然复用该流程。window、
Plasma 插件、macOS 与 Android manager 不接入此逻辑。

## 删除清理

删除或仅移除图片记录时，同时清理 `compatible_path` 与
`wallpaper_compatible_path` 指向的派生文件。清理函数会 canonicalize 目标与
`compatibles_dir`，仅删除位于该目录内的文件；原图 sentinel、外部路径及越界软链接均被
跳过。

## 涉及文件

- `src-tauri/kabegame-core/src/wallpaper_compat.rs`
- `src-tauri/kabegame-core/src/crawler/downloader/compress.rs`
- `src-tauri/kabegame-core/src/image_type.rs`
- `src-tauri/kabegame-core/src/storage/images.rs`
- `src-tauri/kabegame-core/src/storage/migrations/`
- `src-tauri/kabegame/src/wallpaper/manager/native.rs`
