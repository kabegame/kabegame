# AGENTS.md

## 建议阅读：Cursor 规则

本仓库的 **Cursor** 约束位于 **`.cursor/rules/`**（`.mdc` 文件）中。它们是使用 Cursor 开展工作时的规范规则，会始终应用（或按路径范围应用）。

**进行实质性代码或配置修改之前：** 请阅读 `.cursor/rules/` 中适用于所编辑区域的 `.mdc` 文件（若范围不明确，则阅读全部文件）。如存在 `.claude/rules/`，也应将两者一并视为强制要求。

**约定发生变化时：** 同步更新 `.cursor/rules/` 和本 `AGENTS.md`，确保二者不存在冲突——在此处或导入文件中同步关键要求，并继续将 Cursor 规则作为编辑器强制行为的唯一事实来源。

这是代码库的索引。进行变更时，请记得同步更新这些文档。
@cocs/README.md

## 项目简介

Kabegame 是一款跨平台动漫壁纸爬取与管理工具，使用 **Tauri 2**（Rust 后端）和 **Vue 3** 构建。它支持 Windows、macOS、Linux、Android 和 web，**不支持 iOS**。爬虫插件使用 **JavaScript/TypeScript** 编写，运行于嵌入式 V8（deno_core）后端（或 WebView 后端）。

## 架构

### 单体仓库布局
- `apps/kabegame/` — Vue 3 前端（Vite、Pinia、UnoCSS、自有组件库）
- `packages/` — 共享前端包、自有组件库、插件开发子仓库与生成型包；详见 [packages/AGENTS.md](packages/AGENTS.md)
- `src-tauri/kabegame-core/` — `kabegame-core`：共享 Rust 库（爬虫引擎、插件系统、存储）
- `src-tauri/kabegame/` — Tauri GUI 应用（桌面端 + Android）
- `src-tauri/kabegame-cli/` — 无界面 CLI
- `src-tauri/tauri-plugin-*/` — 自定义 Tauri 插件（picker、pathes、share、wallpaper、task-notification），与应用和共享 Rust 库同级
- `src-tauri/tauri-plugin-wemt/` — Windows 窗口壁纸的 WorkerW 挂载插件；主应用不再对 Progman 图标层反复修正 Z-order，见 [挂载说明](cocs/wallpaper/WINDOW_MOUNT_WEMT.md)
- `src-crawler-plugins/` — JS/TS 爬虫插件子仓库，一个单独的 pnpm workspace 根
- `third-patches/` — 带编号的补丁序列，用于保持 `third/` 子模块gitlink指向上游，但运行时附带仓库的补丁

### 关键架构规则
**进程模型**——Kabegame 运行时涉及以下进程：

| 进程 | 平台 | 职责 |
|---|---|---|
| `kabegame`（主应用） | 全平台 | **唯一的业务状态属主**：Storage、PathQL 查询引擎、任务调度（V8 插件在本进程内每任务独占线程运行）、事件广播、虚拟盘挂载（Dokan / FUSE 在进程内）。桌面端同时是 CEF browser 进程，并开 app IPC 服务端（Windows named pipe / Unix socket）与可选的应用 Web 服务器。启动时若检测到同数据目录已有实例，经 IPC 转发「显示窗口」/「导入 `.kgpg`」后立即退出 |
| `kabegame-cef-helper` | 桌面 standard | CEF 子进程，全部是主进程的直接子进程，由 `browser_subprocess_path` 派生、`--type=` 区分角色：`gpu-process`、`utility`（NetworkService / StorageService，按需再起 AudioService / VideoCaptureService 等）、`renderer`（每个 browser / 站点一个），**不持有任何业务状态**。CEF profile 目录 dev 为 `~/.cache/kabegame-cef-dev`、prod 为 `~/.cache/kabegame-cef`，所以 dev 与已安装版可同时运行、各带一套 helper。主界面、畅游窗口、WebView 爬虫任务窗口（`crawler-<task_id>`）都是主进程里的 CEF browser，页面跑在 helper renderer 中，经 Tauri IPC 回到主进程。位于 exe 旁（Linux release 为 `/usr/lib/kabegame/`）；Linux 禁用 zygote，每个 renderer 独立启动 helper |
| `kabegame-cli` | 桌面 | 独立进程。碰数据库或主程序运行时状态的操作优先经 app IPC 交给主程序；主程序未运行、协议不兼容或数据目录不同时才在本进程初始化，可用 `--via auto\|app\|local` 控制。`pathql query` 是只读例外：忽略 `--via`，总在本进程以不迁移的只读 Storage 执行 |
| 外部集成 | 桌面 | 通过 app IPC 或应用 Web 服务器（JSON-RPC / SSE / 媒体 / MCP）连接主程序，不直接碰数据库 |

