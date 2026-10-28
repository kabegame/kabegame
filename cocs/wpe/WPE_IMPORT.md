# Wallpaper Engine（WPE）壁纸导入

## 一、模型：一个壁纸是目录，不是文件

Wallpaper Engine 的每个壁纸是**一个目录**：

```
<壁纸目录>/
  project.json      # type / file / preview / title / tags / general.properties
  Wallpaper-1.mp4   # 入口（video 型的 file；web 型是 index.html 之类的入口页）
  preview.gif       # 作者提供的预览图（jpg / png / svg / gif）
  ...               # 其它资源（web 页面的 js / css / 图片等，scene 阶段会用到更多）
```

Kabegame 把整个目录作为一行 `images`：

| 列 | 值 |
|---|---|
| `local_path` | 壁纸目录的绝对路径（规范化、无 `\\?\`、无尾斜杠） |
| `type` | `x-wpe/video` / `x-wpe/web` 已入库；`x-wpe/scene` 只是占位 |
| `thumbnail_path` | `<目录>/<preview>`，直接引用 WPE 自带预览图，不生成缩略图 |
| `compatible_path` | 视频行**始终有值**：浏览器能播时就是入口视频本身（`<目录>/<file>` 绝对路径）；解不了的编码在 `compatibles_dir` 生成 H.264 MP4，生成失败也回落到入口视频。**网页行为空**（没有可播放媒体，页面经 `/wpe/<id>/` 加载） |
| `hash` / `size` / `width` / `height` | 入口文件的哈希、大小；视频行带探测尺寸，网页行宽高为空（页面没有固有尺寸） |
| `post_url` | 有 workshop id 时是创意工坊页面地址 |
| `metadata` | `project.json` 原文（`plugin_id = wpe-import`），供详情展示 |

**不复制、不转码、不写用户目录**。`local_path` 的唯一约束天然保证同一壁纸只入库一次；
取消订阅、壁纸更新只影响磁盘上那一个目录，Kabegame 不持有副本。从图库删除只删记录，
`x-wpe/*` 行的 `local_path` 永远不进源文件回收（`batch_delete_images` 按 type 分流）。

`type` 以 `x-wpe/` 开头即表示「目录型壁纸」。凡把 `local_path` 当文件用的地方都必须按类型
分流，不能按扩展名猜：

- `/file/{*path}` 对 `x-wpe/*` 行返回 404；
- 视频播放（预览大图、应用背景、壁纸窗口）一律走 `compatible_path` → `/compatible/{*path}`，不走 `/wpe`；
- 网页壁纸由跨源 iframe 加载 `/wpe/<imageId>/`（见第五、六节），相对资源落在同一前缀下；
- 缩略图删除只删 `thumbnails_dir` 内、由 Kabegame 生成的文件（否则会删掉作者的 `preview.gif`）；
- 整理流程对 `x-wpe/*` 跳过缩略图重建、兼容副本、哈希去重与「无法识别媒体」清理；
- 虚拟盘第一阶段隐藏 `x-wpe/*` 行（`vd_image_entry_from_row` 过滤，计数口径同源）；
- 原生壁纸 / Plasma 插件模式拒绝 `x-wpe/*`，轮播只允许窗口模式；
- 拖出、复制、分享、删除源文件在 WPE 行上禁用；「在文件夹中显示」打开壁纸目录本身。

## 二、格式键

格式表的唯一事实来源仍是 `kabegame_core::media::image_type::MEDIA_FORMATS`：

```rust
MediaFormat { key: "x-wpe/video", mime: "application/x-wpe-project", extensions: &[], .. }
MediaFormat { key: "x-wpe/web",   .. } // 已入库（第二阶段 Phase 3）
MediaFormat { key: "x-wpe/scene", .. } // 占位
```

- `extensions` 为空：目录型条目不能按扩展名摄入，只能经 `project.json` 入库；
  `get_supported_image_types` 与 `mime_by_ext` 不包含它们。
- `mime` 只是占位，目录型条目永远不经 `mime_from_format` 出边界；媒体服务按入口文件扩展名定 MIME。
- 辅助函数：`is_wpe_type`、`wpe_kind`、`is_wpe_video_type`、`is_video_like_type`
  （后端唯一的「视频形态」判定；不要再用 `is_video_by_path` 判断目录）。

## 三、发现与识别

`kabegame_core::wpe`：

- `discover.rs`：Windows 读 `HKCU\Software\Valve\Steam\SteamPath`，再解析
  `<Steam>/steamapps/libraryfolders.vdf`；Linux 依次尝试 `~/.steam/steam`、
  `~/.steam/root`、`~/.local/share/Steam`。只在含 app `431960` 的库里产出三类根：
  - 创意工坊：`<库>/steamapps/workshop/content/431960`
  - 官方默认：`<库>/steamapps/common/wallpaper_engine/projects/defaultprojects`
  - 我的项目：`<库>/steamapps/common/wallpaper_engine/projects/myprojects`
  macOS / Android / Web 不适用，返回空。VDF 用最小手写解析器（兼容新旧两种 `libraryfolders`
  格式），不引新依赖。
- `recognize.rs`：把用户随手选的文件夹展开成壁纸目录集合。支持单个壁纸目录、`431960`
  创意工坊根、`projects/`、`defaultprojects` / `myprojects`、WPE 安装目录、Steam 库根与
  `steamapps/`；其它目录向下最多两层找 `project.json`。
- `project.rs`：解析 `project.json`。`type` 归一为 `Video / Web / Scene / Application / Other`，
  `WpeKind::is_supported()`（目前 video 与 web）是「可导入」口径的唯一来源，已支持的类型都要求入口文件存在；
  `file` / `preview` 必须是目录内相对路径（拒绝绝对路径与 `..`）；`preview` 缺失或越界归为
  `None`；`workshopid` 缺失时用 `431960/<纯数字目录名>` 回退，便于拼创意工坊链接。
  跳过原因 `WpeSkip::{NoProject, Unsupported, MissingEntry, Invalid}` 计入任务日志与统计。
- `properties.rs`：把 `general.properties` 的作者默认值换算成 `WpeVideoProps`，
  不读 WPE 的 `config.json` / `wproperties`（用户改过的值不带入）。

## 四、收集入口与内建任务

「开始收集」菜单新增第四项 **壁纸**（桌面端；Web / Android 隐藏）。对话框 `WallpaperImportDialog`
打开即调 `wpe_scan`，按三类来源显示「N 个壁纸 / M 个可导入 / 视频 v · 网页 w / K 个已导入」
（可导入 = 已支持类型且未入库；类型分布为 0 的项省略），默认勾选有待导入项的来源；
「添加文件夹」经 `wpe_recognize_dir` 识别后追加。确认后提交内建任务 `wpe-import`
（与 `local-import` / `webpage` 同形），复用任务列表、进度、取消、空跑与日志。

任务变量：

- `sources`：checkbox，`workshop` / `defaultprojects` / `myprojects`，默认全选；
- `extraDirs`：`list`，对话框识别出的目录；未选时省略（空数组会被变量校验拒绝）。

`crawler/wpe_import.rs` 逐目录读 `project.json`：`Video` 走 `import_wpe_video`、`Web` 走 `import_wpe_web`
（`import_wpe_project` 按类型分派，dry-run 与结果计数共用一处），其它类型计入「跳过」并写日志。两类共用
`base_image_info`（来源、预览图、创意工坊链接、metadata）与 `finish_insert`（写库、`images-added`、画册、标签、日志），
各自只覆盖 `type` / 宽高 / `compatible_path`。`local_path` 已存在时幂等，只补目标画册成员（视频另补缺失的
`compatible_path`）；`tags` 挂到 `WPE/<tag>` 标签画册（`validate_labels` 校验，非法 tag 逐条写警告）。

## 五、目录服务 `/wpe/<imageId>/<rel>`

只挂在本地媒体路由（`file_routes` / `file_routes_media`），Web 发布版不挂：

- 授权只认 `type` 为 `x-wpe/*` 且 `local_path` 是目录的行，否则 404；
- `/wpe/<id>/` 读 `project.json` 的 `file`，307 到 `/wpe/<id>/<file>`（前端不需要知道入口名；iframe 文档加载跟随正常）；
- `/wpe/<id>/<rel>`：`local_path.join(rel)` canonicalize 后必须仍位于该壁纸目录内、且是普通文件；
  MIME 由 `wpe_mime_from_path` 决定：先查 `/wpe` 专属静态表 `WPE_WEB_MIME`（html / htm / js / mjs / css / json / map /
  svg / xml / txt / wasm / woff / woff2 / ttf / otf / webm / ogg / ogv / oga / mp3 / wav），再回落媒体格式表，
  仍查不到（含无扩展名）为 `application/octet-stream`。网页类型**不进** `MEDIA_FORMATS`：那张表是「可入库媒体格式」的
  唯一事实来源，混进网页类型会污染 `supported_media_extensions` 一类派生。非 HTML 文件复用 `serve_file_with_mime`
  （流式 + Range），但缓存头改为 `Cache-Control: no-cache`：WPE 目录里的文件会原地变化（创意工坊更新、作者或用户
  手改）而 URL 不变，沿用媒体文件的一年 `immutable` 会让页面一直跑旧 js / css。
- 作者脚本常用 javascript-obfuscator 的 `selfDefending`：对函数 `toString()` 做正则比对，代码被格式化（换行 / 缩进）
  就故意进入死循环，页面 `load` 永不触发。任何改写作者 js 的逻辑（Phase 4 的 zcompat 替换）都不能改变被检测函数的
  原文；同站点的 `/wpe` iframe 共用一个渲染进程，一个卡死的页面会连带后续网页壁纸一起超时。
- `text/html` 响应走专用产出点 `serve_wpe_html`：读整文件、`text/html; charset=utf-8`、`Cache-Control: no-store`、
  忽略 Range，**原样返回、不注入任何脚本**。WPE 垫片由主窗口的 all-frames 初始化脚本注入（见第六节「运行时垫片与宿主
  协议」），不改写 HTML；zcompat 兼容补丁的内存替换若以后要做，仍放在这里（不写回用户目录）。
- 不下发 CSP 头（与 WPE 一致）；主窗口 CSP 的 `frame-src` 放行 `http://127.0.0.1:*`（`tauri.conf.json.handlebars`）。

**Video 阶段不用它播放**：CEF 的 `<video>` 跟随 `/wpe/<id>/` 的 307 后报 `MEDIA_ELEMENT_ERROR: Format error`
（直接请求入口文件可正常播放，2026-10-25 真机 4K H.264 实测），所以视频统一走 `compatible_path`，
`/compatible` 按库里的 `compatible_path` 授权、直出文件、无跳转。Web 阶段复用本服务，
相对 js/css/资源自然落在同一前缀下；iframe 文档加载跟随 307 正常（Phase 1 实测）。

早期导入的行 `compatible_path` 可能为空；对同一来源重跑导入任务时，已入库行会补齐该字段并发
`compatiblePath` 字段补丁（dry-run 不写）。兼容文件删除护栏只删 `compatibles_dir` 内的文件，
指向用户目录的入口视频永远不会被删除或在整理时重建。

## 六、壁纸窗口

壁纸窗口与主窗口加载同一个 `index.html`，URL 为 `index.html?window=wallpaper`（`wallpaper/manager/window.rs`）。
`main.ts` 只做分发：按 `windowKind.ts` 的 `WINDOW_KIND` 动态导入 `bootstrap/app.ts`（主界面，原 `main.ts` 全部内容）
或 `bootstrap/wallpaper.ts`（只装 pinia、i18n、UnoCSS 与主题变量，不装 router / 组件库 / vant，不 `loadAll` 设置）。
Web 发布版与 Android 硬门控为主窗口。

- `views/WallpaperWindow.vue`：壁纸窗口根，负责看门狗（`sessionStorage.wallpaperInitRetry` + reload）、`setting-change`
  监听、启动时五个 getter 并行、`wallpaper_window_ready` 握手与 dev 调试面板，结果作为 props 交给渲染组件。
- `components/wallpaper/WallpaperStage.vue`：纯渲染组件（不 invoke / listen / 读 store；唯一例外是 web 层 iframe 的宿主桥
  `wpeWebBridge.ts`，见「运行时垫片与宿主协议」），base / top 双层、
  prep → enter → commit 过渡（两帧 rAF、1400ms 兜底）、去重与严格串行、tile、base 图退避重试、视频 base / top 元素交换、
  音量 / 倍速 / 循环，以及下表的 WPE 作者属性；铺满父元素，额外支持 `paused` / `interactive`（供后续预览内嵌）。
  DOM 仍按原实现命令式操作（模板 ref 只在挂载时取一次），过渡组合类放在 scoped `<style>`。
- 后端组装目标的逻辑在 `commands/wallpaper.rs` 的 `build_wallpaper_target(info)`，`get_current_wallpaper_target`
  与 `get_wallpaper_target_for_image(imageId)`（图库预览 / 背景按 id 取）复用它，所以预览与桌面拿到同一份目标结构。
  WPE 视频的作者属性取自**图片 metadata**（导入时写入的 `project.json` 原文，`resolve_video_props_from_raw`），
  不重读磁盘——用户属性以后作为同一份元数据里的一段合并进来。

`get_current_wallpaper_target` 返回 `{ id, path, type, compatiblePath, wpeVideo }`：

- 普通图片 / 视频：保持原行为（按扩展名或 type 播图 / 播视频）；
- `x-wpe/video`：播放 `compatible_path`（入口视频本身或兼容副本），为空时不播放；
  作者默认值经 `wpeVideo` 给前端，Kabegame 的样式 / 音量 / 倍速覆盖对应字段：

| 字段 | 来源 |
|---|---|
| 对齐 | Kabegame 壁纸样式：`fill`→cover、`fit`→contain、`stretch`→fill、`center`→none、`tile`→cover |
| 位置 `position` | 作者 `alignmentposition` × 0.01（cover / contain 时作用于溢出轴） |
| 偏移 / 缩放 | 作者 `alignmentx` / `alignmenty` / `alignmentz`（center / free 时作用于 stage） |
| 翻转 / 背景 / 颜色 | 作者 `alignmentfliph` / `schemecolor` / `wec_*` |
| 速率 / 音量 | Kabegame 全局设置（覆盖作者值） |

- `x-wpe/web`：`compatiblePath` 与 `wpeVideo` 为空。**桌面壁纸窗口**不渲染它（`WallpaperWindow.vue` 的 `acceptTarget`
  直接忽略），由 Rust 把整个窗口导航到入口的 `file://`（见下「桌面网页壁纸：`file://` 宿主」）；图库预览仍由
  `WallpaperStage` 的独立 **web 层**（跨源 HTTP iframe）渲染。

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

### 桌面网页壁纸：`file://` 宿主

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，靠关掉同源策略读同目录文件。
Kabegame 在桌面上照此做：

- **导航属主**：窗口模式的 `WindowWallpaperManager::set_wallpaper_path(path)`（`wallpaper/manager/window.rs`）按
  路径判定：是目录且 `read_project` 读出 `kind == Web`（复用目录内相对路径校验与入口存在校验）时，调用
  `WallpaperWindow::show_web(dir, entry)` 把壁纸窗口的**整个主 frame** 导航到 `file:///…/<file>`；其它路径（图片、
  视频文件、`x-wpe/video` 目录）调用 `show_app()` 导航回应用页，由 Vue 照旧渲染图片 / 视频。目录读 `project.json`
  失败时返回错误、窗口不动。两个方法都幂等：同一入口不重复导航（改样式等重复调用不重新加载页面），本来就在应用页时
  `show_app` 什么都不做。
- **状态属主**：网页壁纸状态全部收在 `WallpaperWindow`（`wallpaper/window.rs`）对象里——应用页 URL（`mount()` 等到
  前端 ready 后读一次 `window.url()`，非 `file:` 才记，dev 是 vite 地址、prod 是内置资源地址，不手拼）、当前网页目录与
  入口、Windows 上 `mount()` 时取的窗口句柄与鼠标转发线程。没有回程地址时 `show_web` 报错、不离开应用页。窗口对象由
  `init()` 建立、`cleanup()` 丢弃，`Drop` 清空文件根目录，转发线程由 `InputForwarder` 的 `Drop` 停止。以后每块屏一个
  `WallpaperWindow` 即可各自持有入口、根目录与转发线程（运行时接口本来就按 label 区分）。
- **触发点**：统一是 `set_wallpaper_path`——按 id 设壁纸、轮播、启动恢复（`init()` 建窗等 ready 挂载之后
  `init_wallpaper_on_startup`，所以开机即网页壁纸也覆盖到）、切换到窗口模式、关闭后重新开启壁纸、改壁纸样式都会走到
  这里。不监听 `setting-change`，也不挂在 `wallpaper_window_ready` 握手上。当前壁纸 id 被清空（例如删除了当前壁纸
  那一行）时不调用它，窗口**保持原页面**，与 Vue 对 `null` 目标保持现有画面（`acceptTarget`）及原生模式一致。
- **并发与锁**：判定与导航在 manager 的 `wallpaper_window` 锁内同步完成（只读一个小的 `project.json`，不 await），
  多个调用天然串行。窗口 getter（`url()` / `hwnd()`）会同步等主线程回执，只在 `mount()`（不持锁）里调用；锁内只调
  投递即返回的 `navigate`，避免持锁等主线程。
- **文件访问只对壁纸窗口开**：建窗前 `tauri_runtime_cef::allow_file_documents("wallpaper")`，该 browser 建窗时
  `extra_info` 带 bool 键 `kabegame.allow_file_access_from_file_urls`，CEF 补丁
  [`0004`](../../third-patches/cef/README.md) 据此只给它打开 `WebPreferences::allow_file_access_from_file_urls`
  （偏好对应用页的 http / tauri 源没有作用，所以一直开着无害）。弹窗路径不带此键。
- **目录拦截**（与 WPE 自己的资源拦截器同规则）：该 browser 的每个 `file:` 请求在 `OnBeforeResourceLoad`
  里经 `file_access::check_file_request` 判定——URL 百分号解码成路径，`symlink_metadata` 必须是普通文件（拒绝
  符号链接 / 目录 / 不存在），目标与根目录 canonicalize 后目标必须严格位于根目录内（Windows 大小写不敏感）；
  当前没有网页壁纸（根目录为空）时一律拒绝。拒绝时 stderr 记 `[cef-runtime] deny file: …`。根目录在导航前由
  `set_file_document_root("wallpaper", Some(dir))` 设置，离开时清空。
- **初始化脚本照常注入，IPC 按远程 `file:` 来源限权**（Phase 5 起；Phase 4 曾对 `file:` 文档跳过所有初始化脚本）：
  - 页面里有 `__TAURI_INTERNALS__`（Tauri 自身脚本只进主 frame，页面自己的嵌套 iframe 拿不到 invoke key），还有
    all-frames 的 WPE 垫片。
  - `file:` 文档的 `Origin` 请求头是 `null`。Phase 4 文档曾写「`cef-ipc` 入口本来也拒绝」，这不成立：Tauri 的
    `ipc://` 主通道解析 `null` 失败后前端改走 `cef-ipc` 回退通道，回退通道拿不到合法 Origin 时退到 webview 初始 URL
    （应用页），请求被当成 `Origin::Local`、拿到 `main-capability` 的全部命令；当时只是没注入 invoke key，缺口没暴露。
  - 现在运行时在协议层统一修正（`tauri-runtime-cef` 的 `protocol::pin_file_frame_origin`）：scheme factory 记下发起请求
    的 frame URL，`file:` frame 的请求把 `Origin` 改写成 frame URL；`cef-ipc` 的来源取值顺序为「`Origin` 头 → frame URL
    → 初始 URL」。两条通道都判成 `Origin::Remote { url: file:///… }`。
  - 对这个来源生效的只有 `capabilities/wpe-web.json` 的 `wpe-web-capability`：`windows: ["wallpaper"]`、
    `remote.urls: ["file:///*"]`、`local: false`（应用页回到壁纸窗口时仍只受 `main-capability` 约束），权限只有
    `core:event:allow-listen` / `allow-unlisten` 与 `permissions/wpe-web.toml` 的 `wpe_web_pull_state`；不给
    `core:default`，页面拿不到窗口、路径、应用信息等核心命令。`main-capability` 是 `local: true`，对远程来源不生效，
    `get_settings` 等应用命令一律被 ACL 拒绝（`Command … not allowed by ACL`）。
- 网页壁纸只在窗口模式出现；导航本身不经过 Vue，切换没有过渡动画（WPE 也是直接切换）；壁纸样式、音量、倍速对
  `file://` 页面不生效。

### 运行时垫片与宿主协议

WPE 网页壁纸要靠宿主提供的一组全局接口完成初始化，最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：
宿主把作者默认值推给它之后，多数壁纸才开始画。Kabegame 用一份 JS 垫片 `webview_js/wpe_shim.js` 定义这组接口并投递属性，
**不照搬 WPE 的「宿主拼 JS、加载完成前排队」**（`API.md` §4.8），改成垫片驱动：垫片向宿主**拉取**完整状态、**订阅**
应用事件后重拉；宿主只回答「当前完整状态」和「转发事件」，不推状态、不排队、不记页面收到过什么。

- **注入与启用**：同一份垫片以 `initialization_script_for_all_frames` 挂在壁纸窗口（`wallpaper/manager/window.rs`）与
  主窗口（`startup.rs`）上，按地址自判：只在「顶层 `file:` 文档」（桌面壁纸窗口）或「父窗口就是 top、地址是本地
  `127.0.0.1` / `localhost` 的 `/wpe/<id>/…`」（图库预览 iframe）里启用，其它文档第一行就返回、不定义任何全局。页面自己的
  嵌套 iframe 不启用。启用后定义 `wallpaperMediaIntegration` 常量、六个 `wallpaperRegister*Listener`（收下回调、Phase 8 前
  不回调）、空的 `wallpaperRequestRandomFileForProperty` 与 `wallpaperGetUtilities`，并标记 `window.__kbWpeShim === true`。
- **状态**（只在 Rust 侧计算，`commands/wpe_web.rs` 的 `build_wpe_web_state`）：`{ imageId, user, general: { language } }`。
  `user` 取自图片 metadata（导入时存的 `project.json` 原文）里 `general.properties` 中带 `value` 的条目，形如
  `{ key: { type, value } }`（`kabegame_core::wpe::properties::resolve_web_user_props`；分组、说明行、无默认值的 `file`
  属性不推）；`language` 是界面语言换成的 WPE 语言码（`wpe_language_code`：`zh-chs` / `zh-cht` / `ja-jp` / `ko-kr`，其余
  `en-us`）。`fps` 留给 Phase 6（推 0 会让按 `1000 / fps` 算间隔的页面停住）。Rust 不带版本号。
- **两个传输原语**，两种宿主各实现一份：

  | | `pull()` → 完整状态 | `listen(names, onEvent)` |
  |---|---|---|
  | 桌面壁纸窗口（主 frame 是 `file://` 入口） | `invoke("wpe_web_pull_state")`：不接收 id，按调用方 webview 的 label 经 `WallpaperManager::web_wallpaper_dir` 找到 manager 里的 `WallpaperWindow`、取它当前的网页目录，再 `Storage::find_image_by_path` 找到那一行；别的 label、停在应用页、非窗口模式都返回 `no web wallpaper`，页面拿不到别的图片的 metadata | 直接 `plugin:event\|listen`（`core:event:allow-listen`） |
  | 图库预览（主窗口里的跨源 HTTP iframe，碰不到 IPC） | `postMessage({ kbWpe: 1, type: "pull", id })` 给宿主页；宿主页（`components/wallpaper/wpeWebBridge.ts`）用主窗口权限调 `get_wpe_web_state(imageId)`，回 `{ type: "state", id, state }` 或带 `error` | `postMessage({ type: "listen", events })` 登记；宿主页的 `useTauriProxy()`（`composables/useTauriProxy.ts`）代为 listen：同名只订阅一次，登记过的事件经 `kbEvent$` 并入一条管道（`mergeMap`），逐条回 `{ type: "event", name, payload }` |

  宿主桥由 `WallpaperStage` 在创建 iframe 时挂上（插入 DOM、设 src 之前），随 iframe 销毁（`teardownWeb` 里 `dispose()`
  退订）；只认 `event.source === iframe.contentWindow` 的消息，只向 iframe 加载时的源回消息。垫片发出的消息只有拉取编号与
  事件名，不含数据。
- **重拉触发**：`setting-change` 带 `language`（界面语言变了）；`image-changed` / `images-change` 里有**本张**图片
  （`state.imageId`）的 `metadataId` 补丁——图片 metadata 按 id 不可变，属性一改就换 `metadataId`（Phase 7 的设置面板保存时
  写新 metadata 行）；首个状态到达前任何 `metadataId` 补丁都重拉。垫片**先订阅再拉取**，订阅生效后的变化都会触发重拉。
- **投递语义**（我们自己的规则）：
  - 首次投递在 `window` 的 `load` 之后，用户属性与通用属性各推一份完整的（先 `applyUserProperties` 再
    `applyGeneralProperties`，WPE 的实际顺序未确认）；`load` 之前到达的状态只记下来。
  - 之后每次重拉都拿到完整状态：用户属性只推**值变化的键**（WPE 的 `applyUserProperties` 本来就是「只含变化的键」，页面
    没有整份替换的接口；作者删掉的键不推，页面没有撤销接口）；通用属性有变化就推一整份。
  - 首次投递之后页面换了 `wallpaperPropertyListener` 对象，下一个微任务把当前完整状态补投给它：垫片在 `window` 上装这个
    属性的访问器，页面写 `window.x = …` 或顶层 `var x = …` 都走到 setter。
  - 乱序：垫片给每次拉取编号，某次结果落地后丢弃编号更早、返回更晚的结果（同 pathql 的 pending 窗口）。
  - 页面回调抛错只记 `console.error("[kb-wpe] …")`，不影响后续投递。
- **导航时清 JS 事件监听**：Tauri 按 webview label 记录 JS 注册的监听，只在 webview 销毁时清理；壁纸窗口在应用页与
  `file://` 入口之间反复导航，旧文档的监听会留在 Rust 侧，之后每个这类事件仍向当前文档 eval 一段投递脚本（网页壁纸因此能
  读到应用页留下的 `setting-change`）。tauri 补丁 [`0011`](../../third-patches/tauri/README.md) 提供
  `WebviewWindow::clear_js_listeners()`，`WallpaperWindow::show_web` / `show_app` 在 `navigate` 投递成功之后调用（导航失败时
  页面没换，不动监听；新文档要加载、执行脚本才会 listen，晚于清理）。页面自己 `location.reload()` 留下的一组垫片监听不额外
  处理；销毁窗口时 Tauri 自己会清。
- **接受的取舍**：`core:event:allow-listen` 没有按事件名的作用域，桌面网页壁纸因此能订阅应用的全部全局事件；预览的宿主
  代办同样不限事件名。这是用户确认过的取舍，也算开放给壁纸的一项能力；命令层只开一个拉取命令。
- **不做**（后续 Phase）：暂停冻结与 `setPaused`、`fps`（Phase 6）；用户改属性的存储与面板、`file` / `directory` 属性
  （Phase 7，保存时发 `metadataId` 补丁，垫片已订阅并重拉）；音频与媒体数据（Phase 8，数据回程沿用 `listen` /
  `useTauriProxy`）；Web 发布版没有初始化脚本能力，预览仍是无属性状态。
- **待真机确认**：all-frames 脚本能否进站点隔离下跨源 iframe 的渲染进程（不成立时改为 `serve_wpe_html` 插
  `<script src>`，桌面不受影响）；`file:` 请求 `Origin` 头的实际值（`null` 或 `file://`，不影响改写）。

### 桌面鼠标转发（Windows）

`wallpaper/input_forward.rs`：照 WPE 的做法不装鼠标钩子，由后台线程每 16ms 轮询 `GetCursorPos` 与
`GetAsyncKeyState(VK_LBUTTON)`，只在「窗口模式 + 当前是网页壁纸」（`WallpaperWindow::show_web` 进入 `file://` 时启动、`show_app` 离开或窗口对象丢弃时停止）运行。

- 光标在壁纸窗口客户区内：`ScreenToClient` 得物理坐标，除以 `GetDpiForWindow / 96` 得视图坐标，坐标变化就经
  `tauri_runtime_cef::inject_mouse` 注入 `Move`（不带按键标志，与 WE 一致：带左键会让页面图片拖动启动 OLE 拖放并挂住 UI 线程）；离开客户区时注入一次 `Leave`。
- 左键按下沿：光标在客户区内，且 `WindowFromPoint` 命中窗口的根窗口（`GetAncestor(GA_ROOT)`）类名是 `Progman` /
  `WorkerW`（桌面图标层或壁纸层本身，即点在桌面空白处或图标上）才注入 `LeftDown`；抬起沿只要按下被转发过就注入
  `LeftUp`，停止转发时也会补发，保证成对。点在别的应用窗口上不转发。
- 不拦截、不吞掉任何输入：Explorer 照常收到点击（桌面图标选中状态会变，与 WPE 一致）。
- 注入走 `CefBrowserHost::SendMouse*Event`，直接进 Chromium 输入管线，不依赖窗口焦点与 Z 序；只投递不等回执。
- 不做：键盘、滚轮、右键、设置开关；macOS / Linux 不转发。

### web 层（`WallpaperStage`）

- 对 `type === "x-wpe/web"` 的目标，在 base / top 双层之上命令式创建一个**跨源 iframe**（`wpeEntryUrl(id)` =
  `http://127.0.0.1:<port>/wpe/<id>/`），与应用前端不同源，拿不到 Tauri 全局与父页面 DOM。
  `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（不给 top-navigation / popups / modals /
  downloads）、`allow="autoplay; fullscreen"`、`referrerpolicy="no-referrer"`。
- **不参与 base / top 双层过渡**：一次只存在一个 iframe。切入时等页面 `load`（8s 无 load 记 `wpe web entry load timeout`，
  不销毁）后整层淡入（none 直接显示；fade / slide / zoom 用与媒体层相同的曲线）盖住媒体层，淡入完成再清空媒体层；
  切走时新媒体先按「首帧直设」放到 base，web 层淡出后 **销毁** iframe（先 `about:blank` 再移除），让渲染进程回收；
  web → web 先淡出销毁旧页面再加载新页面。target 置 null、组件卸载时立即销毁。
- `paused` 对 web 层只做 `visibility: hidden`（省合成，不冻结脚本；冻结留给后续垫片）；`interactive` 决定 iframe 的
  `pointer-events`（桌面窗口不交互）；`styleMode` / `volume` / `playbackRate` 对页面无意义，WPE 视频的 stage 样式也不作用于它。
- `ready` 在 iframe `load` 时发；调试快照 `media` 为 `"web"`。

### 图库接入

- `ImageContent` 新增 `wallpaper` 形态：**非视频** WPE 行（`isWpeWallpaperContentType`：web，以及未来的 scene）在
  `prefer="original"` 时交给 `components/wallpaper/WpeWallpaperContent.vue`（按 id 调 `get_wallpaper_target_for_image`，
  样式 / 过渡 / 音量 / 倍速跟随壁纸设置，渲染 `WallpaperStage`），缩略形态仍是作者 `preview.*`；该形态不构建缩略 / 原图链，
  丢失态只看 `localExists === false` 或目标取不到（页面加载超时不算丢失）。`x-wpe/video` 不走这里，仍是 `<video>` 链。
- 网格（`ImageItem`）对所有 WPE 行固定用缩略形态，不悬停加载原图形态；角标「WPE · 视频」/「WPE · 网页」。
- 预览弹窗对非视频 WPE 行渲染 `components/wallpaper/WallpaperDesktopCanvas.vue`：按主显示器逻辑分辨率
  （`primaryMonitor()` 的 `size / scaleFactor`，失败回退 `window.screen`，模块级缓存）给一块固定尺寸画布，整体
  `scale` 进可用区域并居中，页面按桌面尺寸排版且可交互；右下角角标「桌面预览 · W×H」。不走 Panzoom、不挂
  `VideoControls`，控制条只保留全屏。
- 应用背景层对非视频 WPE 行**退回作者预览静态图**（`prefer="thumbnail"`；没有独立预览图时不显示背景）：背景层应静音、
  不交互、低开销，而第三方页面无法从外部静音、会持续跑脚本。

### IPC 纵深防御

跨源 iframe 里的页面拿不到 Tauri 全局与 invoke key，但 CEF 的 `cef-ipc://` scheme handler 本身不区分 frame。
`tauri-runtime-cef` 的 scheme factory 在 `create(browser, frame, ..)` 时记下 `frame.is_main()`，经 request extension
（`protocol::RequestFrame`）交给 `ipc.rs` 的 `post_message_request`：只接受主 frame，或与该 webview 初始 URL 同源的
子 frame，其余返回 400。畅游窗口的注入脚本跑在主 frame（Origin 是站点源），因此按「主 frame」放行而不是按「应用源」；
CEF 未给出 frame 时维持原行为。`ipc://` 主通道由 Tauri 自己的 handler 承接，不在本防御范围内（仍靠 invoke key）。
`RequestFrame` 同时带 frame URL：`file:` frame 的 `Origin` 在协议层被改写成 frame URL，两条通道都按远程 `file:` 来源走 ACL
（见上「初始化脚本照常注入，IPC 按远程 `file:` 来源限权」）。

**待真机校准**：`fill`（WPE）→ `contain` 的几何、`wec_*` 的 −1…1 与 CSS filter 量纲。

## 七、已知边界

- 只导入 `video` 与 `web`；`scene` / `application` 只占位并计入跳过。
- 网页壁纸只收到作者默认值（`applyUserProperties`）与界面语言（`applyGeneralProperties({ language })`）；用户改属性、
  `fps`、`setPaused`、音频与媒体数据尚未实现（注册函数只收下回调）；`file` / `directory` 类型属性不支持（例如 Slideshow
  显示「未选择目录」）。Web 发布版的预览没有垫片，页面以「无属性」状态运行。
- 桌面网页壁纸能订阅应用的全部全局事件（`core:event:allow-listen` 无事件名作用域，已接受的取舍），应用命令只开
  `wpe_web_pull_state`。
- 桌面 `file://` 页面里跨源 `http(s)` 请求仍受 CORS 约束（WPE 是全局 `--disable-web-security`，Kabegame 不放开）；
  壁纸样式 / 音量 / 倍速对桌面网页壁纸不生效；桌面只转发鼠标移动与左键（Windows），无键盘 / 滚轮 / 右键。
- 图库预览的页面源是本地 HTTP 服务 `http://127.0.0.1:<随机端口>`，端口每次启动变化，`localStorage` / `indexedDB` 不持久
  （Phase 4 改为自定义协议 `kb-wpe` 后稳定）。
- `/wpe` 表外扩展名返回 `application/octet-stream`（WPE 的 `file://` 下 Chromium 会嗅探）；不复刻 WPE 的
  `disable-web-security`，依赖跨域请求的页面受 CORS 约束。
- 应用背景层对网页壁纸退回作者预览静态图。
- `wcc_v` 图像滤镜预设（WPE 浏览属性）未实现，忽略。
- 创意工坊取消订阅后目录消失：行仍在，`local_exists` 为 false，图库标记缺失。
- 虚拟盘、原生壁纸、Plasma 插件模式均看不到 WPE 行（第一阶段）。
- Web 发布版不提供壁纸入口，也不挂 `/wpe` 路由。

## 八、涉及文件

- `src-tauri/kabegame-core/src/wpe/`（discover / recognize / project / properties / scan）
- `src-tauri/kabegame-core/src/crawler/wpe_import.rs`、`plugin/builtin.rs`、`task_scheduler/mod.rs`
- `src-tauri/kabegame-core/src/media/image_type.rs`、`storage/images.rs`、`storage/organize.rs`
- `src-tauri/kabegame/src/http_server.rs`、`commands/wallpaper.rs`、`wallpaper/rotator.rs`、`permissions/main.toml`、
  `tauri.conf.json.handlebars`（CSP `frame-src`）
- `src-tauri/tauri-runtime-cef/src/{protocol.rs,ipc.rs}`（IPC 纵深防御、`file:` frame 的 `Origin` 改写与来源回退顺序）、
  `file_access.rs` / `webview.rs` / `subprocess.rs`（文件文档策略、`file:` 目录拦截、初始化脚本注入、鼠标注入）、
  `third-patches/cef/0004-per-browser-file-access.patch`
- 运行时垫片与宿主协议：`src-tauri/kabegame/src/webview_js/wpe_shim.js`、`commands/wpe_web.rs`（`WpeWebState`、
  `get_wpe_web_state` / `wpe_web_pull_state`、`remote.urls` 匹配单测）、`capabilities/wpe-web.json`、`permissions/wpe-web.toml`、
  `kabegame-core/src/wpe/properties.rs`（`resolve_web_user_props` / `wpe_language_code`）、`wallpaper/manager/{mod.rs,window.rs}`
  （`web_wallpaper_dir`）、`third-patches/tauri/0011-tauri-webview-clear-js-listeners.patch`、
  `apps/kabegame/src/composables/useTauriProxy.ts`、`components/wallpaper/wpeWebBridge.ts`
- 桌面网页壁纸宿主：`src-tauri/kabegame/src/wallpaper/manager/window.rs`（`set_wallpaper_path` 判定、`WALLPAPER_LABEL`）、
  `wallpaper/window.rs`（`WallpaperWindow` 状态、`show_web` / `show_app` / `Drop`）、`wallpaper/input_forward.rs`
- `apps/kabegame/src/components/WallpaperImportDialog.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`、`App.vue`（背景层）、`utils/{mediaMime,fileUrl}.ts`
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、
  `components/wallpaper/{WallpaperStage.vue,types.ts,WpeWallpaperContent.vue,WallpaperDesktopCanvas.vue}`
