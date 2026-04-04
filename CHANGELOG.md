# Changelog

本项目的所有显著变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
 
**Changelog entries:** Write release notes in **English** (new sections and bullets from [3.4.5] onward).

## [3.4.5]
### Added
- **Organize gallery:** Option **Remove unrecognized media** — removes DB rows whose file still exists on disk but fails `is_media_by_path`.
- **Organize gallery:** When total image count is greater than 4000, the dialog shows a range slider (step 1000, minimum span 1000) to limit processing to an `id` ASC slice in this run; added `get_organize_total_count` for the UI to fetch the total.

### Fixed
- **Gallery / `query.path`:** Paginating with a time filter (e.g. `date/2026/1`) no longer strips the year as if it were a page number; paths are built consistently via `parseGalleryPath` / `buildGalleryPath` and Pinia route state.
- **HTTP file server (original files):** `handle_file_query` sets `Content-Type` from the database `images.type` field (`ImageInfo.media_type`) when present, otherwise falls back to path-based inference; thumbnail requests still infer MIME from the thumbnail path (may differ from the original format).

### Changed
- **Gallery / routing:** Introduced `createPathRouteStore` and stores `galleryRoute`, `albumDetailRoute`, `taskDetailRoute`, `surfImagesRoute` for `query.path` parsing, navigation, and (gallery) localStorage persistence; removed `useProviderPathRoute` and `useGalleryPathState`.
- **UI:** `GalleryToolbar` takes `root` / `sort` and syncs with `update:root` / `update:sort`; `GalleryFilterControl`, `GallerySortControl`, and `AlbumDetailBrowseToolbar` align with those stores.
- **Organize / IPC:** `start_organize` and the CLI daemon `OrganizeStart` add `remove_unrecognized`, `range_start`, and `range_end`; IPC uses serde defaults for backward compatibility with older clients.
- **Organize (header):** While organizing, the gallery header control shows a spinning folder icon; hover shows a tooltip with progress; click opens a popover (manual trigger) with `el-progress`, this run’s options and range, a note that new downloads are not included during the run, and Cancel / Confirm to close the popover; `useModalBack` registers the popover on Android.

## [3.4.4]
### Added
- **Plugin:** 米游社 Plugin. Also support for boolean when condition. 
- **Rhai API:** when resolve for bool type.

## [3.4.3]
### Added
- **Plugin:** heybox plugin. can crawl by searching keyword and single post url.
- **Rhai API:** create_image_metadata function.

### Fixed
- **Windows SURF:** Freeze on windows when downlaod a image.
- some i18n issue

## [3.4.2]
### Added
- **Rhai crawler:** `warn(message)` writes a warn-level line to the task log (same channel as HTTP retry notices).
- **Plugin config:** Per-option `when` on `options` / `checkbox` entries (same semantics as field-level `when`); crawler/default-config/auto-config forms reset invalid option values when filters change.

### Changed
- **Pixiv plugin:** Ranking crawl uses separate mode/content/age fields, single `ranking_date`, JSON `next` pagination, Rhai `warn()` for shortfall, and R18 requires account UID + Cookie.
- **Pixiv plugin:** Ranking `content_mode` shows whenever `source` is ranking; each `ranking_mode` option uses `when` on `content_mode` (illust/manga vs ugoira vs all-only modes).
- **Pixiv plugin:** Multi-page illusts use download names `title(1)`, `title(2)`, …; single-page keeps plain `title` (fallback: illust id when detail missing).
- **IPC / gallery:** `images-change` (`DaemonEvent::ImagesChange`) now includes optional `albumIds`, `taskIds`, and `surfRecordIds` so album/task/surf views and the Plasma wallpaper plugin can refresh selectively.

### Fixed
- **Album/Task:** Not update image list when delete image source.

### Optimized
- **Pixiv plugin:** Store only EJS-needed fields in `images.metadata` (`crawl.rhai` + one-time DB trim for existing rows) to speed gallery/album lists when metadata was huge.
- Remove some unnecessary call of refresh cache.
- Self update for shop source list when expires 24h.
- reuse connection pool, download be more fast!
- not query metadata for common query.

### Removed
- remove android scheduled config cause it is hard to implement.

## [3.4.1]
### Added
- **RunConfig:** Title bar actions for "Start collection" and "Quick settings"; quick drawer: importing a recommended preset enables schedule by default and common download-related settings.
- **Image:** downloaded image now can display a custom name and html description for detailed and comprehensive information. Even js are enabled for fetch comments of an image, just like on the website.

