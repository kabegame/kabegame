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
| `compatible_path` | 视频行**始终有值**：浏览器能播时就是入口视频本身（`<目录>/<file>` 绝对路径）；解不了的编码在 `compatibles_dir` 生成 H.264 MP4，生成失败也回落到入口视频。**网页行为空**（没有可播放媒体，页面以入口的 `file://` 加载，见第六节） |
| `hash` / `size` / `width` / `height` | 入口文件的哈希、大小；视频行带探测尺寸，网页行宽高为空（页面没有固有尺寸） |
| `post_url` | 有 workshop id 时是创意工坊页面地址 |
| `metadata` | `project.json` 原文（`plugin_id = wpe-import`），供详情展示 |

**不复制、不转码、不写用户目录**。`local_path` 的唯一约束天然保证同一壁纸只入库一次；
取消订阅、壁纸更新只影响磁盘上那一个目录，Kabegame 不持有副本。从图库删除只删记录，
`x-wpe/*` 行的 `local_path` 永远不进源文件回收（`batch_delete_images` 按 type 分流）。

`type` 以 `x-wpe/` 开头即表示「目录型壁纸」。凡把 `local_path` 当文件用的地方都必须按类型
分流，不能按扩展名猜：

- `/file/{*path}` 对 `x-wpe/*` 行返回 404；
- 视频播放（预览大图、应用背景、壁纸窗口）一律走 `compatible_path` → `/compatible/{*path}`；
- 网页壁纸以入口的 `file://` 直接加载（桌面壁纸窗口整窗导航，图库预览是主窗口里的 `file:` iframe，见第五、六节），
  页面能读的文件边界是运行时按壁纸目录做的 `file:` 请求拦截；没有 HTTP 目录服务；
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

**WPE 壁纸目前只提供 Windows 桌面**（第二阶段已确认决策 11）：自动发现（`platform_supported()` 只对 Windows 为
true）、桌面 `file://` 宿主、图库预览的 `file:` iframe 都按 `target_os = "windows"` 门控；macOS / Linux / Android / Web
不自动发现、不渲染网页壁纸，`x-wpe/*` 行在网格与应用背景里只显示作者预览图。`kabegame-core::wpe` 的入库模型、
`read_project`、属性解析保持跨平台编译（CLI / 测试用）。

`kabegame_core::wpe`：

- `discover.rs`：Windows 读 `HKCU\Software\Valve\Steam\SteamPath`，再解析
  `<Steam>/steamapps/libraryfolders.vdf`。只在含 app `431960` 的库里产出三类根：
  - 创意工坊：`<库>/steamapps/workshop/content/431960`
  - 官方默认：`<库>/steamapps/common/wallpaper_engine/projects/defaultprojects`
  - 我的项目：`<库>/steamapps/common/wallpaper_engine/projects/myprojects`
  Linux 的 Steam 路径探测（`~/.steam/steam`、`~/.steam/root`、`~/.local/share/Steam`）代码保留，但
  `platform_supported()` 为 false，`discover_roots` 不再进入；Linux / macOS / Android / Web 返回空。
  VDF 用最小手写解析器（兼容新旧两种 `libraryfolders` 格式），不引新依赖。
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

「开始收集」菜单新增第四项 **壁纸**（桌面端；Web / Android 隐藏；macOS / Linux 入口仍在，但 `platform_supported` 为 false，
自动发现为空，只剩「添加文件夹」）。对话框 `WallpaperImportDialog`
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

## 五、媒体与页面的访问路径（无 HTTP 目录服务）

- **视频**：统一走 `compatible_path`。Phase 6b 起桌面 CEF 直接以 `file://` 播放它（见第六节「图库媒体：`file://` 与按发起
  frame 分档的闸门」），Android 等仍经 `/compatible` 按库里的 `compatible_path` 授权、直出文件、无跳转。第一阶段曾有
  `/wpe/<id>/` 目录服务，CEF 的 `<video>` 跟随它的 307 后报 `MEDIA_ELEMENT_ERROR: Format error`（直接请求入口文件可正常
  播放，2026-10-25 真机 4K H.264 实测），所以视频从没用过它。
- **网页**：桌面壁纸窗口与图库预览都以入口的 `file://` 加载（第六节「桌面网页壁纸：`file://` 宿主」「图库预览：`file:`
  iframe」），页面相对资源自然落在壁纸目录里；文件边界是 `tauri-runtime-cef` 按调用方 webview 当前根目录做的 `file:`
  请求拦截，两种宿主同一份机制。MIME 由 Chromium 按扩展名判定；`file:` 不走 HTTP 缓存，壁纸目录里的文件原地变化
  （创意工坊更新、作者或用户手改）后重新加载即读到新内容。