形态差异：**Web 版**的 `kabegame` 以 `web` feature 构建为无 Tauri、无 CEF 的控制台服务器进程，浏览器即前端；**Android** 只有一个 app 进程（系统 WebView 的渲染进程由系统管理），不开 app IPC 服务端，也没有 CLI；畅游使用独立 `SurfActivity`，外部内容页是该 Activity 的 Tauri webview（wry 的 `addJavascriptInterface` IPC 被换成只收主框架消息的 `addWebMessageListener`），顶部导航栏是原生 Kotlin 控件。

主进程内部，HTTP、Tauri、Web JSON-RPC 与 app IPC 只是协议入口，统一复用共享命令层，不建立平行业务后端；桌面端应用 Web 服务器复用 web JSON-RPC 注册表，并在同一端口提供 SSE、媒体文件与 MCP。相关类型、变量、事件、端点与文档统一使用 app / backend / IPC 语义。

**IPC 权限与事件**——主窗口与壁纸窗口的本地应用页免 ACL（`lib.rs` 的 `Builder::acl_exempt_webview("main" / "wallpaper")`，tauri 补丁 0017，只认本地来源的主 frame），新增只给它们用的命令只需注册进 `generate_handler!`；畅游、爬虫、网页壁纸调用的命令仍要写进对应 `permissions/*.toml`，它们能 `listen` 的事件名由 capability 里 `core:event:allow-listen` 的 `{ "event": … }` 作用域限定（补丁 0015）。capability 默认只对主 frame 生效（`frames`，补丁 0016，frame 由 runtime 经请求 extension 上报，页面无法伪造）。JS 事件按接收方 webview 身份投递，前端 `listen` 传 `target` 没有作用，`emit_to(<label>)` 只送到该 label 的 webview / 窗口（补丁 0014）。详见 [ACL 文档](cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md)。

**第三方补丁序列**——工作流与目录级约束见 [third-patches/AGENTS.md](third-patches/AGENTS.md)。一般预期third是脏的，third-patches才是我们工作的地方，除非bump跟上游。

**组件库与 packages 子仓库**——维护边界和目录级约束见 [packages/AGENTS.md](packages/AGENTS.md)。

