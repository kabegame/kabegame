# Changelog

本项目的所有显著变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- zip文件导入支持。可以通过本地文件导入功能导入，以及手动拖入
- 支持导入文件夹zip文件时自动创建画册
- 插件编辑器，以单独的进程运行
- cli命令行，可用的命令为 kabegame-cli plugin run/pack

### Changed
- 将 ImageGrid 与 GalleryView 合并为一个组件
- 为 ImageGrid 添加虚拟滚动和按需加载等优化，轻松对应数万、甚至十万百万级别的滚动
- 使用worker而非创建线程，多任务不再卡顿
 
### Deprecated
- 壁纸的style字段和transition字段，该字段现在做成了按模式保存

### Removed
- 本地文件导入插件和本地文件夹导入插件

### Fixed
- 多选情况下单击不会退出多选，也可以双击打开预览图
- 当数据库过大的时候不全数据库扫描，避免打开黑屏问题
- 源文件不存在的image右上角出现红色小感叹号
- 窗口最小化的时候壁纸窗口弹到顶部

---

## [1.1.2] - 2026-01-06

### Added
- 

### Changed
- 

### Fixed
- 

---

## [1.0.0] - YYYY-MM-DD

### Added
- 初始版本

---

## 变更记录指引（建议）

- **前端（Vue3/Vite/ElementPlus）**：`src/`
  - 例如：页面/组件改动、交互变更、状态管理、性能优化、样式主题等
- **后端（Tauri v2/Rust）**：`src-tauri/`
  - 例如：命令/事件、下载队列、壁纸管理器、存储/迁移等
- **插件系统（Rhai / crawler-plugins / .kgpg）**
  - 例如：Rhai API 变更、插件打包格式、插件商店安装/更新、兼容性说明等