- **`/wpe/<id>/<rel>` HTTP 目录服务已在第二阶段 Phase 6a 删除**（连同 `/wpe` 专属网页 MIME 表、HTML 产出点与 CSP
  `frame-src` 对 `http://127.0.0.1:*` 的放行）：Web 发布版不提供网页壁纸，应用 Web 服务器（MCP / 外部集成）也不需要把
  壁纸目录暴露出去，预览改走 `file:` 后它没有使用方。Android / Web 的媒体与插件文件 HTTP 路由照旧
  （Phase 6b 起桌面图库显示改走 `file://`，这三个媒体路由在桌面只剩下载 / 复制兜底等非显示用途；Windows 拖出自
  Phase 6d 起改走 CEF 补丁 0003 的真实文件链路，不再用媒体 URL，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`）。
- 作者脚本常用 javascript-obfuscator 的 `selfDefending`：对函数 `toString()` 做正则比对，代码被格式化（换行 / 缩进）
  就故意进入死循环，页面 `load` 永不触发。任何改写作者 js 的逻辑（zcompat 替换）都不能改变被检测函数的原文；同一
  `file:` 源的页面可能共用一个渲染进程，一个卡死的页面会连带后续网页壁纸一起超时。

早期导入的行 `compatible_path` 可能为空；对同一来源重跑导入任务时，已入库行会补齐该字段并发
`compatiblePath` 字段补丁（dry-run 不写）。兼容文件删除护栏只删 `compatibles_dir` 内的文件，
指向用户目录的入口视频永远不会被删除或在整理时重建。

## 六、壁纸窗口

壁纸窗口与主窗口加载同一个 `index.html`，URL 为 `index.html?window=wallpaper`（`wallpaper/manager/window.rs`）。
`main.ts` 只做分发：按 `windowKind.ts` 的 `WINDOW_KIND` 动态导入 `bootstrap/app.ts`（主界面，原 `main.ts` 全部内容）
或 `bootstrap/wallpaper.ts`（只装 pinia、i18n、UnoCSS 与主题变量，不装 router / 组件库 / vant，不 `loadAll` 设置）。
Web 发布版与 Android 硬门控为主窗口。

- `views/WallpaperWindow.vue`：壁纸窗口根，负责 init 看门狗（`sessionStorage.wallpaperInitRetry` + reload）、挂载即监听并按 label 应答 `wallpaper-ping`、`setting-change`
  监听、启动时五个 getter 并行、`wallpaper_window_ready` 握手与 dev 调试面板，结果作为 props 交给渲染组件。
- `components/wallpaper/WallpaperStage.vue`：纯渲染组件（不 invoke / listen / 读 store；唯一例外是 web 层 iframe 的宿主侧
  `wpeWebBridge.ts`：建 iframe 前 `set_wpe_web_preview` 设预览根目录、销毁时清空，宿主桥代为拉取与 listen，见「图库预览：
  `file:` iframe」「运行时垫片与宿主协议」），base / top 双层、
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

- `x-wpe/web`：`compatiblePath` 与 `wpeVideo` 为空，目标里不带入口：入口的 `file://` 一律由 Rust 用
  `wallpaper::web_entry` 现算（`read_project` 校验入口在目录内且存在，非 Windows 恒为 `None`）。
  **桌面壁纸窗口**不渲染它（`WallpaperWindow.vue` 的 `acceptTarget` 直接忽略），由 Rust 把整个窗口导航到入口的 `file://`
  （见下「桌面网页壁纸：`file://` 宿主」）；图库预览由 `WallpaperStage` 的独立 **web 层**建一个 iframe，
  `set_wpe_web_preview` 设好根目录后返回入口、前端赋 `src`（见下「图库预览：`file:` iframe」）。

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

### 桌面网页壁纸：`file://` 宿主

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，靠关掉同源策略读同目录文件。
Kabegame 在桌面上照此做：

- **导航属主**：窗口模式的 `WindowWallpaperManager::set_wallpaper_path(path)`（`wallpaper/manager/window.rs`）按
  路径判定（`wallpaper::web_entry`，与图库预览的 `set_wpe_web_preview` 共用；非 Windows 恒为 `None`，网页壁纸停在应用页）：
  是目录且 `read_project` 读出 `kind == Web`（复用目录内相对路径校验与入口存在校验）时，调用
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
- **文件访问按窗口开**（Windows）：建窗前 `tauri_runtime_cef::allow_file_documents("wallpaper")`（主窗口同样登记
  `"main"`，供图库预览，见下「图库预览：`file:` iframe」；两个窗口另在三个桌面平台登记补丁 0005 的
  `allow_app_local_resources`，供应用页显示图库媒体，见下「图库媒体：`file://` 与按发起 frame 分档的闸门」），该 browser 建窗时 `extra_info` 带 bool 键
  `kabegame.allow_file_access_from_file_urls`，CEF 补丁 [`0004`](../../third-patches/cef/README.md) 据此只给登记过的
  browser 打开 `WebPreferences::allow_file_access_from_file_urls`（偏好对应用页的 http / tauri 源没有作用，所以一直开着
  无害）。弹窗路径不带此键；非 Windows 两处都不登记。
- **目录拦截**（与 WPE 自己的资源拦截器同规则）：壁纸页是 `file:` 文档，它的每个 `file:` 请求（含整窗导航）都落在闸门档
  （见下「图库媒体」的分档表），在 `OnBeforeResourceLoad` 里经 `file_access::check_file_request` 判定——URL 百分号解码成路径，`symlink_metadata` 必须是普通文件（拒绝
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
    `remote.urls: ["file:///*"]`、`local: false`（应用页回到壁纸窗口时由特赦与 `main-capability` 管），权限只有
    带事件名作用域的 `core:event:allow-listen`（`wallpaper-ping` / `setting-change` / `image-changed` / `images-change`）、
    `allow-unlisten` 与 `permissions/wpe-web.toml` 的 `wpe_web_pull_state`、`wallpaper_pong`；不给 `core:default`，页面拿不到
    窗口、路径、应用信息等核心命令。`main-capability` 是 `local: true`，壁纸窗口的特赦（`acl_exempt_webview("wallpaper")`）
    也只认本地来源，对远程 `file:` 都不生效，`get_settings` 等应用命令一律被 ACL 拒绝（`Command … not allowed by ACL`）。
    `frames` 省略即 `main`：网页壁纸里再嵌的 `file:` iframe 一项权限也没有（见 [ACL 文档](../tauri/TAURI_ACL_PERMISSION_SYSTEM.md)）。
- 网页壁纸只在窗口模式出现；导航本身不经过 Vue，切换没有过渡动画（WPE 也是直接切换）；壁纸样式、音量、倍速对
  `file://` 页面不生效。

### ping 看门狗

`wallpaper/ping.rs` 的 `Pinger` 随 `WallpaperWindow` 持有，在 `mount()` 挂载、显示完成后启动；丢弃对象时
reset 通道关闭，任务退出。后端用 sleep 循环每 10s 探测，页面收到事件才应答、不自己计时：窗口被遮挡变成 hidden
时页面定时器会被 Chromium 节流，页面心跳容易误报。sleep 不补发错过的 tick，系统睡眠唤醒后最多多算一次未应答。