### Fixed
- **Dedup**: silent dedup for hash dedup bug.

## [3.4.0]
### Added
- **RunConfig**: Auto run schedule feature. Plugin recommand config for on click import.
- **RunConfig / schedule:** `weekly` mode: choose weekday and time of day (`schedule_spec`: `{ "mode": "weekly", "weekday", "hour", "minute" }`, `weekday` 0 = Monday … 6 = Sunday).
- **Plugins:** Settings → Plugin defaults: per-plugin crawl defaults (vars, HTTP headers, output dir) in `plugins-directory/default-configs/<pluginId>.json`, preferred when picking a source in crawl/auto-config UIs with per-field fallback, auto-created on import or first open.
- **Task:** Crawl task progress bars when `progress > 0` (task drawer, task panel, inline summary rows): default styling while running, explicit red for failed and neutral gray for canceled; progress is kept on failure/cancel so the bar reflects how far a run got.

### Optimized
- **Plugins:** Installed plugin icons and multilingual `doc.md` docs are fetched in parallel with recommended presets after `loadPlugins` and cached in `usePluginStore` (`get_plugin_icon` / `get_plugin_doc_by_id`); pages and drawers no longer request icons redundantly.
- **TaskDrawer**: optimize the performance of switching visiablity.
- **Crawler store:** Load tasks and run configs once inside `defineStore`, expose `runConfigsReady` / `tasksReady`, drop redundant view-level loads, and patch run configs locally after writes instead of full-table reloads.
- **Plugin store:** `loadPlugins` applies `get_plugins` results in a `.then` handler with an empty default list; narrowed call sites to the plugin browser (manual refresh / store install) plus post-install paths, removing gallery and related prefetch.

## [3.3.1]
### Added
- **Plugins / collect form:** `config.json` 变量类型 **`date`**：桌面与安卓收集对话框使用 Element Plus 日期选择器，值为 `YYYY-MM-DD` 字符串；应用语言与 Element Plus 组件语言通过根级 `el-config-provider` 对齐。见 `docs/README_PLUGIN_DEV.md`、`docs/RHAI_API.md`。
- **Crawler Rhai:** `re_replace_all(pattern, replacement, text)` — global regex replace using Rust `regex` (invalid pattern returns the original string); see `docs/RHAI_API.md` and `docs/CRAWLER_BACKENDS.md`.

### Fixed
- **Crawler Rhai:** Reqwest enables **gzip** decompression for plugin HTTP fetches so `to()` / `fetch_json()` store decoded HTML/CSS bodies instead of raw compressed bytes (fixes empty `query` / `get_attr` on gzip-only responses).

### Changed
- **Plugins:** Crawler plugins that rely on gzip-correct `to()` parsing or `re_replace_all` (e.g. wallpapers-craft) require **Kabegame 3.3.1+**.
- **Plugins:** Min version restriction for plugin.

## [3.3.0]
### Added
- **Failed images page:** Bulk retry, cancel waiting retries, and delete all for the current plugin filter; header actions refresh and task drawer; per-item download phase labels and cancel while queued; retries run asynchronously with optional abort on capacity wait.
- **Task:** Dedup count per task: when an image is skipped as duplicate (URL or hash match), the task’s dedup count increments and a dedicated event updates the UI in real time; shown in the task detail subtitle and in the task drawer (count badge and expanded params).
- **Task:** Task drawer shows success, failed, and deleted counts under each task name (with icons); counts are loaded alongside the task list without extra requests.
- **Task:** Retry download for failed images: on the task detail page, when viewing the failed list, each failed item has a retry button to re-attempt the download; supports deleting failed records and copying error details (plugin, time, URL, error message).
- **Surf:** Record detail dialog: click a record card to open it; edit name, entry path (with full-URL preview), view/copy saved cookie, or delete the record; structure aligned with image detail dialog.
- **Surf:** Right-click context menu on records: view downloaded images, open detail dialog, or delete record.
- **Surf:** Cookie saved to database automatically when each page finishes loading in the surf window; available in the detail dialog without an active session.
- **Gallery / Album / Task / Surf:** Configurable **images per page** (100, 500, or 1000), saved in app settings; change it from the gallery toolbar, album browse bar (desktop) or header overflow (Android), task/surf tool row above the paginator, or **Settings → App**; switching value reloads the current list from page 1.
- **Gallery:** More filter options (e.g. by time range, by source plugin, and wallpaper history), with plugin labels shown in your language where applicable.
- **Gallery / virtual disk:** Sort and browse images by **last time they were set as wallpaper** (ascending or descending); virtual disk includes a matching root folder and reverse-order subfolder where applicable.
- **Gallery:** Lists using this sort refresh when the current wallpaper changes (including rotation), so order stays consistent without manual reload.

