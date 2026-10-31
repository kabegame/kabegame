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
- 网页壁纸以入口的 `file://` 直接加载（预览与桌面都是 `WallpaperStage` web 层里的 `file:` iframe，见第五、六节），
  页面能读的文件边界是运行时按网页壁纸目录索引做的 `file:` 请求拦截；没有 HTTP 目录服务；
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
true）、网页壁纸入口（`web_entry`）与网页壁纸目录索引都按 `target_os = "windows"` 门控；macOS / Linux / Android / Web
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
- **网页**：桌面壁纸窗口与图库预览都以 `WallpaperStage` web 层里的 `file:` iframe 加载入口（第六节「网页壁纸 iframe」），
  页面相对资源自然落在壁纸目录里；文件边界是 `tauri-runtime-cef` 的 `file:` 闸门按网页壁纸目录索引裁决（文档只能访问它自己
  所在的壁纸目录与这张壁纸的用户选择，第六节「网页壁纸目录索引」），两个窗口同一份机制。MIME 由 Chromium 按扩展名判定；
  `file:` 不走 HTTP 缓存，壁纸目录里的文件原地变化（创意工坊更新、作者或用户手改）后重新加载即读到新内容。
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
- `components/wallpaper/WallpaperStage.vue`：纯渲染组件（不 invoke / listen / 读 store；web 层 iframe 也只是把目标里的
  `webEntry` 赋给 `src`，页面里的垫片自己做 IPC，见「网页壁纸 iframe」「运行时垫片与宿主协议」），base / top 双层、
  prep → enter → commit 过渡（两帧 rAF、1400ms 兜底）、去重与严格串行、tile、base 图退避重试、视频 base / top 元素交换、
  音量 / 倍速 / 循环，以及下表的 WPE 作者属性；铺满父元素，额外支持 `paused` / `interactive`（供后续预览内嵌）。
  DOM 仍按原实现命令式操作（模板 ref 只在挂载时取一次），过渡组合类放在 scoped `<style>`。
- 后端组装目标的逻辑在 `commands/wallpaper.rs` 的 `build_wallpaper_target(info)`，`get_current_wallpaper_target`
  与 `get_wallpaper_target_for_image(imageId)`（图库预览 / 背景按 id 取）复用它，所以预览与桌面拿到同一份目标结构。
  WPE 视频的作者属性取自**图片 metadata**（导入时写入的 `project.json` 原文，`resolve_video_props_from_raw`），
  不重读磁盘——用户属性以后作为同一份元数据里的一段合并进来。

`get_current_wallpaper_target` 返回 `{ id, path, type, compatiblePath, wpeVideo, webEntry }`：

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

- `x-wpe/web`：`compatiblePath` 与 `wpeVideo` 为空，`webEntry` 是入口的 `file://`，由 `build_wallpaper_target` 用
  `wallpaper::web_entry` 现算（`read_project` 校验入口在目录内且存在，放 blocking 线程；非 Windows、读不了 `project.json`
  时为 `null`）。图库预览与**桌面壁纸窗口**拿同一份目标，都由 `WallpaperStage` 的独立 **web 层**建一个 iframe、直接赋
  `src = webEntry`（见下「网页壁纸 iframe」）；`webEntry` 为空时报「无法加载网页壁纸」，预览退回作者预览图、桌面保持原画面。

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

### 网页壁纸 iframe

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，靠关掉同源策略读同目录文件。Kabegame 在
两个地方显示网页壁纸，**都是 `WallpaperStage` web 层里的 `file:` iframe**，组件与代码路径同一套：图库预览在主窗口（`main`），
桌面在壁纸窗口（`wallpaper`）。tauri 补丁 0018 / 0019 之前，子 frame 没有 IPC，预览 iframe 只能 `postMessage` 请主窗口代办、
桌面则把整个壁纸窗口导航到 `file://`；现在 frame 是 IPC 的基本单位，两种宿主合成一种（见 [ACL 文档](../tauri/TAURI_ACL_PERMISSION_SYSTEM.md)「子 frame IPC」）。

- **加载**：`WallpaperStage` 建 iframe、插入 DOM 后直接 `frame.src = target.webEntry`，没有命令往返、没有要维护的状态
  （入口由 `build_wallpaper_target` 现算，见上）。壁纸窗口本身始终停在应用页，不再导航。
- **能力登记**（Windows）：主窗口（`startup.rs`）与壁纸窗口（`wallpaper/manager/window.rs`）建窗前都
  `tauri_runtime_cef::allow_file_documents(label)`（CEF 补丁 [`0004`](../../third-patches/cef/README.md)：建窗 `extra_info` 带
  `kabegame.allow_file_access_from_file_urls`，只给这个 browser 的 `file:` 文档打开 `allow_file_access_from_file_urls`，页面
  才能 fetch 同目录文件；偏好对应用页的 http / tauri 源没有作用）与 `allow_app_local_resources(label)`（补丁 0005，三个桌面平台
  都登记：应用页能给 iframe 赋 `file:` 的 `src`；同时供图库媒体走 `file://`，见下「图库媒体」）。非 Windows 不登记 0004，
  `webEntry` 恒为空。`allow_universal_access_from_file_urls` 仍关闭，`file:` iframe 碰不到父页面 DOM。