**文件类型的唯一事实来源：**
- `kabegame_core::media::image_type::MEDIA_FORMATS` 是唯一的格式表，包含格式键、标准 MIME 值、扩展名、别名和支持标志。`images.type` 存储 `image/jpg` 和 `video/mov` 等格式键；仅在需要标准 MIME 的边界（HTTP Content-Type / Android MediaStore）使用 `mime_from_format`。
- 在 Rust 中使用 `kabegame_core::media::image_type::*`（例如 `is_image_by_path`、`supported_image_extensions`），不要硬编码扩展名或 MIME 值。前端使用 `get_supported_image_types` Tauri 命令；其 `mimeByExt` 的值仍为标准 MIME。
- `supported_video_extensions()` 始终返回内置视频列表。前端 `isVideoMediaType` 通过检查 `type.startsWith("video/")` 决定图库展示。
- 格式表也包含目录型条目 `x-wpe/video` / `x-wpe/web` / `x-wpe/scene`（`extensions` 为空，不可按扩展名摄入）：这类行的 `local_path` 是 Wallpaper Engine 壁纸**目录**；视频行的 `compatible_path` 始终有值（入口视频本身或兼容副本），所有播放端只走它；`x-wpe/web` 行 `compatible_path` 为空：桌面壁纸窗口由 `WindowWallpaperManager::set_wallpaper_path` 把自己的窗口整个导航到入口的 `file://` 加载（状态随 `WallpaperWindow` 对象走，无全局宿主）（CEF 补丁 0004 只对登记过的窗口开文件访问 + 运行时按当前根目录拦截 `file:` 请求；`file:` 文档照常注入 Tauri 脚本，IPC 按远程 `file:` 来源只给 `wpe-web-capability`，WPE 垫片 `wpe_shim.js` 经 `wpe_web_pull_state` 拉取作者属性与语言，导航成功后 `clear_js_listeners()` 清掉旧文档的 JS 监听），图库预览在主窗口里以 `file:` iframe 加载入口（`set_wpe_web_preview` 设好根目录后返回入口、前端赋 `src`；应用页能加载 `file:` iframe 靠 CEF 补丁 0005（主窗口建窗前 `allow_app_local_resources("main")`）），主窗口同样登记文件文档策略、按预览中的壁纸目录拦截（根目录由 `set_wpe_web_preview` 在预览挂载 / 卸载时设 / 清，拒绝壁纸窗口；iframe 里的垫片经 `postMessage` 由宿主页代为拉取、代为 listen），没有 HTTP 目录服务；图库媒体（原图 / 缩略图 / 兼容副本）在桌面 CEF 直接走 `file://`（CEF 补丁 0006 给应用页补 `file:` 子资源工厂，运行时闸门按发起 frame 分档：应用页主 frame 的子资源免检，子 frame 导航与 `file:` 文档仍按根目录；三个桌面平台的主窗口与壁纸窗口（只 Windows / macOS 有）都登记 0005），应用页 `fetch(file:)` 由 0006 私有 CORS 列表和运行时跨源白名单放行；复制兜底直接读取 `file://`，三个桌面平台的拖出都走 CEF 补丁 0003 的真实文件链路（Windows 为 `CF_HDROP`），Web 版保留 `DownloadURL`；插件文件由 Tauri `read_plugin_file` 命令读取，桌面不启动本地 HTTP 文件服务；**WPE 壁纸目前只提供 Windows 桌面**：macOS / Linux / Android / Web 不自动发现、不渲染网页壁纸，`x-wpe/*` 行只显示预览图；网页壁纸的用户属性存于 metadata 的 `userProperties`，改写走 `rewrite_image_metadata` 并发 `metadataId` 补丁；任何把 `local_path` 当文件用的地方都必须先按 `is_wpe_type` 分流（见 [WPE 导入文档](cocs/wpe/WPE_IMPORT.md)）。

**插件 PathQL 来源寻址**——`plugin://installed/<id>/<version>`、`plugin://byStore/<sourceId>/<id>/<version>`、
`plugin://byPreview/<token>/<id>/<version>` 统一提供 `icon` / `description_template` / `doc` / `changelog` / `asset` / `provider` / `recommended`。
根 fetch 保持已安装插件 lite 列表，根 list 只显示 `installed` / `byStore`；预览 token 不可列举。
资源 provider 只保存 `PluginCoord`，每次读取经 `PluginManager::resolve_plugin_file` 重新解析，版本不符为空；
商店来源只读本地 `store_plugin_cache`，任何子资源都不得下载或请求网络。各路径段单独编码，不保留旧的仅 id 路径。
详见 `.cursor/rules/plugin-resources.mdc` 和 `cocs/mcp/MCP_SERVER.md`。

**图片事件协议**——`images-added { seq, images: ImageInfo[] }` 只表示图片行插入，`images-deleted { seq, imageIds }` 只表示删除；字段变化统一按 id 合并为 `{ id, ...camelCase字段绝对值 }`，一张发 `image-changed { seq, patch }`，多张发 `images-change { seq, patches }`，空补丁不发。图片事件不再带 reason 或归属 id 列表；隐藏与收藏仅从画册成员事件推导；删除 / 清理任务时为原属图片发 `taskId: null` 补丁。前端按事件内容与查询 / 排序 / hide 判断相关性，不能证明无关就刷新；整理与迁移循环改造留待后续。