往返使用两个全局事件种类：默认种类 `wallpaper-ping { label, seq }` 经 `GlobalEmitter` 广播、主事件循环 `app.emit`
送到窗口；应用页 `WallpaperWindow.vue` 与桌面网页壁纸垫片都 `listen`，只应答 label 等于自己窗口的事件，再调用
`wallpaper_pong(seq)`。命令从调用方 webview 取 label，页面不能替其它窗口应答；`wallpaper-pong { label, seq }`
是 opt-in，默认不转发给窗口、SSE 或「订阅全部」的 IPC 客户端，只有显式订阅它的后端看门狗接收。

连续 3 次未应答就 `reload()` 当前文档（应用页或 `file://` 入口，约 30~40s）。若重载后仍未收到一次有效应答，
下次判死所需次数翻倍：3 → 6 → 12……，上限 60（约 10 分钟）；有效应答会清零连续未应答次数并把阈值恢复为 3。
`show_web` / `show_app` 导航成功后调用 `reset()`，导航失败不重置；看门狗重载后也像导航一样 `clear_js_listeners()`
（旧文档的 `wallpaper-ping` 等监听随重载作废，Tauri 不会自己清），并在状态机内做同样的重置：
`floor = seq`、清空等待与未应答次数，只接收序号大于 floor 的应答，避免旧文档的迟到应答影响新文档。序号持续递增，
导航重置保留当前退避阈值，直到收到有效应答。

应用页挂载即应答，不等 init 完成。ping 检查事件投递、JS 主线程与回程 IPC 是否存活；原有 init 看门狗继续检查初始化
是否跑通。CEF hang monitor 主要依赖输入事件回执，壁纸窗口几乎没有输入，由 ping 主动发起恢复。JS 卡死后 reload
能否触发 Chromium commit timeout、进入现有 terminate + reload 链路仍需真机验证：重载后 60s 内既无 renderer
unresponsive 也无恢复应答时，应报告并另补重建窗口兜底，不能用加大次数掩盖。

代价是窗口模式期间默认流每 10s 多一条 `wallpaper-ping`，其它窗口、桌面应用 Web 服务器的 SSE 与「订阅全部」的 IPC
客户端也可见（只有 label 与 seq）；订阅方可忽略。`wallpaper-pong` 不进入这些默认流。

### 图库预览：`file:` iframe

第二阶段 Phase 6a 起，图库预览也搬到桌面的 `file:` 文档模型上（此前是本地 HTTP 源的 `/wpe/<id>/` 跨源 iframe）。
起因是 `file` / `directory` 属性：HTTP 页面引用 `file:///…` 在渲染进程的 `SecurityOrigin::CanDisplay` 就被拦下，请求从不
发出，浏览器进程里没有任何钩子；改成 `file:` 文档后，两种宿主的本地文件边界完全一样，以后的追加放行只写一份。

- **主窗口登记两项能力**：`startup.rs` 的 `create_main_window` 建窗前
  `tauri_runtime_cef::allow_file_documents("main")`（补丁 0004，只 Windows）与 `allow_app_local_resources("main")`
  （补丁 0005，Phase 6b 起三个桌面平台都登记，同时供图库媒体走 `file://`）。
  0004 的偏好只影响 `file:` 源的文档（应用页是 `http://localhost:1420` / `tauri`，不受影响）；应用页另有 0005，只放开
  `CanDisplay` 与导航（能给 iframe 赋 `file:` 的 `src`），不放开 fetch / XHR（`CanRequest` 不变，应用页自己
  在当时 `fetch('file:…')` 仍失败，Phase 6c 已放开）。两项能力并在运行时同一张 label 表（`file_access::FilePolicy`），登记任一项都开闸门：主窗口里
  子 frame 的 `file:` 导航与 `file:` 文档的请求都经运行时的 `FileDocumentGuardHandler`，根目录为 `None` 时一律拒绝，所以不打开
  预览时 iframe 碰不到任何本地文件；应用页主 frame 自己的子资源（图库媒体）免检，见下「图库媒体」。
  `allow_universal_access_from_file_urls` 仍关闭，`file:` iframe 碰不到父页面 DOM。
- **应用页直接赋 `src`，靠 CEF 补丁 0005**：应用页是 `http://localhost:1420` / `tauri` 源，Chromium 有两道互相独立的关
  拦住它嵌 `file:`——渲染进程 Blink 的 `SecurityOrigin::CanDisplay(file:)` 对非本地源返回 false（控制台
  `Not allowed to load local resource`，iframe 停在 `about:blank`）；浏览器进程 `RenderFrameHostImpl::BeginNavigation` 的
  `FilterURL` 对没有 `file` 请求权的进程把 URL 改写成 `about:blank#blocked`。补丁
  [`0005`](../../third-patches/cef/README.md) 按建窗 `extra_info` 的 bool 键 `kabegame.allow_local_resources` 在两道关各开
  一道门：渲染侧 `CefRenderFrameObserver::DidCommitProvisionalLoad` 在**最外层主 frame 每次提交非 `file:` 文档**时调
  `blink_glue::GrantLoadLocalResources`（即 `SecurityOrigin::GrantLoadLocalResources`；Blink 每次提交都新建 origin，授权
  跟文档走）；浏览器侧 `CefBrowserInfo::MaybeCreateFrame` 给最外层主 frame 的 RFH 所在进程
  `ChildProcessSecurityPolicy::GrantRequestScheme(file)`（只给请求权、幂等、无 revoke，覆盖 speculative RFH、换进程与崩溃
  重建）。弹窗提交的任何文档、DevTools（会复制 opener 的 `extra_info`，两侧都判 `is_popup`）、OOPIF、fenced frame 一律不授。
  两种继承是 Blink 自身规则、不是补丁给的：同源别名的 `about:blank` / `srcdoc` 子 frame 与父文档共用 origin 对象；弹窗的
  **初始** `about:blank` 空文档从 opener 继承 `CanLoadLocalResources`（`DocumentLoader::CalculateOrigin` 的沙箱 about:blank
  分支）——真机已证实应用页 `window.open("about:blank")` 开出的弹窗在提交真实文档之前能嵌 `file:` iframe，导航到应用页后
  即报 `Not allowed to load local resource`。两者都不超出应用页自身的能力（它们本就能经 `parent` / `opener` 触及应用页），
  弹窗沿用主窗口的 `CefClient`，运行时闸门照样按根目录拦截；WPE iframe 的 sandbox 没有 `allow-popups`，开不了弹窗。
  补丁**只开门**：子 frame 的 `file:` 请求仍由运行时闸门按根目录裁决。`<img src=file:>` 能过 `CanDisplay`，但只有 0005 时
  非 `file:` 文档没有 file URLLoaderFactory，仍失败（`ERR_UNKNOWN_URL_SCHEME`）；Phase 6b 的补丁 0006 补上了它，见下「图库媒体」。
  > 历史：6a 实施后曾由运行时从浏览器进程对命名子 frame 调 `CefFrame::LoadURL` 绕开 `CanDisplay`。它走的是渲染端
  > 无发起文档的 `StartNavigation`，真机上渲染进程被杀（推断为 `VerifyBeginNavigationCommonParams` 判 bad message），
  > 再被 `on_render_process_terminated` 的无条件 `reload()` 放大成整窗刷新循环。该绕行、命名 frame 与 3s 补发已删除
  > （经过见 `.claude/plans/wpe-import/2-web/phase-6a-file-preview.md` 实施记录），不要再从后端导航子 frame。