- **应用页直接赋 `src`，靠 CEF 补丁 0005**：应用页是 `http://localhost:1420` / `tauri` 源，Chromium 有两道互相独立的关
  拦住它嵌 `file:`——渲染进程 Blink 的 `SecurityOrigin::CanDisplay(file:)` 对非本地源返回 false（控制台
  `Not allowed to load local resource`，iframe 停在 `about:blank`）；浏览器进程 `RenderFrameHostImpl::BeginNavigation` 的
  `FilterURL` 对没有 `file` 请求权的进程把 URL 改写成 `about:blank#blocked`。补丁
  [`0005`](../../third-patches/cef/README.md) 按建窗 `extra_info` 的 bool 键 `kabegame.allow_local_resources` 在两道关各开
  一道门：渲染侧 `CefRenderFrameObserver::DidCommitProvisionalLoad` 在**最外层主 frame 每次提交非 `file:` 文档**时调
  `blink_glue::GrantLoadLocalResources`；浏览器侧 `CefBrowserInfo::MaybeCreateFrame` 给最外层主 frame 的 RFH 所在进程
  `ChildProcessSecurityPolicy::GrantRequestScheme(file)`。弹窗提交的任何文档、DevTools、OOPIF、fenced frame 一律不授；同源别名的
  `about:blank` / `srcdoc` 子 frame 与弹窗的初始 `about:blank` 按 Blink 自身规则继承，不超出应用页自身的能力。补丁**只开门**：
  iframe 的 `file:` 导航与 `file:` 文档的请求由运行时闸门按网页壁纸目录索引裁决（见下）。
  > 历史：Phase 6a 曾由运行时从浏览器进程对命名子 frame 调 `CefFrame::LoadURL` 绕开 `CanDisplay`，真机上渲染进程被杀并被
  > `on_render_process_terminated` 的无条件 `reload()` 放大成整窗刷新循环。不要再从后端导航子 frame。
- **前端时序**（`WallpaperStage`）：`createWebFrame(entry)`：没有入口直接抛「无法加载网页壁纸」（非 Windows、Web 版、Android
  都走这条，`ImageContent` 退回作者预览图）；否则建 iframe、插入 DOM、赋 `src`。`load` 时 `isInitialBlank`（仍可读且是
  `about:blank`）的初始空文档忽略；仍可读却不是初始文档（例如浏览器侧缺授权时改写出的 `about:blank#blocked`）记
  `wpe web entry blocked: <href>`；读 `location` 抛错（已是跨源 `file:` 页面）才算加载完成。8s 超时仍停在初始 `about:blank`
  记 `wpe web entry not navigated (CEF patch 0005 missing?)`，否则记 `wpe web entry load timeout`。切换壁纸一律
  `teardownWeb`（先 `about:blank` 再移除，frame 销毁）后重建 iframe，不在原 iframe 上改 `src`：闸门把「原 iframe 的 `file:`
  文档发起的导航」算作这个文档发起，跨到另一张壁纸会被拒。
- **CSP**：`tauri.conf.json.handlebars` 的 `frame-src 'self' blob: data: about: file:`（生成的 `tauri.conf.json` 被 gitignore）。
- **IPC**：CEF runtime 给每个子 frame 无条件注入 Tauri 的 IPC 桥，iframe 里的垫片直接 `invoke` / `listen`（见下「运行时
  垫片与宿主协议」）；能调什么只看 ACL。`file:` 文档的 `Origin` 是 `null`，运行时在协议层把它改写成 frame URL
  （`protocol::pin_file_frame_origin`，两条通道都判成 `Origin::Remote { url: file:///… }`），只有 `wpe-web-capability`
  （`windows: ["main", "wallpaper"]`、`frames: "sub"`、`remote.urls: ["file:///*"]`、`local: false`）对它生效：带事件名作用域的
  `core:event:allow-listen`（`wallpaper-ping` / `setting-change` / `image-changed` / `images-change`）、`allow-unlisten` 与
  `permissions/wpe-web.toml` 的 `wpe_web_pull_state`、`wallpaper_pong`；不给 `core:default`。两个窗口的特赦
  （`acl_exempt_webview`）只认本地来源的主 frame，对 iframe 不生效。网页壁纸里再嵌的 `file:` iframe 同样匹配这份
  capability（同一作者的内容，信任级别相同），但垫片不在其中启用。
- **事件只投递到这个 iframe**：监听登记在调用方 frame 的表里，投递 eval 进这个 frame；iframe 销毁时 runtime 报
  `SubframeDestroyed`，Tauri 删掉它的全部监听，切换壁纸不会积累监听，也不再需要按导航调 `clear_js_listeners()`。
- **`localStorage`**：Chromium 按顶层站点分区存储，预览与桌面的顶层都是应用页，所以两处是**同一分区、互通**。以前桌面顶层是
  `file://`，那时桌面里存下的页面数据不会带过来。
