# v4.4.1 changelog

## 用户侧
### Added
- 新增任意搜索功能，本质上是所有其他搜索（名称、元数据等）的按或查询
- 畅游导航栏新增“一键下载”：检测当前页面的图片与视频并逐个下载，转圈时再次点击可取消
- 新增设置“冻结网页”（下载分区，默认开启）：畅游一键下载与网页收集时保存页面快照，可在图片详情中回看原网页，并可刷新重新加载（V8 模式仅保存 HTML，WebView 与畅游同时保存样式）
- 新增设置“去重时更新元数据”（下载分区，默认关闭）：重复下载命中已有图片时，可用本次下载的新元数据与来源插件更新该图片
- 画廊“开始收集”新增“网页”来源：粘贴一个网页地址即可收集页面上的图片与视频，可选 V8（静态 HTML，可自定义 HTTP 头，默认自动注入畅游 Cookie 与浏览器 UA）或 WebView（浏览器渲染并自动滚动，保留登录态）两种后端；Android 仅支持 V8，Web 版暂不开放
- 新增 v8 api: `cefUA()` 函数，可以获取cef的默认UA拼到http header.

### Fixed
- 修复本地文件夹中单个文件变化会触发整目录重扫、阻塞应用事件刷新，以及同步在飞时可能漏掉后续文件变化的问题
- anime-pictures 插件被 Cloudflare 403：改用畅游的 Cookie 与 UA
- linux 下打开图片所在文件夹没有自动定位到图片
- 栅格模式显示图片下，图片填充方式设置的丢失问题（fit、fill）
- 窗口最小尺寸为0的bug
- linux下拖动画廊文件无效的bug（修复后可以拖动到文件管理器、浏览器、微信等其他应用中）

### Optimized
- 本地文件夹同步改为文件级增量事件；长任务延迟显示并提供逐目录百分比与取消能力
- 进度条里的进度文案放到进度条下方，不挤空间
- 进度条宽度调整，在极端窄的情况下隐藏。

### Changed
- 本地文件夹目录消失时删除对应画册树但保留图片记录；文件消失时只删除图片记录，不删除磁盘文件
- 视频暂停时进度条不常驻
- 高级搜索被作为普通搜索的补充，而非替代
- 对于更新元数据功能，会更新覆盖已有的相同的图片元数据，通常无害但会有数据更改。

## 开发侧

### Added
- 畅游一键下载：`surf_collect.rs` 以 Tauri Channel 与内容页通信（Rust 权威 run 状态机，内容页脚本 `concat!` 成封闭 IIFE、不挂 window 全局）；页面发现脚本 `page_discover.js` 供后续 webpage runner 复用；快照写入 metadata 表并只以标题与 URL 建搜索索引
- 新增本地文件夹 `fs_listener` + `synchronizer` 双管道与跨画册 CPU 核数并发限制
- 添加了 cef 、 cef-rs 补丁，为了实现linux的拖拽，维护负担增加
- V8 插件新增 `Kabegame.cefUserAgent()`，返回畅游（桌面 CEF）的默认 UA，配合 `requireCookie()` 解决 Cloudflare `cf_clearance` 绑定 UA 导致的 403；Chrome 大版本号写死在 `ops.rs` 的 `CEF_CHROME_MAJOR`，升级 CEF 时同步

### Changed

- `changelog.md` 放到了 [versions](/versions/) 文件夹下方
- windows下拖动文件通过新的download端点下载，可以显示真实文件名称。