- **根目录由预览组件经命令设置，命令返回入口**：`set_wpe_web_preview(imageId | null)`（`commands/wpe_web.rs`，主窗口应用页
  免 ACL 直接调用，**不**进 `wpe-web.toml`）。按调用方 webview 的 label 生效，拒绝壁纸窗口（壁纸窗口的应用页同样免 ACL，
  那里的根目录由 `WallpaperWindow` 随导航管理）；`Some(id)` 要求行是 `x-wpe/web`，目录与入口
  都取 `wallpaper::web_entry`（规范化目录 + 目录内入口，入口一定落在根内，`project.json` 读取放 blocking 线程），先
  `set_file_document_root` 再返回入口的 `file://` 字符串（`Some(id)` → `Some(入口)`，命令本身不导航）；`None` 只清空
  根目录、返回 `null`；非 Windows 直接报错。
- **前端时序**（`WallpaperStage`）：`createWebFrame` 建 iframe、挂宿主桥、插入 DOM，**之后**
  `const entry = await setWpeWebPreview(imageId)`；失败或没拿到入口则 `teardownWeb` 并抛「无法加载网页壁纸」（非 Windows、
  Web 版、Android 都走这条，`ImageContent` 退回作者预览图）；成功则 `frame.src = entry`（先插入再赋 `src`，插入时初始空
  文档的 load 被忽略）。`load` 时 `isInitialBlank`（仍可读且是 `about:blank`）的初始空文档忽略；仍可读却不是初始文档
  （例如浏览器侧缺授权时改写出的 `about:blank#blocked`）记 `wpe web entry blocked: <href>`；读 `location` 抛错（已是跨源
  `file:` 页面）才算加载完成。8s 超时仍停在初始 `about:blank` 记 `wpe web entry not navigated (CEF patch 0005 missing?)`
  （导航根本没启动，多半是 CEF 没带 0005，控制台同时有 `Not allowed to load local resource`），否则记
  `wpe web entry load timeout`。
  `teardownWeb` 移除 iframe 后 `void setWpeWebPreview(null)`（不等待，卸载途中仍在发的请求被拒是预期；组件没设过根目录
  时不发命令，所以壁纸窗口与普通媒体不会调用它）。`setWpeWebPreview`（`wpeWebBridge.ts`）把同一窗口的设置 / 清空排成
  串行链：设置要读库与 `project.json`，比清空慢，并发时可能后发先至、把根目录留在已撤下的壁纸上。web → web 时先
  `teardownWeb`（清根）再 `createWebFrame`（设新根、赋 `src`），旧壁纸目录的请求在新预览里被拒。
- **CSP**：`tauri.conf.json.handlebars` 的 `frame-src 'self' blob: data: about: file:`（Phase 6a 删除了为 `/wpe` 加的
  `http://127.0.0.1:*`；生成的 `tauri.conf.json` 被 gitignore，改模板后需重新生成或手动同步）。
- **IPC 三道闸门与 scheme 无关**：Tauri 自身脚本与 invoke key 只注入主 frame（`subprocess.rs` 的 `for_main_frame_only`）；
  `cef-ipc` 拒收与初始 URL 不同源的子 frame；即便到了 ACL，`file:` 来源只匹配绑定在 `wallpaper` 窗口的
  `wpe-web-capability`，在 `main` 里零授权。iframe 能做的仍只有向宿主页 `postMessage` 发 `pull` / `listen`。

| | 桌面壁纸窗口 | 图库预览 |
|---|---|---|
| 页面加载 | 壁纸窗口主 frame 整窗导航到入口 `file://`（`set_wallpaper_path` → `show_web`），切走导航回应用页 | 主窗口应用页里的 sandbox `file:` iframe：`set_wpe_web_preview` 设好根目录后返回入口，前端赋 `src` |
| 文件访问 | 建窗前 `allow_file_documents("wallpaper")`，补丁 0004 只给该 browser 开偏好（另登记 0005，只为应用页显示图库媒体） | 建窗前 `allow_file_documents("main")`（同一补丁 0004、同一偏好，iframe 里的 `file:` 文档读同目录）+ `allow_app_local_resources("main")`（补丁 0005，应用页可加载 `file:` iframe） |
| 根目录 | `WallpaperWindow::show_web` / `show_app` / `Drop` 设置 / 清空 | `set_wpe_web_preview` 在预览挂载 / 卸载时设置 / 清空 |
| 越界拦截 | 运行时 `check_file_request`，按 `wallpaper` 的根目录（`file:` 文档档） | 同一函数，按 `main` 的根目录（子 frame 导航与 `file:` 文档档；应用页主 frame 子资源免检） |
| 垫片传输 | 主 frame 有 Tauri 脚本：直接 `invoke` / `listen`（`wpe-web-capability`） | 碰不到 IPC：`postMessage` 由宿主页代办（`wpeWebBridge.ts`） |
| `localStorage` 源 | `file://`，跨重启稳定 | 同一个 `file://` 源，但 Chromium 按顶层站点分区存储（顶层是 `localhost:1420`），与桌面**不互通**，各自跨重启稳定 |
| 平台 | 只 Windows（`web_entry` 在其它平台恒为 `None`） | 只 Windows（其它平台 `set_wpe_web_preview` 报错，退回预览图） |