- **触发点**：图库预览随预览打开 / 切图；桌面随 `WallpaperWindow.vue` 收到的当前壁纸目标（`setting-change` 的
  `currentWallpaperImageId` → `get_current_wallpaper_target`）。后端 `WindowWallpaperManager::set_wallpaper_path` 不再导航，只按
  `web_entry(path).is_some()` 开关 Windows 的桌面鼠标转发（`WallpaperWindow::set_mouse_forwarding`，见下）；设壁纸、轮播、
  启动恢复、切换到窗口模式、重新开启壁纸、改样式都会走到它。
- **过渡**：桌面与预览一样，图片 / 视频与网页壁纸之间走 web 层的淡入淡出；壁纸样式、音量、倍速对页面不生效。

### ping 看门狗

`wallpaper/ping.rs` 的 `Pinger` 随 `WallpaperWindow` 持有，在 `mount()` 挂载、显示完成后启动；丢弃对象时
reset 通道关闭，任务退出。后端用 sleep 循环每 10s 探测，页面收到事件才应答、不自己计时：窗口被遮挡变成 hidden
时页面定时器会被 Chromium 节流，页面心跳容易误报。sleep 不补发错过的 tick，系统睡眠唤醒后最多多算一次未应答。

往返使用两个全局事件种类：默认种类 `wallpaper-ping { label, seq }` 经 `GlobalEmitter` 广播、主事件循环 `app.emit`
送到窗口；应用页 `WallpaperWindow.vue` 与网页壁纸 iframe 里的垫片都 `listen`，只应答 label 等于自己窗口的事件，再调用
`wallpaper_pong(seq)`。**网页壁纸显示期间应用页不应答**（`WallpaperStage.isShowingWeb()`，iframe 存在即算，含加载中），交给
iframe 里的垫片：页面卡死就不应答，照样触发整页重载。切换的短暂间隙最多漏一两次（阈值 3 次），不会误触发重载。预览在主窗口里，
垫片读到的 label 是 `main`，过滤掉。命令从调用方 webview 取 label，页面不能替其它窗口应答；`wallpaper-pong { label, seq }`
是 opt-in，默认不转发给窗口、SSE 或「订阅全部」的 IPC 客户端，只有显式订阅它的后端看门狗接收。

连续 3 次未应答就 `reload()` 整个壁纸窗口（应用页连同网页壁纸 iframe，约 30~40s）。若重载后仍未收到一次有效应答，
下次判死所需次数翻倍：3 → 6 → 12……，上限 60（约 10 分钟）；有效应答会清零连续未应答次数并把阈值恢复为 3。
看门狗重载后 `clear_js_listeners()`（主 frame 的 `wallpaper-ping` 等监听随重载作废，Tauri 不会自己清；iframe 的监听随 frame
销毁另行清掉），并在状态机内重置：`floor = seq`、清空等待与未应答次数，只接收序号大于 floor 的应答，避免旧文档的迟到应答
影响新文档。序号持续递增，重置保留当前退避阈值，直到收到有效应答。窗口不再导航，`Pinger::reset()` 目前没有调用方。

应用页挂载即应答，不等 init 完成。ping 检查事件投递、JS 主线程与回程 IPC 是否存活；原有 init 看门狗继续检查初始化
是否跑通。CEF hang monitor 主要依赖输入事件回执，壁纸窗口几乎没有输入，由 ping 主动发起恢复。JS 卡死后 reload
能否触发 Chromium commit timeout、进入现有 terminate + reload 链路仍需真机验证：重载后 60s 内既无 renderer
unresponsive 也无恢复应答时，应报告并另补重建窗口兜底，不能用加大次数掩盖。

代价是窗口模式期间默认流每 10s 多一条 `wallpaper-ping`，其它窗口、桌面应用 Web 服务器的 SSE 与「订阅全部」的 IPC
客户端也可见（只有 label 与 seq）；订阅方可忽略。`wallpaper-pong` 不进入这些默认流。

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
- **运行时按发起方分档**（`tauri-runtime-cef` 的 `resource_request_handler` + `file_access::classify_file_requester`；登记了任一
  能力的 label 的 `file:` 请求才进入分档）。不免检的请求在 `OnBeforeResourceLoad` 里向应用注册的解析器要访问范围
  （`set_file_scope_resolver`，即网页壁纸目录索引），再经 `check_file_request` 判定（百分号解码成路径，必须是普通文件，拒绝
  符号链接 / 目录 / 不存在，canonicalize 后必须落在范围的根目录或放行项内，Windows 大小写不敏感）：

  | 发起方 | 判定 | 处理 |
  | --- | --- | --- |
  | 应用页主 frame 的子资源（图库媒体） | 非导航、`frame.is_main()`；`request_initiator` 非空、非 `null`，且它与 `frame.url()` 都不是 `file:` | label 登记了 0005 即**免检**（`file_access::app_page_open`） |
  | `file:` 文档自己的请求（WPE 页 fetch 同目录、嵌套 `keyframes.html`、自身导航） | `frame.url()` 是 `file:` | 只能访问**它自己所在**的网页壁纸：按文档路径解析出的范围（壁纸目录 + 这张壁纸的用户选择） |
  | 壁纸页面嵌的新 iframe 导航 | 子 frame 导航、父 frame 的 URL 是 `file:` | 同上，按父文档解析 |
  | 应用页给 iframe 赋 `src` | 子 frame 导航、父 frame 不是 `file:` | 目标须落进库里**某个**网页壁纸目录：按目标路径解析，只取壁纸目录、不带用户选择 |
  | 认不出文档的 `file:` 请求 | 非导航、`frame.url()` 不是 `file:` 但发起方 origin 是 `file:` | 暂按目标路径解析（见下「已知限制」） |
  | 主 frame 导航到 `file:`、其它 | — | 拒绝 |

  拒绝时日志记 `deny file: <url> (outside <root>; grants N; <原因>; requester …) webview '<label>'`（info 级）。不按 frame id
  建表：WPE iframe 从 `about:blank` 导航到 `file:` 时换进程、换 RenderFrameHost，frame identifier 随之变化，而 frame 自己的
  文档 URL 就说明了它属于哪张壁纸。解析器注册之前（启动早期）所有不免检的请求都被拒绝；那时只有应用页主 frame 的子资源，
  它免检。
  **已知限制**：CEF 只在导航完成后刷新 `CefFrame::GetURL()` 的缓存，新文档最早的几个请求可能读到空串或 `about:blank`。这类
  请求认不出是哪个文档，暂按目标路径解析——只放行库内壁纸目录、不含用户选择，读用户选的文件要等 frame URL 刷新后的请求；
  另一位开发者在用 Chromium 补丁让 frame URL 及时刷新，落地后这一档自然消失。
