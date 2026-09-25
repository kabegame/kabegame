# v4.4.1 changelog

## 用户侧
### Fixed
- anime-pictures 插件被 Cloudflare 403：改用畅游的 Cookie 与 UA
- linux 下打开图片所在文件夹没有自动定位到图片
- 栅格模式显示图片下，图片填充方式设置的丢失问题（fit、fill）

### Optimized
- 进度条里的进度文案放到进度条下方，不挤空间

## 开发侧

### Added
- V8 插件新增 `Kabegame.cefUserAgent()`，返回畅游（桌面 CEF）的默认 UA，配合 `requireCookie()` 解决 Cloudflare `cf_clearance` 绑定 UA 导致的 403；Chrome 大版本号写死在 `ops.rs` 的 `CEF_CHROME_MAJOR`，升级 CEF 时同步

### Changed

- `changelog.md` 放到了 [versions](/versions/) 文件夹下方