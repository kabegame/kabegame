# Changelog

本项目的所有显著变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [3.2.3]
### Fixed
- **ImageItem (video):** Stopped showing the Element Plus image-variant loading skeleton on top of video (`isVideo` excluded via `v-if`), which had appeared as a small centered picture placeholder while the video played underneath (e.g. gallery grid, album cards).
- Gallery: your last browse location (root, sort, page) persists across restarts, the sort menu matches what you see, and changing sort no longer resets the page.
- migrate crash for some version of kabegame
- Plugin browser store installs now reuse downloaded packages from cache instead of always re-downloading.

### Changed
- Builtin plugin removed, must download from remote.
- Github release remote source cannot be deleted.

### Optimized
- Task drawer and “copy error” details now only list plugin run options that apply to the current configuration (same `when` rules as the run form), not hidden/irrelevant fields.
- HTTP downloads (crawler images and plugin store `.kgpg`) now resume in memory when the stream fails: retry requests use `Range` from bytes already received; if the server ignores Range (non-206), the client falls back to a full re-download to avoid corrupt concatenation.
- Crawler Rhai: `to()` and `fetch_json()` emit task-log `info` lines (request start, success with resolved URL / stack depth / JSON type) for easier script debugging.
- **Plugin browser (store):** `.kgpg` download streams into memory then writes once (no partial cache files); `get_store_plugins` merges active download progress; progress callbacks are throttled to 1s; up to two retries after a failed attempt. `preview_store_install` emits `plugin-store-download-progress` for the UI.
- **Plugin browser (store):** install button shows download progress as a left-to-right fill with percentage; when the installed version equals the store version, the control is a disabled “Installed” state (no reinstall), and plugin detail opens from the local install (no remote query) so docs load offline.

## [3.2.2]
### Added
- linux plasma plugin for plasma video wallpaper

### Fixed
- linux install fail because of ffmpeg name conflict
- some plugin name i18n object bug
- local import fail bug
- linux video wallpaper cause kabegame crash bug
- **Thumbnail MIME for video:** Server was sending `Content-Type: video/mp4` when serving video thumbnails (GIF/JPG), so the browser could not render them in `<img>`. Thumbnail endpoint now infers MIME from the thumbnail file path. On Linux, video thumbnail load failure no longer falls back to the original MP4 URL in the image loader.
- Linux wayland use X11 GDK_BACKEND
- Random wallpaper rotation could get stuck alternating between only two images (e.g. after task export); fixed by replacing time-based modulo with splitmix64 mixing so index selection is uniform on Windows (100ns clock resolution).

## [3.2.1]
### Added
- i18n, including README document and application frontend.

### Fixed
- 任务日志弹窗：新日志到达时不再自动滚到底部，保持用户当前滚动位置。

### Optimized
- restore last path at gallery when bootstrap.
- restore last tab of setting page when bootstrap.
- kgpg document image load

## [3.2.0]
（这是一次更大的改动，带仍不增加大版本号）
### Added
- 添加畅游页面，用户可以通过内置浏览器直接下载任何网址图片到kabegame
- 支持视频壁纸（mp4、mov）
- MacOS窗口模式，支持更丰富的壁纸填充模式、过渡效果
- 添加画廊固定列数设置，比如你可以设置固定为2列
- 新增两个爬虫插件（包括对p站的支持）
- 添加下载等待间隔设置
- 添加图片溢出对齐设置

### Fixed
- 随着下载进行，所选项目被重置的问题
- 从其他页面回到画廊，顺序被重置为正序的问题
- 图片没有刷盘导致偶尔不能正常下载问题
- 与爬取配置相关的各种前期没有考虑的奇怪bug
- 手机预览图片上划手势的部分奇怪错误
- 手机安全区检测不准确导致导航键挡住tab
- 手机点击插件文档无法打开系统浏览器查看的bug

### Optimized
- 提高爬虫网络重试的健壮性

## [3.1.0]
（这是一次大改动，因此将版本升级）
### Added
- 添加webview插件，可以编写js插件啦！第一个例子是 anime-pictures 插件
- 添加任务日志查看功能

### Fixed
- 修复画册细节页面右键移除画册没有反应的bug
- 将后端F11监听改到前端，避免占用其他浏览器快捷键
- 本地导入例程百分比计算问题
- 任务取消仍然显示在运行的问题
- 修复启动时窗口闪烁以及静默启动时窗口闪烁问题
- 画廊页面刷新之后回到第一页的问题

### Optimized
- 插件详情页面用marked来渲染markdown，支持更全面
- 已安装的插件显示版本

## [3.0.5]
### Added
- 一键加入所有任务图片到画册功能
- 官方商店源可以删除

### Fixed
- 修复多次启动应用singleton检测bug
- 修复F11响应，应用处于焦点时才全屏
- 修复路径上带空格的图片无法正常打开所在文件夹
- 若干右键上下文菜单被预览框遮住的bug
- 增加本地图片文件的安全性，并为后来本地同步图片服务做准备
- 修复图片列表变化时预览图没有及时合理地更新的bug（删除、增加等）

### Changed
- 模式精简：将 Normal/Local/Light 三种模式改为 Standard/Light 两种模式
- 去掉「内置插件」概念：所有插件一视同仁，支持卸载和覆盖安装
- 两种模式都支持插件商店，Standard 模式额外支持虚拟磁盘和 CLI

### Removed
- 去掉任务失败时dump.json的生成

### Optimized
- 远程插件的缓存
- 安卓部分表单控件UI优化

## [3.0.4]
### Fixed
- 随着预览图切换，所选择的图片项也跟着切换
- 任务正确显示删除图片数量
- 当拖入可识别文件类型，应用会自动置顶
- 桌面宽高比计算问题
- 修复跳过不支持的图片
- 整理启动流程，优化启动速度
- MacOS 图标大小比周围大一圈的问题

### Added
- 添加 MacOS M芯片应用打包（normal、loccal、light三模式）
- 添加安卓apk支持

### Changed
- 将cli从导入中移除，导入插件时直接启动main，大大减小light模式下linux的打包大小，并兼容macos的mime打开方法。
- 随着预览图的切换，当前选择项目也会跟着变化
- 重复启动应用会导致原来的应用窗口显示，而非
- 内置插件不复制到用户数据目录，而是保持在资源目录
- 下载流程整理，抽象协议下载器更好维护
- 性能优化，画廊有http浏览器原生流式加载，不再手动维护blob声明周期

### Removed
- 去掉cli打开插件显示预览
- 去掉light模式的linux的虚拟磁盘支持
- **去掉插件编辑器**，为之后的js插件做准备
- **去掉本地导入插件**，改用内置的本地导入例程

## [3.0.3]
### Added
- 添加linux plasma支持
- 添加linux fuse虚拟盘支持

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