- **主 frame 边界**：应用页主 frame 的 `file:` 子资源免检，`fetch(file:)` / XHR 可取得字节；生产 CSP `connect-src file:` 明确允许。
  应用页能把库里任一网页壁纸目录加载进子 frame（只有它的主 frame 有补丁 0005 的本地资源授权，其它子 frame 的文档本来就加载
  不了 `file:`）；`file:` 文档只能访问自己的壁纸。插件详情 EJS iframe 为 opaque origin，内层 CSP 禁止读取 IPC 与本地文件
  （它也有 IPC 桥，但没有任何 capability 匹配它）。
- **前端**：桌面 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 都返回 `file://`；复制兜底直接 `fetch(file:)`。Windows 拖出曾写当前媒体元素 `file://` 的 `DownloadURL`，已由 Phase 6d 取代：三个桌面平台都只写 image id、走 CEF 补丁 0003 的真实文件链路（Windows 为 `CF_HDROP`，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`），Web 版保留 `DownloadURL`。插件文件改由 Tauri `read_plugin_file` 命令返回原始字节，图片缓存为 `blob:` URL。Android / Web 的 HTTP 文件路由、桌面可选应用 Web 服务器的 `file_routes_media()` 保留；桌面启动时不再开启本地 HTTP 文件服务。

### 网页壁纸目录索引

`wallpaper/wpe_web_dir_index.rs` 的 `WpeWebDirIndex`：库内每张网页壁纸的**规范化目录键 → 图片 id + 壁纸目录 + 用户选择算出的
放行**，外加图片 id → 目录键。只在内存里、不落库，是 `file:` 闸门与 `wpe_web_pull_state` 的唯一数据源（取代原来按 webview
存的「根目录 + 追加放行」与 `set_wpe_web_preview`）。

- **键**：与闸门同一套规范化，`tauri_runtime_cef::file_path_key`（canonicalize、去 Windows `\\?\` 前缀、Windows 不分大小写、去尾
  分隔符），两边不各写一份。查找沿路径的祖先向上，第一个在表里的目录就是所属壁纸（文档在壁纸子目录里也能找到）。目录已不
  存在时不登记。
- **建表时机**：桌面 Windows 在 `core_init::init_heavy_globals` 里 `Storage::init_global()` 之后、进入 `Services` 阶段之前调用
  `init_wpe_web_dir_index()`。两个宿主都晚于它：主窗口虽在 `init_pre` 建好，但前端要等启动页 Ready 才会打开预览；壁纸窗口在
  `init_post` 才建。所以表一定先于任何网页壁纸 iframe 就绪，冷启动时桌面就是网页壁纸也能第一次就加载成功。
- **先订阅再扫描**：先同步订阅 `images-added` / `images-deleted` / `image-changed` / `images-change` 四种广播，再全量扫描
  （`Storage::list_wpe_web_rows`：`type = ?1` 等值查询、走 v049 的 `idx_images_type`，类型键取自 `WpeKind::Web.media_type()`；
  metadata 按行读），扫描期间到达的事件留在通道里随后处理。扫完向 runtime 注册解析器，再在后台跟随事件。
- **事件维护**：`images-added` 只看 `x-wpe/web` 行；`images-deleted` 按 id 删；字段补丁只处理表里已有、且带 `metadataId`（改了用户
  属性）或 `localPath` 的行。新增与补丁都按 id 重读行与 metadata 后 upsert（行没了或不再是 `x-wpe/web` 就删），按库里的当前状态
  落地，与各订阅之间的到达顺序无关；某个订阅落后丢事件（`Lagged`）时整张重建。逐事件路径只改内存、按 id 读库、不发事件，
  不打 trace 以上的日志。
- **放行的两条写入路**：事件跟随在收到 `metadataId` 补丁时按新 metadata 重算（改了目录属性，旧目录**立即**不可读，不必等
  页面重拉）；`wpe_web_pull_state` 在把状态交给页面之前用同一份 metadata 覆盖（页面拿到新路径时闸门一定已经认它）。两条路写的
  都是「这张壁纸当前 metadata 算出的放行」，先后到达结果相同；覆盖，不是追加。
- **失败时全拒**：建表失败只记 error 并保持空表，闸门全拒、拉取报错，网页壁纸加载不出来，但不放宽。非 Windows 不建表
  （`WpeWebDirIndex::global()` 是空表）。

### 运行时垫片与宿主协议

WPE 网页壁纸要靠宿主提供的一组全局接口完成初始化，最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：
宿主把作者默认值推给它之后，多数壁纸才开始画。Kabegame 用一份 JS 垫片 `webview_js/wpe_shim.js` 定义这组接口并投递属性，
**不照搬 WPE 的「宿主拼 JS、加载完成前排队」**（`API.md` §4.8），改成垫片驱动：垫片向宿主**拉取**完整状态、**订阅**
应用事件后重拉；宿主只回答「当前完整状态」和「转发事件」，不推状态、不排队、不记页面收到过什么。

- **注入与启用**：同一份垫片以 `initialization_script_for_all_frames` 挂在壁纸窗口（`wallpaper/manager/window.rs`）与
  主窗口（`startup.rs`）上，按地址自判：只在「父窗口就是 top 的 `file:` 子 frame」（网页壁纸 iframe，预览与桌面同一份）且
  有 `__TAURI_INTERNALS__`（CEF 注入的子 frame 桥）时启用，其它文档第一行就返回、不定义任何全局。壁纸自己更深的嵌套 iframe 不启用。启用后定义 `wallpaperMediaIntegration` 常量、六个 `wallpaperRegister*Listener`（收下回调、Phase 8 前
  不回调）、空的 `wallpaperRequestRandomFileForProperty` 与 `wallpaperGetUtilities`，并标记 `window.__kbWpeShim === true`。
- **状态**（只在 Rust 侧计算，`commands/wpe_web.rs` 的 `build_wpe_web_state`）：`{ imageId, user, general: { language } }`。
  `user` 取自图片 metadata（导入时存的 `project.json` 原文）里 `general.properties` 中带 `value` 的条目，形如
  `{ key: { type, value } }`（`kabegame_core::wpe::properties::resolve_web_user_props`；分组、说明行、无默认值的 `file`
  属性不推）；`language` 是界面语言换成的 WPE 语言码（`wpe_language_code`：`zh-chs` / `zh-cht` / `ja-jp` / `ko-kr`，其余
  `en-us`）。`fps` 留给 Phase 6（推 0 会让按 `1000 / fps` 算间隔的页面停住）。Rust 不带版本号。
- **一种传输**：iframe 自己就是调用方，直接 `invoke` / `listen`，预览与桌面逐字节同一份：
  - `pull()` = `invoke("wpe_web_pull_state")`：命令不接收 id、不看 webview，参数只有 `tauri::ipc::CallerOrigin`（ACL 判定所用的
    调用方来源；运行时把 `file:` frame 的 `Origin` 改写成完整文档 URL，页面伪造不了）。它把来源还原成文档路径（只认 `file:`），
    在网页壁纸目录索引里找到所在的那张，按 id 组装状态，返回前用同一份 metadata 覆盖这张壁纸的放行；页面拿不到别的图片的
    metadata。不在任何网页壁纸里、不是 `file:` 来源都报错。
  - `listen(names, onEvent)` = 逐个 `plugin:event|listen`（`core:event:allow-listen`），事件只投递到本 frame。
  - 新文档最早的几个请求可能还拿不到正确的来源（见上「图库媒体」的已知限制），垫片对每个事件的 listen 与首个状态之前的 pull
    做有限次退避重试（250ms 起翻倍，最多 5 次）；已登记成功的事件不重复登记。
- **ping 应答**：垫片监听 `wallpaper-ping`，从 `__TAURI_INTERNALS__.metadata.currentWebview.label` 取自身 label、过滤后调用
  `wallpaper_pong(seq)`；不等 load 或属性拉取成功。只有壁纸窗口里的 iframe 应答（预览的 label 是 `main`）。`wallpaper_pong`
  只替调用方窗口发应答，不读取数据。
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
- **监听随 frame 清理**：监听按「webview → frame → 事件」登记，iframe 销毁时 runtime 报 `SubframeDestroyed`，Tauri 删掉该
  frame 的全部监听。同一 frame 内重新导航后旧条目还在、投递进新文档时找不到 id 等于空操作，直到 frame 销毁；`WallpaperStage`
  每次切换都销毁重建 iframe，不会积累。补丁 0011 的 `clear_js_listeners()` 只剩看门狗整页重载时调用。
- **可见事件**：网页壁纸只能监听 `wpe-web.json` 作用域里的四个事件（`wallpaper-ping`、`setting-change`、`image-changed`、
  `images-change`，tauri 补丁 0015），其它事件名（如 `images-added`）`listen` 被 ACL 拒绝；垫片新增监听要同步改 capability。
  命令层只开拉取状态与 ping 应答两个命令。
- **不做**（后续 Phase）：暂停冻结与 `setPaused`、`fps`；音频与媒体数据（Phase 8，数据回程沿用 `listen`）；Web 发布版 /
  Android / macOS / Linux 不渲染网页壁纸。
- **待真机确认**（Windows）：iframe 统一后的整条链路见 `versions/latest/regression.md`「frame 级 IPC（tauri 补丁 0018–0019）」。

### 桌面鼠标转发（Windows）

`wallpaper/input_forward.rs`：照 WPE 的做法不装鼠标钩子，由后台线程每 16ms 轮询 `GetCursorPos` 与
`GetAsyncKeyState(VK_LBUTTON)`，只在「窗口模式 + 当前是网页壁纸」运行：`set_wallpaper_path` 按 `web_entry` 调
`WallpaperWindow::set_mouse_forwarding(true / false)` 启停（幂等），窗口对象丢弃时由 `InputForwarder` 的 `Drop` 停止。注入落到
窗口里的 web 层 iframe，所以壁纸窗口给 `WallpaperStage` 传 `interactive`，iframe 接收指针事件。

- 光标在壁纸窗口客户区内：`ScreenToClient` 得物理坐标，除以 `GetDpiForWindow / 96` 得视图坐标，坐标变化就经
  `tauri_runtime_cef::inject_mouse` 注入 `Move`（不带按键标志，与 WE 一致：带左键会让页面图片拖动启动 OLE 拖放并挂住 UI 线程）；离开客户区时注入一次 `Leave`。
- 左键按下沿：光标在客户区内，且 `WindowFromPoint` 命中窗口的根窗口（`GetAncestor(GA_ROOT)`）类名是 `Progman` /
  `WorkerW`（桌面图标层或壁纸层本身，即点在桌面空白处或图标上）才注入 `LeftDown`；抬起沿只要按下被转发过就注入
  `LeftUp`，停止转发时也会补发，保证成对。点在别的应用窗口上不转发。
- 不拦截、不吞掉任何输入：Explorer 照常收到点击（桌面图标选中状态会变，与 WPE 一致）。
- 注入走 `CefBrowserHost::SendMouse*Event`，直接进 Chromium 输入管线，不依赖窗口焦点与 Z 序；只投递不等回执。
- 不做：键盘、滚轮、右键、设置开关；macOS / Linux 不转发。

### web 层（`WallpaperStage`）

- 对 `type === "x-wpe/web"` 的目标，在 base / top 双层之上命令式创建一个 **`file:` iframe**（插入后直接赋
  `src = webEntry`，见上「网页壁纸 iframe」），与应用前端不同源，拿不到父页面 DOM；IPC 来自 CEF 注入的子 frame 桥，权限只有
  `wpe-web-capability`。`webEntry` 为空（非 Windows 等）时不建 iframe、报「无法加载网页壁纸」。
  `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（不给 top-navigation / popups / modals /
  downloads）、`allow="autoplay; fullscreen"`、`referrerpolicy="no-referrer"`。