### Fixed
- **Windows:** Image downloads, plugin store, favicon fetching, and proxy requests now respect system proxy when set in Windows (Settings → Network → Proxy); reads registry when HTTP_PROXY/HTTPS_PROXY env vars are unset.
- **Task:** Migration cleans up orphaned failed images (those whose task no longer exists); deleting a task or clearing finished tasks now removes all related failed images.
- **Android image preview:** Pinch-to-zoom no longer accidentally toggles UI controls (close button, counter bar) visibility.
- **Gallery (Android):** In multi-select mode, fast taps that the browser treats as a double-click no longer open the image preview; selection toggling stays the only action.
- **Android image preview:** Swipe-up delete stays reliable after horizontal swipes; deleting the last image on a page keeps the full-screen carousel on the correct slide (no off-by-one preview or erroneous wrap to the first image).
- **ImageItem (video):** Stopped showing the Element Plus image-variant loading skeleton on top of video (`isVideo` excluded via `v-if`), which had appeared as a small centered picture placeholder while the video played underneath (e.g. gallery grid, album cards).
- Gallery: your last browse location (root, sort, page) persists across restarts, the sort menu matches what you see, and changing sort no longer resets the page.
- migrate crash for some version of kabegame
- Plugin browser store installs now reuse downloaded packages from cache instead of always re-downloading.
- **Plugin detail page (i18n):** Labels for plugin ID, name, version, description, crawl URL, empty-description text, copy, and link-open errors follow your selected app language instead of hard-coded Chinese.- **Plugin browser (official source name i18n):** The built-in official GitHub Releases source name is written to the database on startup and when the app language changes (same pattern as the favorite album name sync via `kabegame_i18n`). Storage emits `plugin-sources-changed` so the plugin browser reloads the source list.

### Changed
- **Surf:** Clicking a record card opens the detail dialog instead of starting a session; a dedicated “Start surfing” button on each card starts the session (disabled while a session is active).
- **Surf:** “View recent images” replaced with a “View downloaded images” button on record cards.
- **Surf:** Removed top-bar “View Cookie” and “End session” buttons; cookies are accessed in the record detail dialog; session is ended by closing the surf window.
- **Gallery (desktop):** Filter and sort moved from the page header to the row below the title (above the big paginator), matching album detail; on Android they stay in the header overflow menu with bottom pickers.
- Builtin plugin removed, must download from remote.
- Github release remote source cannot be deleted.

### Optimized
- Task drawer and “copy error” details now only list plugin run options that apply to the current configuration (same `when` rules as the run form), not hidden/irrelevant fields.
- HTTP downloads (crawler images and plugin store `.kgpg`) now resume in memory when the stream fails: retry requests use `Range` from bytes already received; if the server ignores Range (non-206), the client falls back to a full re-download to avoid corrupt concatenation.
- Crawler Rhai: `to()` and `fetch_json()` emit task-log `info` lines (request start, success with resolved URL / stack depth / JSON type) for easier script debugging.
- **Plugin browser (store):** `.kgpg` download streams into memory then writes once (no partial cache files); `get_store_plugins` merges active download progress; progress callbacks are throttled to 1s; up to two retries after a failed attempt. `preview_store_install` emits `plugin-store-download-progress` for the UI.
- **Plugin browser (store):** install button shows download progress as a left-to-right fill with percentage; when the installed version equals the store version, the control is a disabled “Installed” state (no reinstall), and plugin detail opens from the local install (no remote query) so docs load offline.
- **Plugin detail page:** When you install from the store on the source detail / doc page, the install button shows the same live download progress (fill + percentage) as on the plugin store grid. The summary at the top now includes a **Version** row so you can see the package version at a glance.
- **Plugin browser （Android）** Store and installed lists use a two-column square card layout
- **Plugin doc:** Images in plugin Markdown docs open in a full-screen preview on tap or click: Android uses PhotoSwipe (no looping); desktop uses the Element Plus image viewer (no infinite wrap). Natural size is resolved after load so PhotoSwipe gets correct dimensions.

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