### 图库媒体：`file://` 与按发起 frame 分档的闸门

第二阶段 Phase 6b 起，桌面 CEF 的图库媒体（原图、缩略图、兼容副本，包括 WPE 视频行位于创意工坊目录里的 `compatible_path`）
不再经本地 HTTP：前端直接把 `file:///…` 交给 `<img>` / `<video>` / CSS `url()`，由 Chromium 的 `FileURLLoader` 读文件
（原生 Range、不经 TCP、不整块读进内存）。Android 与 Web 不变。

- **CEF 补丁 0006**：0005 只放过 `CanDisplay` 与导航；content 只给 `file:` 前驱文档塞 `file:` 子资源工厂
  （`RenderFrameHostImpl::CommitNavigation`），所以只有 0005 时应用页的 `<img src="file:…">` 请求发得出去、却以
  `ERR_UNKNOWN_URL_SCHEME` 失败。补丁 [`0006`](../../third-patches/cef/README.md) 覆写
  `ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories`（先调父类），按同一键
  `kabegame.allow_local_resources` 给非弹窗 browser 的最外层主 frame 加 `content::CreateFileURLLoaderFactory`。工厂照常经
  `WillCreateURLLoaderFactory` 包成 CEF 的代理工厂，每个请求仍到 `OnBeforeResourceLoad`。Phase 6c 给每个工厂实例创建只允许该文档 origin 读 `file:` 的私有 CORS 列表；运行时还调用 `CefAddCrossOriginWhitelistEntry(origin, "file", "", true)` 通过 CEF proxy 的跨源闸门，profile 的共享列表不变。
- **登记**：`allow_app_local_resources` 给主窗口（`startup.rs`，三个桌面平台）与壁纸窗口（`wallpaper/manager/window.rs`，
  它的 Vue 页同样显示图片 / 视频；窗口壁纸模式只有 Windows / macOS）登记；`allow_file_documents`（0004）仍只 Windows、只为 WPE。
- **运行时按发起 frame 分档**（`tauri-runtime-cef` 的 `resource_request_handler`；登记了任一能力的 label 的 `file:` 请求才进入分档）：

  | 发起方 | 判定 | 处理 |
  | --- | --- | --- |
  | 应用页主 frame 的子资源（图库媒体） | 非导航、`frame.is_main()`；`request_initiator` 非空、非 `null`，且它与 `frame.url()` 都不是 `file:` | label 登记了 0005 即**免检**（`file_access::app_page_open`） |
  | 子 frame 导航到 `file:`（预览 iframe 赋 `src`） | 导航、非主 frame（发起方为 `null`） | 按该 label 的根目录 |
  | `file:` 文档自己的子资源（WPE 页 fetch 同目录、嵌套 `keyframes.html`；壁纸窗口整窗 `file:` 时的主 frame） | frame 文档或发起方 origin 是 `file:` | 按根目录（与 6a 相同） |
  | 主 frame 导航到 `file:` | 导航、主 frame | 按根目录（壁纸窗口由 Rust 导航；主窗口不会发生） |

  不按 frame id 建表：WPE iframe 从 `about:blank` 导航到 `file:` 时换进程、换 RenderFrameHost，frame identifier 随之变化，
  而 frame 自己的文档 origin 就说明了它属于哪一档。`request_initiator` 是建工厂时钉死的文档 origin（主 frame 子资源 = 应用页
  origin，`file:` 文档 = `file://`，子 frame 导航 = `null`），比 `CefFrame::GetURL()` 的缓存可靠，两者任一是 `file:` 就走闸门；
  新建 OOPIF 时 `frame.url()` 为空，但那时 `is_main()` 为 false，仍走闸门。壁纸窗口切到网页壁纸后主 frame 的发起方变成
  `file://`，自动落到闸门档；切回应用页后图库媒体又免检。