- **不参与 base / top 双层过渡**：一次只存在一个 iframe。切入时等页面 `load`（8s 无 load 记 `wpe web entry load timeout`，
  仍停在初始 `about:blank` 时记 `wpe web entry not navigated (CEF patch 0005 missing?)`，都不销毁）后整层淡入（none 直接显示；fade / slide / zoom 用与媒体层相同的曲线）盖住媒体层，淡入完成再清空媒体层；
  切走时新媒体先按「首帧直设」放到 base，web 层淡出后 **销毁** iframe（先 `about:blank` 再移除），让渲染进程回收；
  web → web 先淡出销毁旧页面再加载新页面。target 置 null、组件卸载时立即销毁；frame 销毁后它的监听随 `SubframeDestroyed` 清掉。
- `paused` 对 web 层只做 `visibility: hidden`（省合成，不冻结脚本；冻结留给后续垫片）；`interactive` 决定 iframe 的
  `pointer-events`（预览与桌面壁纸窗口都传，桌面靠它接收注入的鼠标；应用背景不传）；`styleMode` / `volume` / `playbackRate`
  对页面无意义，WPE 视频的 stage 样式也不作用于它。
- `ready` 在 iframe `load` 时发；调试快照 `media` 为 `"web"`；对外暴露 `isShowingWeb()`（壁纸窗口据此把 ping 交给垫片）。