画册表按增删改对齐：`albums-added { seq, albums }` 携带完整行，`albums-deleted { seq, albums: [{ id, ancestorPath }] }` 只带被删根，`album-moved { seq, id, oldAncestorPath, newAncestorPath }` 只带移动根；其它字段按 id 合并为 `album-changed { seq, patch }` / `albums-change { seq, patches }`，补丁只含实际变化字段，永不含 parentId / ancestorPath。移动按前缀改写已持有的子孙路径，移动根的 parentId 取新路径倒数第二段。成员真实增删发 `album-images-added` / `album-images-deleted`，`album-images-change` 只表示实际改序，均为 `{ seq, albumId, ancestorPath, imageIds, imagesDeleted? }`；无 reason、hide/unhide 派生事件或按隐藏状态拆分。隐藏 / 取消隐藏只是隐藏画册自身的成员增删，不带其它画册与图片行：hide 开启的观察方一律刷新，关闭时只按 imageIds 打 isHidden 补丁；整行删图引起的成员删除带 imagesDeleted: true，不作为取消隐藏补丁。删画册不补发空排序事件，写命令不再返回 albumChanges。

**ImageGrid 视图写操作**——可能改变当前结果集的写操作必须经 `ctx.mutate(() => ...)`；写命令不带 `view`、不返回快照、照常广播事件，`mutate` 在操作完成后作为用户操作请求行与总数，结果仍从数据源落地。行与总数是 `services/kbEvents` pathql 核心上某个 key 的观察方（`usePathqlLooker`，行读 `pathql_fetch`、总数由 `useLookAll` 观察 `pathql_all` 计数批（分子与 adapter 可选分母在同一读快照中读取）），只看数据不发请求：观察方注册过滤器（adapter `refreshOn`，每条只对一种事件），新增按完整行与查询判断（任务 / 畅游另比归属，画册由成员事件刷新）；字段补丁按 `imageViewRelevance` 依赖表判断，表外字段保守刷新；ImageGrid 用 `deletedTrigger` 追加删除判断：行只在当前持有行命中时刷新，总数与其它只有计数的观察方默认任何删除都刷新；画册 adapter 标记 `deletesViaMembership`，总数只由本画册成员删除定位，不追加全局删除触发。核心对每个 key 用统一 500ms 窗口，窗口内任一过滤器同意就刷新一次并推给全部观察方。唯一请求入口是 `pathqlRequest$.next([kind, key])`，next 即返回、不等待；主动请求只有事件窗口与用户操作（路径变化、手动刷新、`mutate` 等）两条通路，前端不区分操作是否写入。每个 key 维护 pending 窗口：序号递增、可并行，任一请求返回即取消它之前的全部 pending；观察方看到最后可得的数据，`loading` / `error` 只属于最新请求，失败统一经观察方 `onError`。只改展示字段的操作走 `ctx.patch`；后端字段补丁经 `kbEvents` 的 `imagePatches$`（`image-changed { patch }` 与 `images-change { patches }` 共用字段补丁窗口，收藏与隐藏画册的 `album-images-added` / `album-images-deleted` 分别推导 `favorite` / `isHidden`、各自合并成 `imageId → 字段`，只打到已在手的行与预览对象，不发请求；必须传 `patchHidden`，网格在 hide 关闭时才打隐藏补丁，hide 开启时由成员事件刷新剔除，裸 id 预览始终打补丁且字段事件不重解析）。收藏在普通视图只补丁，收藏画册自身、无画册条件与树系统区 / 相应侧栏才刷新；有效标签搜索无法判断成员画册类型，仍对所有成员增删保守刷新。画廊、任务与畅游共用 `noAlbumTriggers`（跳过隐藏与带 `imagesDeleted` 的成员删除），四个网格共用 `labelSearchTriggers`。画册网格不听自身改名 / 移动，排序只在 `by-album-order` 下刷新；裸 id 预览与标签面板跳过收藏 / 隐藏及排序的重读。前端不再有全局事件聚合器或本地事件投递：写入方只请求自己观察的 key，其它观察方等后端事件。预览内的 `ImageLabelsPanel` 标签增删不走 `mutate`（避免替换底层列表跳页），面板作为自身 key 的观察方在增删后请求，详见 `.cursor/rules/view-mutation.mdc`。