- **主 frame 边界**：应用页主 frame 的 `file:` 子资源免检，`fetch(file:)` / XHR 可取得字节；生产 CSP `connect-src file:` 明确允许。子 frame 导航和 `file:` 文档仍按当前根目录拦截。插件详情 EJS iframe 为 opaque origin，内层 CSP 禁止读取 IPC 与本地文件。
- **前端**：桌面 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 都返回 `file://`；复制兜底直接 `fetch(file:)`。Windows 拖出曾写当前媒体元素 `file://` 的 `DownloadURL`，已由 Phase 6d 取代：三个桌面平台都只写 image id、走 CEF 补丁 0003 的真实文件链路（Windows 为 `CF_HDROP`，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`），Web 版保留 `DownloadURL`。插件文件改由 Tauri `read_plugin_file` 命令返回原始字节，图片缓存为 `blob:` URL。Android / Web 的 HTTP 文件路由、桌面可选应用 Web 服务器的 `file_routes_media()` 保留；桌面启动时不再开启本地 HTTP 文件服务。

### 运行时垫片与宿主协议

WPE 网页壁纸要靠宿主提供的一组全局接口完成初始化，最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：
宿主把作者默认值推给它之后，多数壁纸才开始画。Kabegame 用一份 JS 垫片 `webview_js/wpe_shim.js` 定义这组接口并投递属性，
**不照搬 WPE 的「宿主拼 JS、加载完成前排队」**（`API.md` §4.8），改成垫片驱动：垫片向宿主**拉取**完整状态、**订阅**
应用事件后重拉；宿主只回答「当前完整状态」和「转发事件」，不推状态、不排队、不记页面收到过什么。

- **注入与启用**：同一份垫片以 `initialization_script_for_all_frames` 挂在壁纸窗口（`wallpaper/manager/window.rs`）与
  主窗口（`startup.rs`）上，按地址自判：只在「顶层 `file:` 文档」（桌面壁纸窗口）或「父窗口就是 top 的 `file:` 子 frame」
  （图库预览 iframe）里启用，其它文档第一行就返回、不定义任何全局。预览里壁纸自己更深的嵌套 iframe 不启用。启用后定义 `wallpaperMediaIntegration` 常量、六个 `wallpaperRegister*Listener`（收下回调、Phase 8 前
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
  | 图库预览（主窗口里的 `file:` iframe，碰不到 IPC） | `postMessage({ kbWpe: 1, type: "pull", id })` 给宿主页；宿主页（`components/wallpaper/wpeWebBridge.ts`）用主窗口权限调 `get_wpe_web_state(imageId)`，回 `{ type: "state", id, state }` 或带 `error` | `postMessage({ type: "listen", events })` 登记；宿主页的 `useTauriProxy()`（`composables/useTauriProxy.ts`）代为 listen：同名只订阅一次，登记过的事件经 `kbEvent$` 并入一条管道（`mergeMap`），逐条回 `{ type: "event", name, payload }` |

  宿主桥由 `WallpaperStage` 在创建 iframe 时挂上（插入 DOM、请求导航之前），随 iframe 销毁（`teardownWeb` 里 `dispose()`
  退订）；只认 `event.source === iframe.contentWindow` 的消息，回消息的目标源用 `"*"`（`file:` 源在 `postMessage` 的目标
  匹配上不可靠；发出的只有本张壁纸的状态与转发的事件）。垫片发出的消息只有拉取编号与事件名，不含数据。
- **ping 应答**：仅桌面 `file://` 主 frame 监听 `wallpaper-ping`，从
  `__TAURI_INTERNALS__.metadata.currentWebview.label` 取自身 label、过滤后调用 `wallpaper_pong(seq)`；不等 load 或属性
  拉取成功。预览 iframe 不参与。`wpe-web` 除 `wpe_web_pull_state` 外的第二个命令就是 `wallpaper_pong`，只替调用方窗口
  发应答，不读取数据。Windows 真机仍需确认 metadata 中的 label 有值。
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
- **可见事件**：桌面网页壁纸只能监听 `wpe-web.json` 作用域里的四个事件（`wallpaper-ping`、`setting-change`、`image-changed`、
  `images-change`，tauri 补丁 0015），其它事件名 `listen` 被 ACL 拒绝；垫片新增监听要同步改 capability。预览的宿主代办
  （`wpeWebBridge.ts`）只接受白名单 `setting-change` / `image-changed` / `images-change`——主窗口免 ACL，宿主自己的 listen
  不受作用域限制，白名单是预览 iframe 唯一的闸门。命令层只开拉取状态与 ping 应答两个命令。
- **不做**（后续 Phase）：暂停冻结与 `setPaused`、`fps`（Phase 6）；用户改属性的存储与面板、`file` / `directory` 属性
  （Phase 7，保存时发 `metadataId` 补丁，垫片已订阅并重拉）；音频与媒体数据（Phase 8，数据回程沿用 `listen` /
  `useTauriProxy`）；Web 发布版 / Android / macOS / Linux 不渲染网页壁纸。
- **待真机确认**：Phase 5 已在 HTTP 跨源 iframe 里确认 all-frames 垫片能注入；Phase 6a 改成 `file:` iframe 后需要重测
  （注入、`postMessage` 往返、`load` 时机）；`file:` 请求 `Origin` 头的实际值（`null` 或 `file://`，不影响改写）。
  补丁 0005 下应用页赋 `file:` `src` 的整条链路（两侧授权、闸门裁决、稳定性）待用户重编 CEF 后真机验证，用例见
  `versions/latest/regression.md`「CEF 补丁 0005：应用页加载本地资源」。

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

