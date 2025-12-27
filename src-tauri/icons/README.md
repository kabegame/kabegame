# 图标文件

Tauri 应用需要以下图标文件：

- `32x32.png` - 32x32 像素图标
- `128x128.png` - 128x128 像素图标  
- `128x128@2x.png` - 256x256 像素图标（高分辨率）
- `icon.icns` - macOS 图标格式
- `icon.ico` - Windows 图标格式

你可以使用 [Tauri Icon Generator](https://github.com/tauri-apps/tauri-icon) 或在线工具生成这些图标。

或者，你可以运行：
```bash
npm install -g @tauri-apps/cli
tauri icon path/to/your/icon.png
```

这将自动生成所有需要的图标格式。

