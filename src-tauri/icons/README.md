# 图标文件

Tauri 应用需要以下图标文件（均由 `cargo tauri icon` 从 `icon.png` 生成）：

- `icon.png` - 源图（1024×1024），也用于 Linux deb 的 mimetype 图标
- `32x32.png`、`128x128.png`、`128x128@2x.png` - 多尺寸 PNG
- `icon.icns` - macOS
- `icon.ico` - Windows

重新生成所有图标（在项目根目录或 `src-tauri/app-main` 下）：
```bash
cd src-tauri/app-main && cargo tauri icon ../icons/icon.png -o ../icons
```
生成后需将 `icons/android/` 下的内容复制到 `app-main/gen/android/app/src/main/res/` 对应 mipmap 目录。