**插件变更事件与推荐导入态**——事件统一为 `plugin-added` / `plugin-changed` / `plugin-deleted`。
`plugin-changed` 使用 `{ pluginId, changes }`：覆盖安装传必含 `version` 的完整插件 JSON，推荐导入态只传
`recommendedConfigs: { <path>: { imported } }`。运行配置 add / update / delete / copy 经 core 共享命令比较写前后状态，
范围为受影响 id 的已安装包与本地有包的商店缓存，不触发下载；每次写入每插件最多一条，仅含变化路径，优先取已安装新状态。
写库提交后先发推荐导入态的插件事件，再发配置事件。插件 store 只合并含 version 的变更；推荐配置通过 `useRecommendedPresets` 观察来源版本路径的 `recommended` rows，
只对同插件含 `version` 或 `recommendedConfigs` 的事件刷新，新 key 请求一次，失败保留已有内容。详见 `.cursor/rules/plugin-resources.mdc`。

**运行配置写操作**——新增、导入、复制、编辑、定时开关和删除统一经 `services/runConfigWrites.ts`，命令只接收业务参数，直接返回保存后的单行（删除返回 null），写库提交后照常广播事件。列表由 `usePagedRunConfigs` 作为一个 `usePathqlLookAll` 观察方，同批读取累计窗口行与总数；`start` / `loadMore` 通过 `pathqlRequest$` 发请求，加载更多以已落地页加一为目标，失败重试同一个 key。写后不主动刷新，`auto-config-change` 与任务刷新信号由核心统一 500ms 窗口重读；任务新增带 runConfigId、任意状态变化和删除为刷新信号，张数、错误与结束时间只补丁 `lastTask.id` 匹配行的展示字段。页头失败数观察 `run_configs://last`，详情弹窗观察编码后的 id 路径；任务列表同批观察累计窗口与总数，新增 / 删除 / startTime 变化刷新，进度等 diff 就地补丁；状态计数观察 tasks://status，新增 / 删除 / status 变化刷新；详情观察任务 id，删除重读、其它 diff 补丁。任务关联配置名直接订阅配置事件，无代数号或缓冲，改名按 id 读取、删除清空；抽屉删除 / 清空成功后只请求自身列表与计数 key。IPC 与 CLI 保持原请求及单行/null 返回，配置事件的全局 `seq` 保留但观察方按前端请求序号落地。详见 `cocs/downloader-tasks/TASK_DRAWER_LOAD.md`。

**画册数据按需查询**——前端不得持有全量画册列表或全量计数。树与选择器统一复用 app 侧 `AlbumTreeView` / `AlbumPicker`，按目录分页查询 `albums://`（过滤段 `parent/<id>` / `roots` / `album_kind/<kind>` / `search/<q>` 各折叠一条 where，多个类型用 `~any/.../~or/.../~end` 取 OR；末尾 `x<页大小>x/<页码>` 切页，默认按创建时间排序，分页节点不得重写过滤；搜索不另起平铺列表，树的每层与 `~~/children` 都叠加 `search/<q>`，自身或子孙命中才保留）。树数据源 `TreeQuerySource` 只描述查询、解析与单事件 `refreshOn`，模型用 `usePathqlLookMany` 观察每个可见分支的已加载页，一页一个 `pathqlAllKey`，只经 `pathqlRequest$` 发请求。收起停止观察、保留句柄和数据，再展开重读；换 key 或读取失败保留上一份子项。侧栏隐藏停观察、恢复整组重读；高级查询的候选树在下拉面板里、事件过滤器为空，每次展开读一次、打开期间不随事件刷新，不另设纯净列表缓存。`expand` / `loadMore` / `refresh` 的 Promise 由模型自己的等待表完成，核心不提供请求并等待。