### 图库接入

- `ImageContent` 新增 `wallpaper` 形态：**非视频** WPE 行（`isWpeWallpaperContentType`：web，以及未来的 scene）在
  `prefer="original"` 时交给 `components/wallpaper/WpeWallpaperContent.vue`（按 id 调 `get_wallpaper_target_for_image`，
  样式 / 过渡 / 音量 / 倍速跟随壁纸设置，渲染 `WallpaperStage`），缩略形态仍是作者 `preview.*`；该形态不构建缩略 / 原图链，
  丢失态只看 `localExists === false` 或目标取不到（页面加载超时不算丢失）。`x-wpe/video` 不走这里，仍是 `<video>` 链。
  非 Windows 上目标的 `webEntry` 为空：`WallpaperStage` 报非致命错误，`ImageContent` 只结束加载态，原图形态的画布留空
  （网格与应用背景本来就用作者预览图）。
- 网格（`ImageItem`）对所有 WPE 行固定用缩略形态，不悬停加载原图形态；角标「WPE · 视频」/「WPE · 网页」。
- 预览弹窗对非视频 WPE 行渲染 `components/wallpaper/WallpaperDesktopCanvas.vue`：按主显示器逻辑分辨率
  （`primaryMonitor()` 的 `size / scaleFactor`，失败回退 `window.screen`，模块级缓存）给一块固定尺寸画布，整体
  `scale` 进可用区域并居中，页面按桌面尺寸排版且可交互；右下角角标「桌面预览 · W×H」。不走 Panzoom、不挂
  `VideoControls`，控制条只保留全屏。
