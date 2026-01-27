# Changelog

本项目的所有显著变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [3.0.3]
### Added
- 添加linux plasma light mode 构建


### Fixed
- 整理了启动流程，重新整理了一下架构
- 修复默认输出目录包含插件目录的bug

## [3.0.2]
### Added
- F11全屏快捷键
- 新增 `bun check` 命令：按组件依次检查 `vue-tsc` 与 `cargo check`
  - `bun check` 必须指定 `-c, --component`
  - `--skip` 统一为 `vue|cargo` 且只能指定其中一个值
- plugin editor 支持全量的变量类型
- plugin editor 支持不手动输入json指定变量类型
- Rhai 脚本新增 HTTP Header 接口：`set_header` / `del_header`
- plugin-editor Rhai 编辑器补全/悬浮/签名提示新增 `set_header` / `del_header`
- plugin-editor 测试面板支持配置 HTTP Header
- ctrl + c 复制图片快捷键
- rar 解压缩导入支持

### Changed
- 将构建脚本从js升级到ts，类型更安全
- 将服务端ipc代码移到core
- 构建命令支持 `--skip vue|cargo`（只能一个值；main 支持 `--skip vue` 跳过前端构建）
- 将 release 放到了git中，原因：
  1. 方便用户从README直接下载
  2. 方便引用
  3. 不用调试github action
  4. 不用等待github action的缓慢运行
  5. 不用为了action ci而调整构建代码
  6. 不用维护action和script两处代码
  7. 克隆仓库的用户可以直接从 release 目录下运行安装脚本
  缺点是
  1. git 包增加约100mb，上传下载都变得耗时
  2. 每次发布都要更新 README.md，不过不复杂
  但是考虑到这是对C的终端应用，所以这些缺点可以接受。因为克隆仓库的人不多。
- 爬虫中的重定向会带上所有原始header

### Removed
- 经过考虑去掉 plasma 插件。原因：
  1. 几乎没有文档，只能借鉴社区里的若干项目
  2. 调试困难，每次都要重启 plasma shell
  3. 同步问题繁琐，插件和主应用之间的状态管理复杂
  4. 功能不强。插件提供的功能主应用几乎都能提供，而且插件还依赖主应用的运行
  5. 侵入性高。用户在运行plasma插件的同时不能用其他插件
  6. 用户不多。社区最火的插件全球安装量只有2w+，不值得投入太多精力开发
  7. 安装、卸载逻辑复杂，要在deb包里维护这些逻辑
  8. 无法发行在商店，或者发行复杂。因为商店不支持deb包发行，只支持tar.gz，导致不能安装.so。

### Fixed
- plugin editor 任务列表显示插件名称问题
- 画廊切换到其他tab导致画廊页面归一的问题
- kgpg拖拽导入将kgpg当作图片的bug
- 修复 light 和 local 关于内置插件的问题
- 修复 reqwest 30x 处理问题
- 当一次性导入过多压缩包导致死锁问题。解决方案是用一个专门的线程解压缩

## [3.0.1]
### Changed
- 经过各种考虑，去掉daemon，改成app-main内嵌服务，原因如下：
  1. daemon状态管理太复杂
  2. 与app-main的交互存在显著性能开销
  3. 未来做self-hosted不好迁移
  4. 用户无法轻易关闭的后台服务很令人反感。

## [3.0.0]
### Added
- linux plasma 支持（原生壁纸设置以及壁纸插件模式）
- linux plasma wallpaper plugin 子仓库

### Changed
- 架构迁移到一个daemon负责底层数据，其他前端与之通过ipc交互（windows 命令管道，unix 用 UDS）
- cli 不常驻，与daemon交互操作
- **plugin-editor 迁移到 IPC 架构**：插件编辑器现在通过 IPC 与 daemon 通信，而不是直接访问本地 State
  - 添加 `daemon_client.rs` 模块统一管理 IPC 客户端
  - 存储相关命令（任务、图片）迁移到 IPC
  - 设置相关命令迁移到 IPC
  - 启动时自动确保 daemon 已就绪
  - 本地仅保留运行临时任务所需的组件（TaskScheduler、DownloadQueue）
- **cli 的输出画册参数改为使用画册名称**：`--output-album-id` 改为 `--output-album`，因为画册名称已经固定。CLI 会自动将画册名称转换为 ID（不区分大小写）

## [2.1.1]
### Added
- cli 添加 vd 子命令，可以常驻后台服务虚拟磁盘

### Changed
- main 程序在无法挂载磁盘的时候会用cli提权，并通过管道通信

### Fixed
- 修复actions pnpm老是报错

## [2.0.3]
### Changed
- 改用mmap优化图片的读取性能
- 修复发布action问题
- 固定一个大页为1000大小，不使用分小页，简化应用，增加代码复用和可扩展性
- 商店图标拉取改为最大并发10个

### Fixed
- 修复快速滚动之后需要小步滚动才能加载的bug
- 修复task-detail缩略图加载缓慢问题，修复vue的transition-group对相同key复用退出动画迟延问题（直接给AlbumDetail和TaskDetail加虚拟滚动就可以了）
- 商店插件与本地插件icon当id相同时重叠的问题
- 更新README文档

## [2.0.0]

### Added
- zip文件导入支持。可以通过本地文件导入功能导入，以及手动拖入
- 支持导入文件夹zip文件时自动创建画册
- 插件编辑器，以单独的进程运行
- cli命令行，可用的命令为 kabegame-cli plugin run/pack
- 添加虚拟盘，可以通过文件资源管理器直接看画册的图片啦
- rhai脚本新增 download_archive

### Changed
- 将 ImageGrid 与 GalleryView 合并为一个组件
- 为 ImageGrid 添加虚拟滚动和按需加载等优化，轻松对应数万、甚至十万百万级别的滚动
- 使用worker而非创建线程，多任务不再卡顿
- 图片的主码从字符串变成数字
- 重构 imageSrcMap 为全局store
 
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