计数：结构页以一批 `pathql_all` 同快照读取画册行与 `…/~~/children[/<类型段>]` 的 `child_count`；`TreePage.extra` 独立批次读取本页行（用于零计数补齐）与 `…/~~/images[/hide]` 的 `image_count`。两种分组均在 `~~` 子查询边界之后按画册 `GROUP BY`，不使用 `list_with_count`。行与子画册数先渲染，图片计数按 key 打补丁并在结构刷新后保留；标签目录显示直接子画册数，图片查询不为标签目录出行。成员事件只刷新相关可见目录的 extra：普通分区按根节点归属判断（根未知保守刷新），系统区只认收藏 / 隐藏；带 hide/ 的计数对隐藏成员增删整体刷新，隐藏画册带 imagesDeleted 的删除交给各原属画册定位。排序不刷树计数，字段补丁只刷已持有行的 page；增删移动按路径刷新行与 extra；路径缺失按通配，移动同时考虑新旧 `ancestorPath`，某父目录只匹配严格后代。口径与 `images://gallery/[hide/]album/<id>`、`album-tree/<id>` 的 entry 总数一致；子树判断用 `ancestor_path` 前缀区间走索引（见 `cocs/provider-dsl/RULES.md` §2.1）。画册页头部用 `useAlbumQuery` 观察两个 `all` key：详情 / 祖先 / 子树数同批，图片计数按落地类型独立观察；事件以自身完整 `ancestorPath` 判定祖先链或严格后代，用户刷新由 composable 等待两段请求完成。页头详情只关心自身补丁与祖先结构补丁、子孙增删移动；计数按类型：label_dir 只听直接子画册结构增删移动，label 只听自身成员增删，其余听子树成员增删、严格子孙删除及跨子树边界移动，改名与空子画册新增不刷新图片计数。其它一次性读取仍用 `services/albums.ts`，不得新增全量 store。隐藏等全局过滤只能用路径表达，不得新增计数列、SQL 视图或专用计数命令。

**桌面端和 Android 端的视频导入都使用 rsmpeg/FFmpeg（仅排除 iOS）：**
- 桌面端构建（Windows/macOS/Linux 上的标准版/CLI）会链接 rsmpeg/FFmpeg，用于预览图压缩和视频尺寸读取（使用 `deno task build:ffmpeg` 产生的本机静态库）。
- **Android 也会链接 rsmpeg/FFmpeg**——aarch64 静态库由 `deno task build:ffmpeg --target android` 交叉编译（使用环境中的 NDK；输出位于已被 git 忽略的 `bin/android/arm64/FFmpeg-build/`，可通过命令重现，不会提交）。`rsmpeg`/`rusty_ffmpeg` 使用 `cfg(not(target_os = "ios"))` 条件门控。
- 预览格式因平台而异：**桌面端** = H.264 MP4（网格使用 `<video>`，悬停时自动播放）；**Android** = 10fps 动画 **GIF**（`run_ffmpeg_gif`：`fps,scale,palettegen,paletteuse`），因为 Android 网格不存在悬停交互，静态 `<video>` 帧没有作用——前端会将它显示在 `<img>` 中（`ImageContent.vue` 的 `mode==='gif'`）。Android FFmpeg 构建会启用 GIF 编码器/封装器以及 palettegen/paletteuse/fps 过滤器。
- Android 通过 `ContentIoProvider.open_fd(uri)`（PickerPlugin 中的 `openFileDescriptor().detachFd()`）读取 `content://` 视频，然后由 FFmpeg 打开 `/proc/self/fd/N`。绝不能将 `content://` URI 当作普通路径，也不能先将其落盘。视频**尺寸**仍来自 `ContentIoProvider.get_video_dimensions`（`MediaMetadataRetriever`），而非 FFmpeg。
- `mode-plugin.ts` 会注入 Android FFmpeg 环境（`FFMPEG_PKG_CONFIG_PATH`、`FFMPEG_LINK_MODE=static`、包含 NDK sysroot+target 的 `BINDGEN_EXTRA_CLANG_ARGS`、`PKG_CONFIG_ALLOW_CROSS=1`、NDK 交叉链接器/CC）。支持 `deno task check -c kabegame --mode android`（实际运行 `cargo check --target aarch64-linux-android`）。参见 `cocs/downloader-tasks/VIDEO_INGEST.md`。

**Android 模态层**——所有覆盖层（对话框、抽屉、ActionSheet、预览）都必须调用 `@/composables/useModalBack` 中的 `useModalBack(visibleRef)`，以便 Android 返回键按堆栈顺序关闭各层。该 composable 在桌面端为空操作；无论平台如何，都应在所有相关位置使用它。

### 样式
新样式应使用 **UnoCSS 工具类**（在 `uno.config.pub.ts` 和 `apps/kabegame/uno.config.ts` 中配置，使用 `presetWind3`——兼容 Tailwind 语法）。仅为复杂动画或第三方覆盖编写 `<style>` 块。将重复的类组合提取为 `uno.config.*.ts` 中的快捷方式。

