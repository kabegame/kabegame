# v2.0.3 changelog

## Changed

- 改用mmap优化图片的读取性能
- 修复发布action问题
- 固定一个大页为1000大小，不使用分小页，简化应用，增加代码复用和可扩展性
- 商店图标拉取改为最大并发10个

## Fixed

- 修复快速滚动之后需要小步滚动才能加载的bug
- 修复task-detail缩略图加载缓慢问题，修复vue的transition-group对相同key复用退出动画迟延问题（直接给AlbumDetail和TaskDetail加虚拟滚动就可以了）
- 商店插件与本地插件icon当id相同时重叠的问题
- 更新README文档
