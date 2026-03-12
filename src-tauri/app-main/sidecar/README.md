# ffmpeg sidecar

将 ffmpeg 可执行文件放到本目录，并按以下名称命名：

- Windows: `ffmpeg-windows.exe`
- macOS: `ffmpeg-macos`
- Linux: `ffmpeg-linux`

当前 `tauri.conf.json.handlebars` 会按平台只打包对应文件。

## 下载建议

- Windows / Linux（BtbN 自动构建）  
  <https://github.com/BtbN/FFmpeg-Builds/releases>
- macOS（evermeet）  
  <https://evermeet.cx/ffmpeg/>

下载后记得重命名为上面的文件名，并确保可执行权限（macOS / Linux）：

```bash
chmod +x src-tauri/app-main/sidecar/ffmpeg-macos
chmod +x src-tauri/app-main/sidecar/ffmpeg-linux
```
