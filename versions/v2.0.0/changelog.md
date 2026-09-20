# v2.0.0 changelog

## Added

- zip文件导入支持。可以通过本地文件导入功能导入，以及手动拖入
- 支持导入文件夹zip文件时自动创建画册
- 插件编辑器，以单独的进程运行
- cli命令行，可用的命令为 kabegame-cli plugin run/pack
- 添加虚拟盘，可以通过文件资源管理器直接看画册的图片啦
- rhai脚本新增 download_archive

## Changed

- 将 ImageGrid 与 GalleryView 合并为一个组件
- 为 ImageGrid 添加虚拟滚动和按需加载等优化，轻松对应数万、甚至十万百万级别的滚动
- 使用worker而非创建线程，多任务不再卡顿
- 图片的主码从字符串变成数字
- 重构 imageSrcMap 为全局store

## Deprecated

- 壁纸的style字段和transition字段，该字段现在做成了按模式保存

## Removed

- 本地文件导入插件和本地文件夹导入插件

## Fixed

- 多选情况下单击不会退出多选，也可以双击打开预览图
- 当数据库过大的时候不全数据库扫描，避免打开黑屏问题
- 源文件不存在的image右上角出现红色小感叹号
- 窗口最小化的时候壁纸窗口弹到顶部
