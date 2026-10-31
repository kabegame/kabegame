# Web 版媒体与前端静态资源 CDN 边界

Web release 不由 Kabegame 进程读取媒体文件：`/file`、`/thumbnail`、`/compatible` 均不挂载，图片直接由 `https://cdn.kabegame.com` 返回。core 与数据库仍以本地路径为唯一事实来源；`src-tauri/kabegame/src/web/image_rewrite.rs` 在 Web RPC 出口统一改写以下字段：

- `local_path` → `/images/<文件名>`
- `thumbnail_path` → `/thumbnails/<文件名>`
- `compatible_path`、`wallpaper_compatible_path` → `/compatibles/<文件名>`

桌面端、Android 和 debug Web 不做 CDN 转写。桌面 CEF 的图库显示直接用 `file://`（`apps/kabegame/src/utils/fileUrl.ts` 的 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl`，CEF 补丁 06 + 应用页主 frame 免检，见 `cocs/wpe/WPE_IMPORT.md`），桌面 `fetch(file:)` 可直接读字节，复制兜底使用 `file://`，三个桌面平台的拖出走 CEF 补丁 03 的真实文件链路（不经媒体 URL）；桌面不再启动本地 HTTP 文件服务。Android 与 debug Web 仍通过 `/file`、`/thumbnail`、`/compatible` 路由显示。路径已经是 HTTP(S) URL 时原样透传。

## 线上存储约束

`cmtheit.com` 的 OSS 由 `ossfs2-kabegame.service` 挂载到 `/mnt/oss`。应用数据目录下三类媒体目录必须都是指向该挂载点的软链接：

```text
~/.local/share/Kabegame/images      -> /mnt/oss/images
~/.local/share/Kabegame/thumbnails  -> /mnt/oss/thumbnails
~/.local/share/Kabegame/compatibles -> /mnt/oss/compatibles
```

不能只改 RPC 路径：对象未进入 OSS 时，转写后的 CDN URL 会返回 404。迁移已有目录时先在线同步，再停服补一次增量；按相对路径和大小核对完全一致后切换软链接。若需要节省本机空间，只能在服务恢复、软链接与 CDN 抽样均验证成功后删除旧目录。

`ossfs2` 依赖 `/etc/mime.types` 决定新对象的 `Content-Type`。Alibaba Cloud Linux 需安装 `mailcap` 提供该文件；缺失时上传的 PNG/JPEG 会变成 `application/octet-stream`。修改 MIME 表后要重启 `ossfs2-kabegame.service`，再用临时图片实际验证 CDN 响应类型。

## 前端静态资源（`cdn.kabegame.com/web/`）

生产 web 构建（`apps/kabegame/vite.config.ts` 中 `isWeb && isProd`，`isProd` 即 `command === "build"`）把 Vite `base` 设为 `https://cdn.kabegame.com/web/`。`index.html` 仍由二进制内嵌返回（`src/web_assets.rs`），页面里的脚本、样式、按需 chunk、插画和 `icon.png` 都从 CDN 加载；dev server 与桌面 / Android 构建的 `base` 仍是 `/`。

原因是服务器出口带宽只有 4～5 Mbps，且所有访客共享：实测首屏 JS/CSS 并发下载，源站合计约 460 KB/s，OSS 约 2.5 MB/s；OSS 还会对 JS/CSS 自动 gzip（`Content-Encoding: gzip` + `Vary: Accept-Encoding`），而源站经 NPM 只压缩 HTML。同一前端只换资源来源，首次绘制从 6.9 s 降到约 0.6 s（不限速），慢速 4G 从 18.2 s 降到 5.6 s。

### 上传（`scripts/deploy-web.sh` 第 0 步）

部署时先把 `dist-kabegame-web/` 中除 `index.html` 以外的文件推到 OSS，再上传插件、停服换二进制：

1. `tar` 打包经 `ssh` 管道传到服务器本地暂存目录 `~/kabegame/web-dist/`（先清空再解包）；不用 rsync，因为 Windows 上 chocolatey 的 rsync（cygwin）拉起 Git Bash 的 msys `ssh` 会报 `dup() in/out/err failed`；
2. 在服务器上 `cp -r` 进 ossfs2 挂载点 `/mnt/oss/web/`；
3. 用 `curl` 确认入口脚本在 CDN 上以 JavaScript 类型返回，否则在停服前中止。

不能直接 rsync 到挂载点：ossfs2 按**写入时的文件名**决定 `Content-Type`，rsync 默认先写无扩展名的临时文件再改名，JS 会被标成 `application/octet-stream`，浏览器拒绝执行模块脚本；`--inplace` 又因 ossfs2 不支持 `ftruncate` 而报错，修改时间也保留不下来。`scp` 直写可用但会报 `fsetstat` 警告。

OSS 上的文件**只增不删**：已打开旧页面的用户切换路由时还会按需加载旧版本 chunk。脚本还要求 `dist-kabegame-web/index.html` 不新于二进制，否则说明之后单独重出过前端，上传的资源会与二进制内嵌的 `index.html` 对不上。

### 约束

- **CORS**：模块脚本、样式和字体都以 `crossorigin` 方式跨域加载，bucket 的 CORS 规则需放行 `https://demo.kabegame.com`（GET / HEAD，当前已配置）。更换 demo 域名时要同步改 bucket 规则。
- **MIME**：JS 以 `application/x-javascript` 返回，属于浏览器认可的 JavaScript MIME；CSS 为 `text/css`，WebP 为 `image/webp`。
- **缓存**：OSS 对象目前没有 `Cache-Control`，浏览器按 `Last-Modified` 启发式缓存。带哈希的文件可以用 `aliyun oss` 设成长期 `immutable`（服务器 CLI 尚未配置凭据，可用 RAM 角色 `KabegameOSS`）。
- **插画**：大图不要放在 `public/` 里用绝对路径引用，那样会绕过 `base` 打到源站。插画统一放在 `apps/kabegame/src/assets/`，经 `src/assets/illustrations.ts` 按 `IS_WEB` 二选一：web 用按显示尺寸 3 倍压缩的 WebP，本地模式用原图 PNG。Vite 加载 import 时就会发射资源文件，`vite.config.ts` 的 `dropUnreferencedSrcAssets` 插件在产物中删掉没有被引用的那一份。
