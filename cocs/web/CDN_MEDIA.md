# Web 版媒体 CDN 边界

Web release 不由 Kabegame 进程读取媒体文件：`/file`、`/thumbnail`、`/compatible` 均不挂载，图片直接由 `https://cdn.kabegame.com` 返回。core 与数据库仍以本地路径为唯一事实来源；`src-tauri/kabegame/src/web/image_rewrite.rs` 在 Web RPC 出口统一改写以下字段：

- `local_path` → `/images/<文件名>`
- `thumbnail_path` → `/thumbnails/<文件名>`
- `compatible_path`、`wallpaper_compatible_path` → `/compatibles/<文件名>`

桌面端和 debug Web 不做 CDN 转写，继续通过 `/file/{*path}`、`/thumbnail/{*path}`、`/compatible/{*path}` 读取本地路径。路径已经是 HTTP(S) URL 时原样透传。

## 线上存储约束

`cmtheit.com` 的 OSS 由 `ossfs2-kabegame.service` 挂载到 `/mnt/oss`。应用数据目录下三类媒体目录必须都是指向该挂载点的软链接：

```text
~/.local/share/Kabegame/images      -> /mnt/oss/images
~/.local/share/Kabegame/thumbnails  -> /mnt/oss/thumbnails
~/.local/share/Kabegame/compatibles -> /mnt/oss/compatibles
```

不能只改 RPC 路径：对象未进入 OSS 时，转写后的 CDN URL 会返回 404。迁移已有目录时先在线同步，再停服补一次增量；按相对路径和大小核对完全一致后切换软链接。若需要节省本机空间，只能在服务恢复、软链接与 CDN 抽样均验证成功后删除旧目录。

`ossfs2` 依赖 `/etc/mime.types` 决定新对象的 `Content-Type`。Alibaba Cloud Linux 需安装 `mailcap` 提供该文件；缺失时上传的 PNG/JPEG 会变成 `application/octet-stream`。修改 MIME 表后要重启 `ossfs2-kabegame.service`，再用临时图片实际验证 CDN 响应类型。