- 应用背景层对非视频 WPE 行**退回作者预览静态图**（`prefer="thumbnail"`；没有独立预览图时不显示背景）：背景层应静音、
  不交互、低开销，而第三方页面无法从外部静音、会持续跑脚本。

### IPC 纵深防御

tauri 补丁 0019 起，CEF 下**每个子 frame 都有 Tauri 的 IPC 桥**（包括预览 / 桌面的网页壁纸 iframe、插件详情 EJS iframe、
畅游页里的第三方 iframe），invoke key 不再是闸门，ACL 是唯一闸门：

- 子 frame 的请求记为 `IpcFrame::Sub` 并带 `SubframeId`，只匹配 `frames` 为 `sub` / `any` 的 capability；本应用只有
  `wpe-web-capability` 写了 `frames: "sub"`（`file:///*` 来源）。特赦只认本地来源的主 frame。
- `cef-ipc` 回退通道不再按「主 frame 或同源子 frame」挡请求，放行所有 CEF 给出了 frame 的请求、交给 ACL；来源取值收紧为
  「`Origin` 头 → frame URL」，子 frame 两者都拿不到时用占位来源 `kabegame-unattributed://subframe/`（不匹配任何 capability，
  在 ACL 被拒，错误回调送回调用方 frame），**不再**退到 webview 初始 URL（应用页）把子 frame 判成本地来源。
- 唯一绕过 ACL 的命令 `plugin:__TAURI_CHANNEL__|fetch`：Channel 大数据队列按 webview 顺序编号、可以被猜到，条目绑定发起方
  frame，别的 frame 拿同一个 id 只得到 `data not found`。
- 送回页面的数据（监听登记、事件、Channel 消息、回退响应）都 eval 进发起调用的那个 frame。

**待真机校准**：`fill`（WPE）→ `contain` 的几何、`wec_*` 的 −1…1 与 CSS filter 量纲。

### 用户属性（第二阶段 Phase 7）

`x-wpe/web` 的用户改动存于该图片 metadata 顶层的 `userProperties` 对象，只保存与作者默认值不同的键。写命令 `set_wpe_web_user_properties` 在 `Storage::rewrite_image_metadata` 的单个事务中读取旧数据、插入新 metadata 行、只改指这张图片并清理无引用旧行；搜索词映射、插件信息和模板沿用旧行。提交后广播 `metadataId` 字段补丁。`get_wpe_web_properties` 返回有序、已本地化的属性视图；桌面与预览的状态拉取按「作者默认值 + 用户值」组装。

预览右栏和设置页当前网页壁纸都可打开属性面板。面板本地草稿立即改变显示条件，300ms 防抖后串行提交；同张图片的 `metadataId` 补丁和界面语言变化触发重读。条件由受限解释器处理字面量、运算、三元、数组、`<key>.value` 及五个字符串 / 数组方法；不认识的条件默认显示，不执行任意脚本。属性说明和标签经 HTML 白名单净化。

`file` 与 `directory` 仅使用用户所选路径；无作者默认值时清空路径会删除该用户键，垫片向页面补发空路径以撤销旧值。core 生成文件 / 目录放行项（`user_file_grants`），网页壁纸目录索引按这张壁纸当前的 metadata **覆盖**它的放行（`metadataId` 补丁到达时、`wpe_web_pull_state` 返回前各写一次，见上「网页壁纸目录索引」）：改了目录属性，旧目录立即不可读；另一张网页壁纸读不到这张的用户选择。预览与桌面共用这套闸门。目录属性递归列举浏览器安全的媒体文件，最多 10000 个；垫片对 `fetchall` 发送文件增删回调，对 `ondemand` 随机返回一个文件。

## 七、已知边界

- **WPE 壁纸目前只提供 Windows 桌面**：macOS / Linux / Android / Web 不自动发现、不渲染网页壁纸（`web_entry` 与网页壁纸目录
  索引都按 Windows 门控），`x-wpe/*` 行只显示作者预览图。
- 只导入 `video` 与 `web`；`scene` / `application` 只占位并计入跳过。
- 网页壁纸接收作者默认值与逐壁纸用户值（`applyUserProperties`）及界面语言（`applyGeneralProperties({ language })`）；
  `fps`、`setPaused`、音频与媒体数据尚未实现（注册函数只收下回调）。目录内容不监视，下次状态拉取时更新。
- 网页壁纸只能监听四个事件（`wpe-web.json` 的 `allow-listen` 作用域），应用命令只开 `wpe_web_pull_state` 与
  `wallpaper_pong`。
