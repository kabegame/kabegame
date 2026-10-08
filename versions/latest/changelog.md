# v4.5.1 changelog

## 用户侧
### Added
- 画廊搜索支持表达式：逗号「且」、分号「或」、`!` 「非」、小括号分组，`\` 转义或双引号表示字面量（如 `(girl; boy), cute, !genshin`）；输入有语法错误时会提示位置且不应用
- 新增切图方向设置，自动记住预览图查看的方向，在隐藏图片的时候自动切到对应方向，或者固定上一张或下一张

### Changed
- 勾选多个搜索范围时，每个词在任一范围出现即算命中（以前逗号分隔的词要求出现在同一范围里）
- yande、konachan 新增人气榜， danbooru 新增 rating，可以直接过滤非r18

### Fixed
- 重复导入已在图库中的文件时，「本地导入」任务偶发卡在「运行中 0%」且无法取消
- `kabegame-cli` 的任务日志不再输出 `{"_i18n":...}` 原文，按应用设置的界面语言显示
- 按元数据 / 原生元数据搜索并取非时，没有元数据的图片不再被一并排除
- 打开预览或整理时补算出原生元数据后，按原生元数据搜索的列表会实时更新，不必手动刷新；正在预览的图被移出列表时预览保持显示
- 取消任务现在通常能够立即取消
- 修复v8插件任务偶发卡在某条日志后不再推进、或运行插件时应用闪退的问题
- 修复画廊预览图片在切换图片的时候预览框一关一开的问题
- 本地导入去重太宽导致wait_after_download_if_needed减法下溢panic的bug，表现为本地导入任务永远不推进
- 原生元数据回填不发事件导致视图不刷新bug

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
- 移除 add_task 裸命令