- 对 `type === "x-wpe/web"` 的目标，在 base / top 双层之上命令式创建一个 **`file:` iframe**（插入后
  `await setWpeWebPreview(id)` 开根目录并取回入口，再赋 `src`，见上「图库预览：`file:` iframe」），
  与应用前端不同源，拿不到 Tauri 全局与父页面 DOM。命令失败（非 Windows 等）时销毁 iframe、报「无法加载网页壁纸」。
  `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（不给 top-navigation / popups / modals /
  downloads）、`allow="autoplay; fullscreen"`、`referrerpolicy="no-referrer"`。
- **不参与 base / top 双层过渡**：一次只存在一个 iframe。切入时等页面 `load`（8s 无 load 记 `wpe web entry load timeout`，
  仍停在初始 `about:blank` 时记 `wpe web entry not navigated (CEF patch 0005 missing?)`，都不销毁）后整层淡入（none 直接显示；fade / slide / zoom 用与媒体层相同的曲线）盖住媒体层，淡入完成再清空媒体层；
  切走时新媒体先按「首帧直设」放到 base，web 层淡出后 **销毁** iframe（先 `about:blank` 再移除），让渲染进程回收；
  web → web 先淡出销毁旧页面再加载新页面。target 置 null、组件卸载时立即销毁；销毁即清空预览根目录。
- `paused` 对 web 层只做 `visibility: hidden`（省合成，不冻结脚本；冻结留给后续垫片）；`interactive` 决定 iframe 的
  `pointer-events`（桌面窗口不交互）；`styleMode` / `volume` / `playbackRate` 对页面无意义，WPE 视频的 stage 样式也不作用于它。
- `ready` 在 iframe `load` 时发；调试快照 `media` 为 `"web"`。

### 图库接入

- `ImageContent` 新增 `wallpaper` 形态：**非视频** WPE 行（`isWpeWallpaperContentType`：web，以及未来的 scene）在
  `prefer="original"` 时交给 `components/wallpaper/WpeWallpaperContent.vue`（按 id 调 `get_wallpaper_target_for_image`，
  样式 / 过渡 / 音量 / 倍速跟随壁纸设置，渲染 `WallpaperStage`），缩略形态仍是作者 `preview.*`；该形态不构建缩略 / 原图链，
  丢失态只看 `localExists === false` 或目标取不到（页面加载超时不算丢失）。`x-wpe/video` 不走这里，仍是 `<video>` 链。
  非 Windows 上 `set_wpe_web_preview` 报错：`WallpaperStage` 报非致命错误，`ImageContent` 只结束加载态，原图形态的画布留空
  （网格与应用背景本来就用作者预览图）。
- 网格（`ImageItem`）对所有 WPE 行固定用缩略形态，不悬停加载原图形态；角标「WPE · 视频」/「WPE · 网页」。
- 预览弹窗对非视频 WPE 行渲染 `components/wallpaper/WallpaperDesktopCanvas.vue`：按主显示器逻辑分辨率
  （`primaryMonitor()` 的 `size / scaleFactor`，失败回退 `window.screen`，模块级缓存）给一块固定尺寸画布，整体
  `scale` 进可用区域并居中，页面按桌面尺寸排版且可交互；右下角角标「桌面预览 · W×H」。不走 Panzoom、不挂
  `VideoControls`，控制条只保留全屏。
- 应用背景层对非视频 WPE 行**退回作者预览静态图**（`prefer="thumbnail"`；没有独立预览图时不显示背景）：背景层应静音、
  不交互、低开销，而第三方页面无法从外部静音、会持续跑脚本。

### IPC 纵深防御

预览的 `file:` iframe 里的页面拿不到 Tauri 全局与 invoke key，但 CEF 的 `cef-ipc://` scheme handler 本身不区分 frame。
`tauri-runtime-cef` 的 scheme factory 在 `create(browser, frame, ..)` 时记下 `frame.is_main()`，经 request extension
（`protocol::RequestFrame`）交给 `ipc.rs` 的 `post_message_request`：只接受主 frame，或与该 webview 初始 URL 同源的
子 frame，其余返回 400。三平台原生 `tauri://localhost` 的同源子 frame 由 `web_origin` 比较；畅游窗口的注入脚本跑在主 frame（Origin 是站点源），因此按「主 frame」放行而不是按「应用源」；
CEF 未给出 frame 时维持原行为。`ipc://` 主通道由 Tauri 自己的 handler 承接，不在本防御范围内（仍靠 invoke key）。
`RequestFrame` 同时带 frame URL：`file:` frame 的 `Origin` 在协议层被改写成 frame URL，两条通道都按远程 `file:` 来源走 ACL
（见上「初始化脚本照常注入，IPC 按远程 `file:` 来源限权」）。预览 iframe 即便越过前两道，`file:` 来源也只匹配绑定在
`wallpaper` 窗口的 `wpe-web-capability`，在 `main` 里零授权。

**待真机校准**：`fill`（WPE）→ `contain` 的几何、`wec_*` 的 −1…1 与 CSS filter 量纲。

### 用户属性（第二阶段 Phase 7）

`x-wpe/web` 的用户改动存于该图片 metadata 顶层的 `userProperties` 对象，只保存与作者默认值不同的键。写命令 `set_wpe_web_user_properties` 在 `Storage::rewrite_image_metadata` 的单个事务中读取旧数据、插入新 metadata 行、只改指这张图片并清理无引用旧行；搜索词映射、插件信息和模板沿用旧行。提交后广播 `metadataId` 字段补丁。`get_wpe_web_properties` 返回有序、已本地化的属性视图；桌面与预览的状态拉取按「作者默认值 + 用户值」组装。

预览右栏和设置页当前网页壁纸都可打开属性面板。面板本地草稿立即改变显示条件，300ms 防抖后串行提交；同张图片的 `metadataId` 补丁和界面语言变化触发重读。条件由受限解释器处理字面量、运算、三元、数组、`<key>.value` 及五个字符串 / 数组方法；不认识的条件默认显示，不执行任意脚本。属性说明和标签经 HTML 白名单净化。

`file` 与 `directory` 仅使用用户所选路径；无作者默认值时清空路径会删除该用户键，垫片向页面补发空路径以撤销旧值。core 生成文件 / 目录放行项，运行时 `grant_file_documents(label, for_root, paths)` 在当前根目录仍匹配时追加到该窗口的 `FilePolicy`。桌面壁纸窗口与 Phase 6a 的预览 `file:` iframe 共用这套闸门；预览根目录由 `set_wpe_web_preview` 设置。更换根目录会清空旧放行项；同一根目录内修改属性时，追加放行只增不减，旧路径在下一次导航前仍可能通过运行时闸门。目录属性递归列举浏览器安全的媒体文件，最多 10000 个；垫片对 `fetchall` 发送文件增删回调，对 `ondemand` 随机返回一个文件。

## 七、已知边界

- **WPE 壁纸目前只提供 Windows 桌面**：macOS / Linux / Android / Web 不自动发现、不渲染网页壁纸（桌面 `file://` 宿主与
  预览 `file:` iframe 都按 Windows 门控），`x-wpe/*` 行只显示作者预览图。
- 只导入 `video` 与 `web`；`scene` / `application` 只占位并计入跳过。
- 网页壁纸接收作者默认值与逐壁纸用户值（`applyUserProperties`）及界面语言（`applyGeneralProperties({ language })`）；
  `fps`、`setPaused`、音频与媒体数据尚未实现（注册函数只收下回调）。目录内容不监视，下次状态拉取时更新。
- 桌面网页壁纸只能监听四个事件（`wpe-web.json` 的 `allow-listen` 作用域），应用命令只开 `wpe_web_pull_state` 与
  `wallpaper_pong`。