### 平台特定说明
- **Windows/macOS/Linux**：使用虚拟磁盘（Dokan / macFUSE / FUSE）挂载图库
- **Windows/macOS/Linux 标准版**：使用 CEF runtime 后端。三个平台都会在构建时链接 CEF，并通过 exe 旁边的扁平 `kabegame-cef-helper` 启动子进程（macOS 开发模式运行裸可执行文件；release 包通过 `macOS.frameworks` 嵌入 framework，通过 `macOS.files` 嵌入 helper）。
- **Android 身份分离**：identifier（applicationId）按模式区分——dev 为 `app.kabegame.dev`，prod 为 `app.kabegame`（可并排安装）——而 Java package/源码树保持固定为 `app.kabegame`（`namespace`）。该能力由 fork 版 `cargo-tauri` 实现（上游 Tauri monorepo 位于 `third/tauri`，由 `third-patches/tauri` 修补——请先运行 `deno task patch tauri`；遵循 `TAURI_ANDROID_PACKAGE`；从 `crates/tauri-cli` 构建，并由 `TauriCliPlugin` 注入 PATH）。绝不要从 identifier 重新推导 Kotlin package 名。参见 `cocs/tauri/TAURI_CLI_FORK.md`。

### 爬虫插件开发
插件是 JS/TS 脚本（V8 后端，自包含 ES 模块 `export async function crawl`），打包为 `.kgpg` ZIP 归档。参见 `docs/PLUGIN_FORMAT.md` 和 `cocs/crawler/V8_RUNTIME.md`。新写或修改插件**用 `kabegame-plugin` skill**（`.claude/skills/kabegame-plugin/`）：先用探针逐环实测「页面 → 结构 → 媒体」链路，再写代码，V8 插件打包到 dev 插件目录后由 release 或 dev CLI `plugin run <kgpg> --id <测试id>` 直接验证，WebView 插件也支持。使用以下命令构建：
```bash
deno task --cwd src-crawler-plugins package --out-dir ../.kabegame/debug/data/plugins-directory        # 打包所有插件到开发目录
deno task --cwd src-crawler-plugins generate-index  # 重新生成插件商店索引
```

## 命令

详细用法与验证约束见 [scripts/AGENTS.md](scripts/AGENTS.md)。

- `deno task dev`：（最常用）启动指定组件的开发模式。
- `deno task dev:frontend`：只启动 Kabegame 前端开发服务器。
- `deno task start`：运行已有构建产物。
- `deno task b`：（次常用）构建主应用、CLI 或指定组件。
- `deno task build:web`：构建 Web 发布版。
- `deno task check`：执行前端类型检查和 Rust `cargo check`。
- `deno task test`：执行前端 Vitest 和后端 Cargo 测试。
- `deno task format`：格式化前端源码。
- `deno task format:check`：检查前端源码格式但不写入。
- `deno task pathql:generate`：生成 PathQL TypeScript 客户端。
- `deno task patch`：重置或应用 `third-patches` 补丁序列；`--gen --from <x> --out <file>` 只读工作树、不 reset，生成系列之外的剩余改动为新 patch。
- `deno task build:ffmpeg`：构建桌面端或 Android 的 FFmpeg 静态库。
- `deno task build:chromium`：构建 CEF/Chromium 运行时。

### 计划与变更说明格式
编写计划或描述代码变更时，按明确的**点**来组织内容。每个点下面按**新增 / 修改 / 删除**分组，每项可选择附带缩进说明。将现状与变更分开：
- **总体设计思路**必须放在**最前面**，位于现状锚点之前。应使用散文，而非检查清单——用几段话说明方案的整体形态：新机制是什么、组件边界如何移动、变更后数据向哪个方向流动，以及支撑整个设计的关键决策与其理由。读者必须能在读完该节后直接停下，并正确解释这个设计。不要以现状或点 1 开头。
- **现状**部分展示从实际代码中截取的代码块（不能只写 `file:line`），并通过注释说明**代码当前的样子**（而不是将要发生的变更）。
- **实施方案**中的各点应包含目标代码块，并用注释准确标出新增、修改或删除的内容。

