# v4.4.1 changelog

## 用户侧
### Added
- 任意搜索功能，本质上是所有其他搜索（名称、元数据等）的按或查询

### Fixed
- anime-pictures 插件被 Cloudflare 403：改用畅游的 Cookie 与 UA
- linux 下打开图片所在文件夹没有自动定位到图片
- 栅格模式显示图片下，图片填充方式设置的丢失问题（fit、fill）
- 窗口最小尺寸为0的bug
- linux下拖动画廊文件无效的bug（修复后可以拖动到文件管理器、浏览器、微信等其他应用中）

### Optimized
- 进度条里的进度文案放到进度条下方，不挤空间
- 进度条宽度调整，在极端窄的情况下隐藏。

### Changed
- 视频暂停时进度条不常驻
- 高级搜索被作为普通搜索的补充，而非替代

## 开发侧

### Added
- 添加了 cef 、 cef-rs 补丁，为了实现linux的拖拽，维护负担增加
- V8 插件新增 `Kabegame.cefUserAgent()`，返回畅游（桌面 CEF）的默认 UA，配合 `requireCookie()` 解决 Cloudflare `cf_clearance` 绑定 UA 导致的 403；Chrome 大版本号写死在 `ops.rs` 的 `CEF_CHROME_MAJOR`，升级 CEF 时同步

### Changed

- `changelog.md` 放到了 [versions](/versions/) 文件夹下方
- windows下拖动文件通过新的download端点下载，可以显示真实文件名称。