- 桌面 `file://` 页面里跨源 `http(s)` 请求仍受 CORS 约束（WPE 是全局 `--disable-web-security`，Kabegame 不放开）；
  壁纸样式 / 音量 / 倍速对桌面网页壁纸不生效；桌面只转发鼠标移动与左键（Windows），无键盘 / 滚轮 / 右键。
- 图库预览与桌面壁纸是同一个 `file://` 源，各自的 `localStorage` / `indexedDB` 跨重启稳定，但 Chromium 按顶层站点分区存储，预览（顶层 `localhost:1420`）与桌面（顶层 `file://`）**不互通**（2026-10-29 真机两个方向都读不到对方写的键）（Phase 6a 起；此前预览是随机端口的
  本地 HTTP 源）。不复刻 WPE 的 `disable-web-security`，依赖跨域请求的页面受 CORS 约束。
- 应用背景层对网页壁纸退回作者预览静态图。
- 图库媒体走 `file://`（Phase 6b）的真机验证只在 Windows 做；Linux / macOS 待测。Phase 6c 的 `fetch(file:)`、XHR 改动仍待重编 CEF 后真机验证；Windows `DownloadURL` 拖出路线已放弃，由 Phase 6d 的真实文件链路取代（同样待重编 CEF 后真机验证）。
- `wcc_v` 图像滤镜预设（WPE 浏览属性）未实现，忽略。
- 创意工坊取消订阅后目录消失：行仍在，`local_exists` 为 false，图库标记缺失。
- 虚拟盘、原生壁纸、Plasma 插件模式均看不到 WPE 行（第一阶段）。
- Web 发布版不提供壁纸入口；Android / Web 的 HTTP 文件服务与桌面应用 Web 服务器都没有壁纸目录路由（`/wpe` 已在 Phase 6a 删除）。

## 八、涉及文件

- `src-tauri/kabegame-core/src/wpe/`（discover / recognize / project / properties / user_props / locale / scan）
- `src-tauri/kabegame-core/src/crawler/wpe_import.rs`、`plugin/builtin.rs`、`task_scheduler/mod.rs`
- `src-tauri/kabegame-core/src/media/image_type.rs`、`storage/images.rs`、`storage/organize.rs`
- `src-tauri/kabegame/src/http_server.rs`（`/file` 对 WPE 行 404）、`commands/wallpaper.rs`（`WallpaperTarget`）、
  `wallpaper/mod.rs`（`web_entry`，Windows 门控）、`wallpaper/rotator.rs`、`capabilities/wpe-web.json`、
  `tauri.conf.json.handlebars`（CSP `frame-src … file:`）
- 图库预览 `file:` iframe：`src-tauri/kabegame/src/startup.rs`（`allow_file_documents("main")` +
  `allow_app_local_resources("main")`）、`commands/wpe_web.rs`（`set_wpe_web_preview` 设根目录并返回入口）、
  `apps/kabegame/src/components/wallpaper/{WallpaperStage.vue,wpeWebBridge.ts}`
  （`createWebFrame` 赋 `src` / `teardownWeb` / `isInitialBlank`、`setWpeWebPreview` 串行链）
- `src-tauri/tauri-runtime-cef/src/{protocol.rs,ipc.rs}`（IPC 纵深防御、`file:` frame 的 `Origin` 改写与来源回退顺序）、
  `file_access.rs` / `webview.rs` / `subprocess.rs`（`FilePolicy` 两项能力 + 按发起 frame 分档的闸门、`app_page_open`、
  `extra_info_keys` 写建窗键、`file:` 目录拦截、初始化脚本注入、鼠标注入）、`third-patches/cef/0004-per-browser-file-access.patch`、
  `third-patches/cef/0005-app-page-local-resources.patch`、`third-patches/cef/0006-app-page-file-subresources.patch`
- 图库媒体 `file://`（Phase 6b）：`apps/kabegame/src/utils/fileUrl.ts`（`pathToFileUrl`、`fetch(file:)`）、
  `composables/useImageOperations.ts`（下载 / 复制兜底）、`components/image/ImageContent.vue`（拖出：桌面写 image id、Web 写 `DownloadURL`，见 Phase 6d）、
  `components/common/ImagePluginDescriptionPanel.vue`（opaque origin + `DESCRIPTION_CSP`）、`src-tauri/kabegame/src/http_server.rs`
  （删除 `/proxy`）
- 运行时垫片与宿主协议：`src-tauri/kabegame/src/webview_js/wpe_shim.js`、`commands/wpe_web.rs`（`WpeWebState`、
  `get_wpe_web_state` / `wpe_web_pull_state`、`remote.urls` 匹配单测）、`capabilities/wpe-web.json`、`permissions/wpe-web.toml`、
  `kabegame-core/src/wpe/properties.rs`（`resolve_web_user_props` / `wpe_language_code`）、`wallpaper/manager/{mod.rs,window.rs}`
  （`web_wallpaper_dir`）、`third-patches/tauri/0011-tauri-webview-clear-js-listeners.patch`、
  `apps/kabegame/src/composables/useTauriProxy.ts`、`components/wallpaper/wpeWebBridge.ts`
- 桌面网页壁纸宿主：`src-tauri/kabegame/src/wallpaper/manager/window.rs`（`set_wallpaper_path` 判定、`WALLPAPER_LABEL`）、
  `wallpaper/window.rs`（`WallpaperWindow` 状态、`show_web` / `show_app` / `Drop`）、`wallpaper/input_forward.rs`
- `apps/kabegame/src/components/WallpaperImportDialog.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`、`App.vue`（背景层）、`utils/mediaMime.ts`
- 壁纸窗口 ping 看门狗：`src-tauri/kabegame/src/wallpaper/ping.rs`、`wallpaper/window.rs`（生命周期与导航重置）、
  `commands/window.rs`（`wallpaper_pong`）、`src-tauri/kabegame-core/src/{ipc/events.rs,emitter.rs}`（ping / pong 事件）
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、
  `components/wallpaper/{WallpaperStage.vue,types.ts,WpeWallpaperContent.vue,WallpaperDesktopCanvas.vue}`