````md
### 总体设计思路
把 `Foo` 的进度从「writer 自己算」改成「writer 上报、reader 汇总」:writer 只在 `Foo`
里累加已写字节,不再持有 UI 相关状态;汇总与展示全部下沉到 reader 侧。
关键决策:进度字段放在 `Foo` 而非新建并行结构,因为 `Foo` 已经是该数据的唯一属主,
新建结构会带来两份状态需要同步。

### 现状锚点
**a. `Foo`**(`foo.rs:64`)
```rust
struct Foo {
    bar: u32,   // 现状:只有 bar,没有进度字段
}
```

### 点 1 — 给 `Foo` 加字段(`foo.rs`)
- **修改**
  - `Foo` 增加 `received: u64`。
    > 说明:供 writer 上报进度。
```rust
struct Foo {
    bar: u32,
    received: u64,   // 新增
}
```
````
对主仓库在进行更改后要把回归补充到 [回归文档](versions/latest/regression.md)，格式参考 [4.5.1版本回归](./versions/v4.5.1/regression.md). 以及一行或几行 [changlog](versions/latest/changelog.md)，并在当前环境尽量真机勾选case。

对插件的更改要写到 [插件changelog](./src-crawler-plugins/CHANGELOG.md)，总插件仓库版本号 4.5.1.x 表示在主应用发版 4.5.1 和 4.5.2 之间的迭代版本。如果主应用发版到 4.5.2 就会跟着更新到 4.5.2，然后如果继续更新就是 4.5.2.1。src-crawler-plugins/package.json 里的 version 是其最新版本，所以changelog.md要比较才知道顶部版本是最新还是需要新加一节，注意不要改 version，改了之后commit 会打新tag。

**应用日志一律用 `tracing` 宏**（`error!` / `warn!` / `info!` / `debug!` / `trace!`，不加 `[模块]` 前缀，模块路径即 target），不要再写 `println!` / `eprintln!`；前端用 `@/utils/logger`。日志按天写入 `<data_dir>/logs/`，经事件循环的 opt-in `log` 事件推给工具箱「查看日志」、`kabegame-cli log tail` 与 Web super 的 `/logs`；事件管线上的逐事件日志只能用 `trace!`，否则会自激放大。细节见 [cocs/debug/APP_LOGGING.md](cocs/debug/APP_LOGGING.md)。

在需要真测的时候用 `.claude/skills/kabegame-chromium` 技能连接正在运行的程序操作界面，只有在需要打开外部网站或调试web版本才允许用 ageng-browser。

**观测运行时调用（IPC、事件、加载次数）一律用 debug ingest 插桩**（[cocs/debug/DEBUG_INGEST.md](cocs/debug/DEBUG_INGEST.md)：前端 `sendDebugEvent`、Rust `kabegame_core::kb_debug!`——两者都只是 trace 日志，由 debug 构建的订阅层转发到 dev server——固定 `session_id`，读 `.kabegame/debug/debug-<session_id>.ndjson`）。**不要**经 CDP 去包装 `window.__TAURI_INTERNALS__.invoke` 来计数——它是不可写、不可配置的属性，赋值在非严格模式下静默失败，计数永远为空，会被误读成「没有发生调用」；CEF 下普通 invoke 也不走 `fetch`，抓网络请求同样看不全。上报是异步的，日志行的到达顺序不等于调用顺序，排先后要看事件自带的 `ts`。临时插桩统一带 `// DEBUG-<主题>` 注释，验证完删除。

为 README、教程或操作指南编辑真实界面截图时，用 `.claude/skills/annotate-ui-screenshots` 技能添加短标签和箭头、生成带 `-annotated` 后缀的资源，并同步精简与图片重复的正文。保持真实 UI，不使用生成式重绘。

## 语言规范
所有与用户的交流均使用简体中文。
任务计划、进度说明、问题分析、调试结论和最终回答均使用中文。
工具调用前后的说明使用中文。
代码标识符、终端命令、文件路径、API 名称和原始错误信息保持原语言。
代码注释默认使用中文，除非当前项目已有明确的英文注释规范。
不要因为代码库、日志或文档是英文而切换成英文回答。
