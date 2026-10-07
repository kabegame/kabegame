# v4.6.0 changelog

## 用户侧
### Added

### Fixed
- 重复导入已在图库中的文件时，「本地导入」任务偶发卡在「运行中 0%」且无法取消
- `kabegame-cli` 的任务日志不再输出 `{"_i18n":...}` 原文，按应用设置的界面语言显示

### Optimized

### Changed
- `kabegame-cli` 数据操作现在优先经 IPC 交给正在运行的同数据目录主程序，连不上时自动回退本地执行，也可用 `--via` 强制选择。

### Removed
- `kabegame-cli data import-image` 移除 `--metadata`；导入改由内建 `local-import` 任务执行，完成后输出成功、去重和失败计数。
- `kabegame-cli plugin run` / `plugin import` 移除 `--data`；数据目录只由构建时决定（发布版使用系统用户数据目录）。

## 开发侧

### Added
- kabegame-plugin skill改成默认用debug，可以通过 KABEGAME_CLI_PROFILE 切到release
- kabegame-cli 新增 app 模式和via参数，可以通过ipc连接运行中的app
- 任务调度 worker 对任务执行体 panic 兜底：按失败收尾并释放运行名额

### Changed


### Removed