- 网页壁纸页面里跨源 `http(s)` 请求仍受 CORS 约束（WPE 是全局 `--disable-web-security`，Kabegame 不放开）；
  壁纸样式 / 音量 / 倍速对网页壁纸不生效；桌面只转发鼠标移动与左键（Windows），无键盘 / 滚轮 / 右键。
- 图库预览与桌面的网页壁纸 iframe 顶层都是应用页，Chromium 按顶层站点分区存储，两处 `localStorage` / `indexedDB` 是**同一分区、
  互通**，跨重启稳定。iframe 统一之前桌面顶层是 `file://`，那时桌面里存下的页面数据不会带过来。
- 新文档最早的几个请求可能读到旧的 frame URL（CEF 只在导航完成后刷新）：`wpe_web_pull_state` 认不出调用方、闸门把它当认不出
  文档的请求，垫片靠退避重试兜底；待 Chromium 补丁落地（见上「图库媒体」的已知限制）。
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
- `src-tauri/kabegame/src/http_server.rs`（`/file` 对 WPE 行 404）、`commands/wallpaper.rs`（`WallpaperTarget.webEntry`）、
  `wallpaper/mod.rs`（`web_entry`，Windows 门控）、`wallpaper/rotator.rs`、`capabilities/wpe-web.json`、
  `tauri.conf.json.handlebars`（CSP `frame-src … file:`）
- 网页壁纸 iframe：`src-tauri/kabegame/src/startup.rs` 与 `wallpaper/manager/window.rs`（`allow_file_documents` +
  `allow_app_local_resources`）、`apps/kabegame/src/components/wallpaper/WallpaperStage.vue`（`createWebFrame` 赋 `src` /
  `teardownWeb` / `isInitialBlank` / `isShowingWeb`）、`views/WallpaperWindow.vue`（`acceptTarget`、ping 让给垫片）
- 网页壁纸目录索引：`src-tauri/kabegame/src/wallpaper/wpe_web_dir_index.rs`、`core_init.rs`（建表时机）、
  `kabegame-core/src/storage/images.rs`（`list_wpe_web_rows`）
- `src-tauri/tauri-runtime-cef/src/{protocol.rs,ipc.rs}`（`IpcFrame` / `SubframeId`、`file:` frame 的 `Origin` 改写与来源回退
  顺序、回退通道）、`file_access.rs` / `webview.rs` / `subprocess.rs` / `runtime.rs`（两项能力 + 按发起方分档的闸门、
  `classify_file_requester` / `set_file_scope_resolver` / `file_path_key`、`extra_info_keys` 写建窗键、子 frame 桥注入、
  `EvalInSubframe`、`on_frame_destroyed`、鼠标注入）、`third-patches/cef/0004-per-browser-file-access.patch`、
  `third-patches/cef/0005-app-page-local-resources.patch`、`third-patches/cef/0006-app-page-file-subresources.patch`、
  `third-patches/tauri/0018-tauri-frame-scoped-ipc.patch`、`third-patches/tauri/0019-tauri-subframe-ipc-injection.patch`
- 图库媒体 `file://`（Phase 6b）：`apps/kabegame/src/utils/fileUrl.ts`（`pathToFileUrl`、`fetch(file:)`）、
  `composables/useImageOperations.ts`（下载 / 复制兜底）、`components/image/ImageContent.vue`（拖出：桌面写 image id、Web 写 `DownloadURL`，见 Phase 6d）、
  `components/common/ImagePluginDescriptionPanel.vue`（opaque origin + `DESCRIPTION_CSP`）、`src-tauri/kabegame/src/http_server.rs`
  （删除 `/proxy`）
- 运行时垫片与宿主协议：`src-tauri/kabegame/src/webview_js/wpe_shim.js`、`commands/wpe_web.rs`（`WpeWebState`、
  `wpe_web_pull_state` / `caller_document`、`remote.urls` 匹配单测）、`capabilities/wpe-web.json`、`permissions/wpe-web.toml`、
  `kabegame-core/src/wpe/properties.rs`（`resolve_web_user_props` / `wpe_language_code`）、
  `third-patches/tauri/0011-tauri-webview-clear-js-listeners.patch`（看门狗重载时清主 frame 监听）
- 桌面网页壁纸：`src-tauri/kabegame/src/wallpaper/manager/window.rs`（`set_wallpaper_path` 开关鼠标转发、`WALLPAPER_LABEL`）、
  `wallpaper/window.rs`（`WallpaperWindow`：`set_mouse_forwarding`、看门狗）、`wallpaper/input_forward.rs`
- `apps/kabegame/src/components/WallpaperImportDialog.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`、`App.vue`（背景层）、`utils/mediaMime.ts`
- 壁纸窗口 ping 看门狗：`src-tauri/kabegame/src/wallpaper/ping.rs`、`wallpaper/window.rs`（生命周期与重载清理）、
  `commands/window.rs`（`wallpaper_pong`）、`src-tauri/kabegame-core/src/{ipc/events.rs,emitter.rs}`（ping / pong 事件）
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、
  `components/wallpaper/{WallpaperStage.vue,types.ts,WpeWallpaperContent.vue,WallpaperDesktopCanvas.vue}`
