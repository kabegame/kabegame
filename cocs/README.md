# cocs 文档索引

本目录用于沉淀 Kabegame 的关键流程、架构约束与迁移说明。  
当需要理解某个模块时，建议先从本索引定位文档，再按文档中的“涉及文件”阅读代码。

专题文档按主题放在子目录中；**索引条目一律链到具体 `.md` 文件**，便于一键打开。

Rust 应用、共享库与自定义 Tauri 插件统一位于 `src-tauri/`；插件目录为 `src-tauri/tauri-plugin-<name>/`。完整目录结构见 [架构与项目结构](../apps/docs/src/content/docs/dev-contrib/architecture.md)。

## 阅读顺序建议

1. 先看本索引，定位目标主题。
2. 进入对应文档了解流程与边界。
3. 再打开文档中引用的代码文件做实现核对。

## CLI（`cli/`）

- [cli/CLI_IPC.md](cli/CLI_IPC.md)
  - 主题：`kabegame-cli` 的 app 优先/local 回退进程模型，`Backend` 抽象、`--via`
    选择、`ipcProtocol` / `dataDir` 门控、`PluginRun` 共享实现、`--print-config` / 任务级 dry-run、逐任务下载并发的
    `TaskSetMaxConcurrentDownloads`、`local-import` 任务、`pathql query` 本进程只读 Storage、
    CLI 禁用 metadata 迁移、`KABEGAME_SQL_DEBUG` 以及 `IpcClient` 连接/事件语义。
  - 适用场景：新增 CLI 数据命令、IPC 协议变体，或排查 CLI 与运行中主程序的数据/任务差异、
    PathQL 实际 SQL 与耗时。

## Provider DSL（`provider-dsl/`）

- 状态：基于 SQL 的内置 Provider（root/gallery/shared/VD）均由 `dsl_loader::DSL_FILES` 中的 DSL 提供；
  唯一保留的 programmatic provider 是 `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs`
  （`plugin://` schema，按 `installed/<id>/<version>`、`byStore/<sourceId>/<id>/<version>`、
  `byPreview/<token>/<id>/<version>` 寻址；预览不可列举，商店只读缓存，元数据来自 `PluginManager`，recommended 行附带 Storage 当前导入态；不走 SQL provider），由 `providers/init.rs` 经
  `register_programmatic_provider` 注册。

- [provider-dsl/RULES.md](provider-dsl/RULES.md)
  - 主题：声明式 Provider DSL（v0.7）的加载期与运行期语义合约 —— schema 之外的规则。涵盖文件格式（json5 / YAML 双 loader，按扩展名选择；长 SQL 用 YAML `|-` 块标量换行书写及其禁忌）、路径折叠、ContribQuery 累积语义（fields/join/where/group_by/order 各自规则；排序项仅 `{sql, order: asc|desc, prepend?}`，全局排序指令为 `{all: revert|clear}`；offset 累加、limit 末次胜；schema 只登记数据表名、`plugin://` 走程序化 schema）、**`where` 的 WhereQuery 谓词树**（字符串=原子 / 数组=OR / `{not}`=取非；fold 期坍缩成一条，树上无 AND 节点；`where_clear` 按坍缩串整棵匹配）、嵌套目录清除上一层等值条件、分页写法（列举子项在 `list.sql` 里 bind 分页；`albums://` 等本地路由的行分页仍用 `x<N>x/<页>`，画廊续接用全局 `_kb_x<N>x/<页>`；分页节点只切页）、**全局前缀表**（`register_global_table`、本仓 `_kb_` 与 `kb_global.json5`、全局表优先解析及 provider key 缓存失效）与 **Resolve 透传条目 `passthrough: true`**（只折叠目标 query、current 不变，`_kb_co` 必须放在维度路径末尾）、**子查询边界 `~~`**（此前查询冻结成物化 CTE FROM，内层 ORDER BY/LIMIT 保留，外层不重放根贡献；配合 `group_by` 按外层行计数；物化顺序支撑 rank 定位；`~~<别名>` 把内层挂到别名下、表名留给外层回表，用于不可走索引排序的延迟回表；画廊实际路径为 `filter/…/~~/rank/~~p/lookup/gallery`，外层按序号取序）、**路径 WHERE 组合器 `~any`/`~or`/`~not`/`~end`**（分支旁路、组内只许 where + LEFT JOIN、`\~` 转义、尾部不自动闭合）、List 静态/动态项、`${...}` 模板、`as + in_need`、缓存、安全、保留标识符（`~` 与 `_kb_` 前缀）和主机协调模式；以及**插件 provider 与宿主的 `plugin_im` 约定**（§3.3.2：宿主只 join 不投影，插件 where 读 `plugin_im.data` 并包 `COALESCE`，`list.sql` 自行 join `metadata`，这样细分条件才能进 `~any` / `~not`）。
  - 适用场景：实现引擎 loader / 解析器；随机 / 名称等排序翻深页慢、想让内层只排 id 再回表；编写 *.provider.json5 / *.yaml 文件；编写或迁移插件的 extend provider；调整 `_kb_*` 全局续接段、透传或排序链；给 where 写 OR / NOT；分页之后按行计数（`~~` + `group_by`）或排查子查询慢；排查解析优先级、缓存失效、跨字段约束、组内贡献或未闭合组错误；设计第三方插件可贡献的 provider。
  - 配套：[../src-tauri/kabegame-core/src/providers/schema.json5](../src-tauri/kabegame-core/src/providers/schema.json5) 为语法 schema。

- [provider-dsl/VD_INTEGRATION.md](provider-dsl/VD_INTEGRATION.md)
  - 主题：VD 作为 Provider DSL 引擎**消费者**的落地方案。涵盖 i18n 路径分发（`i18n-<locale>` 静态层 + 每语言独立 router）、插件维度的 `get_plugin` SQL 函数桥（主机注册的 SQL 函数把 PluginManager 元数据和按 locale 解析的 `displayName` 接入 SQL 上下文）、`vd_plugins_router` 与 `plugins_provider` 双层结构、典型路径折叠示例。
  - 适用场景：新增 / 修改 VD 维度路径树；接入需要主机协调的非 SQL 数据；理解 i18n 切换、插件装卸的缓存行为。

- [provider-dsl/ALBUM_SUB_TREE.md](provider-dsl/ALBUM_SUB_TREE.md)
  - 主题：`albums://by_sub_tree` 的按名称递归画册树查询，以及 CLI `--album` 通过父路径直接子项解析目标画册 id 的契约。
  - 适用场景：导入图片时按 `/父画册/子画册` 定位画册；新增或排查 albums 子树 PathQL 路由。

## MCP（`mcp/`）

- [mcp/MCP_SERVER.md](mcp/MCP_SERVER.md)
  - 主题：桌面端应用 Web 服务器的统一监听器、浏览器拒绝边界、JSON-RPC/SSE/媒体/MCP 路由，MCP URI path/read 与 tool/write 能力体系、`list_pathql_entry` 懒树发现契约、不可列举的 `_kb_*` 全局续接段，以及画廊末两段 `_kb_x<N>x/<数字>`（原始 images 根仍用 `x<N>x/<数字>`）的 500 行分页护栏；并说明为什么不能在 `gallery_all_router.json5` 加 limit。
  - 适用场景：新增或排查桌面 Web 服务器、RPC/SSE、MCP 资源/工具/能力开关；维护 PathQL 发现、全局段说明与分页护栏；避免用 DSL LIMIT 破坏全局 COUNT、前端总数和页数。

## Web 版（`web/`）

- [web/CDN_MEDIA.md](web/CDN_MEDIA.md)
  - 主题：Web release 的媒体路径 CDN 转写边界，原图、缩略图、浏览器兼容副本与壁纸兼容副本的字段映射，以及线上 `images` / `thumbnails` / `compatibles` 必须同时指向 OSS 挂载的部署约束。
  - 适用场景：Web RPC 返回服务器本地路径、CDN 媒体 404、调整媒体字段或迁移线上媒体目录。

- [web/RPC_TRACKING.md](web/RPC_TRACKING.md)
  - 主题：Web 前端使用 `/rpc/{method}` 让浏览器可按方法过滤请求，服务端保留 `/rpc` 兼容入口；两种入口都发以方法名命名、url 为 `/rpc/<方法名>` 的 umami 事件（data: method / ok / code / ms），不读取、不转发客户端请求头；`web` feature 门控，由 `KABEGAME_UMAMI_*` 环境变量开启（systemd drop-in）；有界队列丢弃策略、`no_proxy` 直连，以及 umami isbot 会静默丢弃 `名字/版本` 形式 UA 的坑。
  - 适用场景：在 demo 服务器开启或排查接口埋点；umami 里看不到接口事件（未配置环境变量、返回 `beep`、走了代理）；新增需要统计的服务端入口。

## 畅游（`surf/`）

- [surf/ANDROID_SURF.md](surf/ANDROID_SURF.md)
  - 主题：Android 畅游架构（Phase 1 + Phase 2 + Phase 3）。涵盖内容页作为 `SurfActivity` 的 Tauri
    主 webview（label `surf-<host>:<n>`，与桌面共用注入脚本与按 label 认会话的命令）、原生 Kotlin
    工具栏（导航状态置灰、真实加载进度、「更多」菜单）、`SurfRegistry` 双向会合与 `ipcAvailable`
    回传、Rust 单会话权威状态、移动插件命令与 Channel 事件、
    wry `addJavascriptInterface` 换成只收主框架消息的 `addWebMessageListener`、注入脚本顶层守卫、
    多窗口与 OAuth 弹窗覆盖层（链接回内容页、脚本开窗走普通 WebView、最多一个、返回键顺序、
    `SurfChromeClient` 转发清单）、按站点的桌面版网站与 UA 配对（`surf_records.desktop_mode`、
    `android_desktop_user_agent` 唯一派生、`requireCookie` 替换默认 UA、下载补头随会话模式、WebView 爬虫宿主按建窗地址跟随）、
    脚本下载与页面自发下载共用 `enqueue_surf_download` 并补 Cookie/UA/Referer、apk 安装包与压缩包
    提前拒绝不解压、raw body 的安卓形态（分块写走 `{ base64 }`、MSE 分片合并、数字数组兼容）、
    关闭与配置变化重建时手动释放内容 WebView（主界面同理）、重建后 binding 交接、应用内 WebView
    共用渲染进程须各自处理 `onRenderProcessGone`、Cookie 合并保存与系统 WebView 默认 UA 登记、
    安全边界、桌面快捷方式（intent 经 `MainActivity` + 只带 host、冷启动 Channel 收件箱、重放保护、
    favicon 自适应图标与删除后禁用、国产 ROM 静默拦截）、已知 Channel 生命周期（tauri 补丁 0011）与 tao JNI 局部引用残留。
  - 适用场景：新增或排查 Android 畅游启动/关闭、原生工具栏地址 / 一键下载状态 / 后退前进置灰 /
    加载进度、返回键、登录态保存、第三方登录弹窗无反应或弹窗不关闭、`target=_blank` 被误弹覆盖层、
    插件请求的 Cookie/UA 配对（403、`cefUserAgent()` 为 `null`、桌面模式下仍 403）、站点强制跳应用
    商店或下 apk、页面下载被拒或类型误判、`blob:` / MSE 分块写失败或很慢、关闭畅游后页面仍在后台运行
    或内存不回落、用 CDP 测试时页面下载回调不触发、Activity 重建后出现两个主界面页面、旧页面 `invoke`
    挂起或工具栏失效、外部页面崩溃连带应用闪退、外部页面意外获得 IPC，或桌面快捷方式不出现 / 点开没进畅游 / 旋转后重复打开。

## 画廊与查询（`gallery/`）

- [gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
  - 主题：Gallery/VD 共用的 Provider + ImageQuery 可组合查询系统与前端唯一查询对象 `GalleryQuery`。涵盖 `gallery_router` 窄路由与 `gallery_route` 字段层拆分、宽入口在组外折默认排序、行分页后 rank 取序与 lookup 回表（子 provider 全部回指窄路由）、四个页面共用的查询行、搜索表达式与高级条件持久化边界、宽高比生成列和区间段、**维度列举带分组计数**（过滤树列举 `{维度路径}/_kb_co` 并读 `meta.count`，插件扩展读插件 router 的 `meta.image_count`、缺失不显示，面板顶层直接列维度子项、没有根节点与根 COUNT）、侧栏树的逐页 pathql 观察 / 可见分支刷新 / 隐藏停观察 / 插件签名刷新、Phase F 的画册敏感上下文（album / album-tree / no-album / 标签搜索，hide 单独门控）、高级查询 diff 逐候选预测与常驻候选观察，以及收藏 / 隐藏标记的相关 EXISTS 取舍。
  - 适用场景：新增过滤、排序、数据源；排查 provider 查询路径或高级查询路由；排查过滤树或 MCP 的列举计数与筛选结果不一致；排查侧栏下载中不刷新、隐藏期补刷、插件增删后候选不更新或高级查询 `+N/−N` 刷新时机；排查宽高比分桶、排序、收藏 / 隐藏标记或 `hide` 计数性能。

- [gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md](gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md)
  - 主题：画廊 SimplePage 分页与每页条数（100/500/1000）的前后端数据流；路由只保存不含分页尾的 `viewBody`，`usePagedGallery` 本地持有页码并通过唯一的 `withPaged(viewBody, pageSize, page)` 生成 `rowsPath`，页大小唯一来自 `settings.galleryPageSize`，改变时保持旧页首张图位置；行取数出口通过 `toLookupRowsPath` 转为 `filter/…/~~/rank/~~p/lookup/gallery`（分页路径仍供 loadedKey / 校验 / 定位，rows 观察方使用转换后的 key），`pathql_fetch` 行读取与 `pathql_all` 计数批分开维护，计数批在阻塞线程钉住连接并开读事务，分子与 adapter 可选分母同一 WAL 快照，按序返回、整批失败（非 SQL 的 `plugin://` 不受快照约束），翻页只读行；ImageGrid 经 `services/kbEvents`（rxjs）维护行与总数：事件源 `kbEvent$` 与 pathql 核心 rows / all 数据源分离，行读 `pathql_fetch`、总数由 `useLookAll` 观察 `pathql_all` 计数批，ImageGrid 向工具栏注入 `{ total, unfilteredTotal }`，唯一请求入口 `pathqlRequest$.next` 即发即返回，主动请求只有事件窗口与用户操作（路径变化、手动刷新、`ctx.mutate` 完成后）两条通路，每个 key 维护 pending 窗口（任一请求返回即取消更早的 pending），观察方只看最后可得的数据与最新请求的 loading / error；adapter `refreshOn` 每条只对一种事件（写命令不再带 `view` / 返回快照），`ctx.patch` 就地改行，后端字段补丁经 `imagePatches$`（单图 / 多图补丁共用窗口，收藏与隐藏成员分别防抖合并，ImageGrid 与预览弹窗共用）；`images-added` 携带完整行、`images-deleted` 只带 id，`image-changed { patch }` / `images-change { patches }` 按图片数量分流，同流补丁按字段依赖 / 查询 / 排序判断是否触发查询，新增按顶层条件与归属判断，网格行删除只比较当前持有行、总数默认对任何删除刷新，画册以 deletesViaMembership 改由本画册成员删除定位；隐藏只发成员事件，hide 开启不打灰而刷新剔除，裸 id 预览字段只补丁；删除 / 清理任务发 taskId 置空补丁并离开当前任务详情；500ms 批次合并、行/总数独立 `seq`、画册 `ancestorPath` 相关性、wildcard 粗过滤和防闪回协议；Phase E 的画册行增删、移动与单条 / 批量补丁，成员增删 / 排序分流、隐藏即隐藏画册自身成员增删（hide 开刷新、关时只打 isHidden 补丁，删图用 imagesDeleted 区分），已持有子孙的路径前缀改写；Phase F 收藏只补丁、无画册 / 标签搜索共用触发、页头按画册类型计数与树分区刷新；写入方只请求自身 key（无本地事件投递）、预览标签面板的观察方例外，以及画册目录由 `~~/children`、`~~/images` 的 `GROUP BY` 计数行与 `album-tree` 按需组合计数；**列表不带 `metadata`**与 per-page 缓存；**预览深链接与后台刷新跟页**由 `images://<视图>/~~/rank/~~/id_<id>` 给出该图在当前排序下的 1 起序号，前端除以页大小跳页；定位和目标页加载期间保留原 `ImageInfo`，快照找到同一 id 才更新对象以保留缩放；各 sort provider 以 `images.id` 收尾保证全序。
  - 适用场景：排查翻页/总数、删除后未立即更新或旧列表闪回、下载/同步后不刷新、任务/畅游事件过滤、`seq` 过期结果、SimplePage 与 VD Greedy 差异、详情 metadata 缓存，以及带 `pvwimgid` 的深链接没有跳到目标图所在页、并列排序下定位落到相邻页、或预览切图时弹窗先关闭再打开。预览协调不对称：目标 id 在当前快照里就直接采用（切图不经过 `null`，避免读取在途时弹窗先关再开），不在时才等当前路径快照应用与 `rowsQuery.loading` 结束再定位或降级；URL 先记目标 id，目标页确认后才显示，已有预览保持对象和缩放。

- [gallery/LABEL_ALBUMS.md](gallery/LABEL_ALBUMS.md)
  - 主题：标签森林由内部节点 `label_dir` 与叶子 `label` 组成；目录只能装子画册、叶子只能挂图。涵盖同级 key（不区分大小写）唯一、v031 的 `label_key` / 派生列 `label_path`、目录/叶子按 PathQL 列举计数、`storage/labels.rs` 标识符规则、`ensure_label_path` 的目录段/叶子寻址与类型冲突逐项跳过、标签来源、`search/label` 的完整路径子串匹配与不相关 `IN` 子查询写法（为何不用相关 EXISTS / JOIN + group_by），以及分页查询树 / 选择器 / 预览面板。
  - 适用场景：新增或排查标签画册的建立、移动、改 key；插件下载或迁移没有挂上标签；标签搜索结果不对或变慢；给预览弹窗注入 app 侧信息面板。

## 本地文件夹（`local-folder/`）

- [local-folder/LOCAL_FOLDER_SYNC.md](local-folder/LOCAL_FOLDER_SYNC.md)
  - 主题：本地文件夹同步的 `fs_listener` / `synchronizer` 双管道、路径集合 + `stat` 分类、逐画册 slot 与并发限制、全量/diff 触发矩阵、文件与文件夹删除语义、`make_visible` 唤醒 + 500ms 快照轮询、延迟卡片和逐任务 toast；并记录手动增删边界（Del/右键删除源文件、拖入经 `local-import` 扁平复制到 `sync_folder`、数据库成员写守卫保持只读）。
  - 适用场景：新增或排查本地文件夹监听与同步；理解目录删除为什么保留图片行；维护取消、抢占、进度和事件溢出行为。

## Wallpaper Engine 壁纸（`wpe/`）

- [wpe/WPE_IMPORT.md](wpe/WPE_IMPORT.md)
  - 主题：目录型 WPE 壁纸的入库模型（`local_path` 是目录、`type` 为 `x-wpe/*`）、格式表占位条目、
    Steam 库发现与任意文件夹识别、`wpe-import` 内建任务与「壁纸」收集入口、`/wpe/<id>/<rel>` 目录服务、
    删除 / 整理 / 虚拟盘 / 原生壁纸的按类型分流护栏，以及壁纸窗口复现作者视频属性（作者值 + Kabegame 覆盖）；壁纸窗口为 `index.html?window=wallpaper` + `WallpaperWindow.vue`（IPC / 看门狗 / 握手）+ 纯渲染组件 `WallpaperStage.vue`。
  - 适用场景：新增 WPE 类型或阶段（web / scene）、排查壁纸目录被当文件处理、`/wpe` 越界、
    删除记录误删 `preview.*`、整理误删目录行、WPE 壁纸在非窗口模式下不可用，或想了解视频属性来源；修改壁纸窗口的渲染 / 过渡 / 入口分发。

## 下载与任务（`downloader-tasks/`）

- [downloader-tasks/DOWNLOADER_FLOW.md](downloader-tasks/DOWNLOADER_FLOW.md)
  - 主题：当前下载器全链路与模块边界。涵盖任务级 dry-run 的下载/metadata/local-import 三个 nop 点、全局与逐任务下载并发闸门（pending + active 原子判断、运行中实时调整）、`mod.rs` scheme registry / `queue.rs` worker / `content.rs` Android content downloader 的分工，`download_with_retry` 通过 `DownloadSink` 溢写（5 MiB 阈值）返回 `DownloadOutcome`（Bytes/Path）、单图字节进度写入 `active_downloads` 并由前端 500ms 快照轮询、Android 通知 1s ticker、Fatal/Retriable/Resumable 三级错误重试、crawler/surf 捕获 blob/data/MSE 后经会话 VFS Raw IPC 分块落盘、显式 FFmpeg 合流、页面自发原生下载落 VFS `tmp/Downloads` 后经事件出口交给 crawler 插件或 surf 自动导入（含压缩包解压）、crawler 通过 task-vfs 流式提交与 surf 通过 `surf_import_media` Path 直通、surf `DownloadState` 终态 toast、畅游一键下载（Rust 权威 run 状态机 + Tauri Channel、无 window 全局的页面媒体发现、HTML+CSS 页面快照入 metadata 与详情回看；快照详情按畅游 / 内建 webpage 图片来源识别，快照上限与搜索索引规则下沉 core `storage::page_snapshot`，冻结开关同时作用于网页收集）、DRM 拒绝、统一 `postprocess_downloaded_image`（`PostprocessSource` 枚举）、URL 与 hash 两级去重及可选的去重 metadata 来源重绑定、入库后 best-effort 原生元数据（EXIF/PNG chunk）逐图计算与一图一行存储（`image_metadata` 表）、桌面落盘、Android MediaStore copy 与 content URI 沿用、统一源文件清除（桌面回收站分块/降级、Android MediaStore 直删/批量授权）、隐藏图片分批清理服务的 busy 快照轮询、失败重试、任务计数经 `tasks-change` / `TaskChanged` diff 同步、`Task.cancel` 取消语义、启动临时文件清理，以及只对实际插入发送、按单画册拆分的 **`album-images-added`**（删除为 deleted、排序才是 change，隐藏只发隐藏画册自身事件）（连同图片新增 / 删除 / 字段补丁与 `hidden-cleanup-finished`）。
  - 适用场景：下载任务生命周期、Android `content://` 与 HTTP/HTTPS 下载差异、畅游一键下载与取消、页面快照回看、JS 爬虫或畅游窗口的页面自发原生下载、`blob:` / `data:` / MSE 媒体下载、会话 VFS 写入与清理、MSE 多 SourceBuffer 显式合流、surf 导入与终态反馈、源文件删除/回收站护栏、清空隐藏画册、失败重试、状态流转问题；任务 success/deleted/failed/dedup 计数与前端同步；排查下载后列表/画册未刷新。

- [downloader-tasks/VIDEO_INGEST.md](downloader-tasks/VIDEO_INGEST.md)
  - 主题：视频摄入（下载/导入压缩）的平台门控机制。桌面 standard/CLI 使用 rsmpeg/FFmpeg；Android 走 Kotlin `AndroidVideoCompressProvider` 与系统媒体 API，不编译 FFmpeg。画廊播放始终可用（HTML `<video>`，无需 FFmpeg）。
  - 适用场景：新增视频处理调用点；排查桌面 FFmpeg 构建环境；排查 Android content URI 视频预览/维度读取；理解 `deno task build:ffmpeg` 与桌面构建的关系。

- [downloader-tasks/TASK_DRAWER_LOAD.md](downloader-tasks/TASK_DRAWER_LOAD.md)
  - 主题：任务列表与运行配置的 PathQL 按需加载；任务与配置累计窗口分页、运行配置最新任务相关子查询 join、chip 过滤/计数/排序、任务 / 配置列表累计行与总数同批观察、任务状态计数与详情观察方、事件刷新及高频字段补丁、写后事件刷新、推荐导入态 plugin-changed 观察刷新，以及任务右键菜单与再次执行的数据流。
  - 适用场景：任务数量多时打开抽屉卡顿、`loadTasksPage` 与 `get_tasks_page` 行为；排查右键菜单层级、菜单动作或三类任务重跑参数回填。

## 爬虫（`crawler/`）

- [crawler/CRAWLER_JS_FLOW.md](crawler/CRAWLER_JS_FLOW.md)
  - 主题：Crawler JS 执行链路与相关模块关系，含提交时冻结 `Task/TaskParams`、任务级 dry-run 与 V8 `common.isDryRun` / WebView `Kabegame.common`、内建 `local-import` 插件化及后端展示元数据、**内建 `webpage` 网页收集**（一份 `page_discover.js` 被畅游 / WebView / V8 三处复用、V8 与 WebView 共用编排、V8 默认注入畅游 Cookie 与 CEF UA、`TaskParams::uses_webview_transport` 任务级下载 transport、`run_webview_session` / `run_v8_and_drain` 共用收尾、提交前二次校验）、`get_plugins` 追加内建且前端管理列表过滤、web 本地导入入口移除、每任务独立 WebView 窗口、media_capture/media_download/bootstrap initialization scripts、页面自发原生下载的 `Kabegame.onNativeDownload` 事件出口、Task 内 page stack/state/`TaskResult` completion、worker await completion、按 `crawler-<task_id>` label 路由命令。
  - 适用场景：调度、注入、抓取流程排查与扩展；新增内建插件或排查网页收集（发现不全、Cookie/UA 未注入、WebView 任务下载丢登录态、快照缺失）；排查 JS 任务并发、窗口创建/销毁、IPC 路由、Task 注册表状态、`Kabegame.downloadImage` 对 blob/data/MSE 的分流、`Kabegame.onNativeDownload` 每页注册与 VFS 路径导入、会话 VFS 分块写、task-vfs 提交、DRM 拒绝与显式合流。

- [crawler/ANDROID_WEBVIEW_CRAWLER.md](crawler/ANDROID_WEBVIEW_CRAWLER.md)
  - 主题：Android WebView 爬虫（crawl.js 后端）的宿主 / 停靠模型。涵盖 `CrawlerActivity` 只当 wry 宿主
    （`moveTaskToBack`、每个实例单独成栈、不能 `excludeFromRecents`）、`CrawlerHost` 把页面装进容器
    垫到主界面主 webview 之下（`z=-1`，始终 `visible`，`show` / `hide` 只改 Z 序）、`ContentWebView`
    主框架 IPC 与显式释放、`CrawlerRegistry` 会合与「预期关闭」、`CrawlerPlugin` 命令与每任务
    `pageDownload` / `renderGone` / `cancel` / `closed` 事件、`ProcessLifecycleOwner` 前后台事件与
    看门狗挂起、共享渲染进程的 `onRenderProcessGone`、脚本下载与页面自发下载补 Cookie/UA/Referer
    走 reqwest、与畅游的复用边界，以及已知限制（Context 弹窗、移动版 DOM、JNI 引用残留、rAF 耗电）。
  - 适用场景：在安卓上跑 JS（WebView）插件或网页收集的 webview 后端；排查后台暂停被误判成心跳超时、
    页面不显示或收不起来、输入法 / 点击落到错误层级、任务完成后被误标取消、页面下载丢登录态、
    主界面重建后爬虫页面消失、渲染进程崩溃连带应用退出。

- [crawler/PIXIV_METADATA.md](crawler/PIXIV_METADATA.md)
  - 主题：Pixiv Rhai 插件 `metadata.body` 白名单入库与 DB 一次性迁移。
  - 适用场景：排查画册列表因 metadata 过大变慢、扩展 EJS 所需字段。

- [crawler/PIXIV_RANKING_RHAI.md](crawler/PIXIV_RANKING_RHAI.md)（历史，Rhai 已移除）
  - 主题：Pixiv 排行榜模式的 `config.json` 三维度、`ranking_date`、按接口 `next` 分页与 `warn`。
  - 适用场景：扩展/排查排行榜爬取、R18 与 `x-user-id`、理解列表分页语义。

- [crawler/PLUGIN_DATA.md](crawler/PLUGIN_DATA.md)
  - 主题：爬虫插件私有 JSON 缓存 `plugin_data`，含 Rhai 读写 API、`description.ejs` 只读 bridge、隔离和卸载清理语义。
  - 适用场景：插件需要缓存 tag taxonomy、emoji 元数据、token、TTL 状态，或在描述模板中读取爬虫预先计算的数据。

- [crawler/METADATA_MIGRATION.md](crawler/METADATA_MIGRATION.md)
  - 主题：插件图片 metadata 迁移流程——单一脚本的 `migrate` / `provideLabels` / `provideSearchTextList` 契约、packed 插件版本门控、同插件串行 + pending 续跑、`MetadataMigrationService` 运行态与忙碌卡片、`metadata` 行按 id 不可变、按批（512 行）写回与整轮末尾一次去重合并（只合并本轮新建行）、批量挂标签、搜索词典与映射重建，以及每批写回提交后立即发出、结尾去重再补发的 `metadataId` 补丁事件。
  - 适用场景：插件升级后历史图片详情或搜索片段变化；排查 metadata 迁移失败或很慢、缓存未刷新、去重合并、版本编码（a.b.c 每段 ≤255）问题。

- [crawler/V8_RUNTIME.md](crawler/V8_RUNTIME.md)
  - 主题：V8 爬虫运行时（桌面 + Android/aarch64，仅 iOS 不支持）的 Web 平台全局、`crawl(common, custom)` 的 `common.isDryRun` 与 `Kabegame.*` 宿主桥（含每任务隔离的 `Kabegame.fs` 与虚拟路径媒体工具 `Kabegame.ffmpeg`）。涵盖 `plugin-runtime` feature 门控（主 app 启用、CLI 排除 deno/rusty_v8）、标准 `fetch` 使用、任务请求头合并、相对 URL 解析差异、SDK 保留工具模块；**文件系统挂载**（`data` / `cache` / `tmp` 可写，路径类变量冻结出的只读 `input`，含 Android `content://` 单文件）；**运行时架构**（设备端共享 baseline startup snapshot 缓存、fresh fallback、当前 fingerprint=4、V8 版本/CRC 校验、`deno_crypto` cppgc restore 后初始化；**每任务独占 current_thread runtime**，不可借用多线程 runtime 的 `Handle::block_on`，否则 deno_core op 轮询任务跨线程竞争、任务卡死或进程 abort）；**网络宿主化**（`op_kabegame_fetch`/`op_kabegame_to` 走 `reqwest`，不引入 `deno_fetch`/`deno_net`/`deno_tls`，`Response`/`Headers` 在 `prelude.js` 自实现）；**Android 交叉编译**（官方无 Android 预编译，仓库自带 `bin/android/` 自建产物 + mode-plugin 注入 `RUSTY_V8_ARCHIVE`/`RUSTY_V8_SRC_BINDING_PATH`、`V8_FROM_SOURCE` 自建流程、NDK libc++、`RustPlugin.kt` ABI 收敛；WebView 后端另见 [crawler/ANDROID_WEBVIEW_CRAWLER.md](crawler/ANDROID_WEBVIEW_CRAWLER.md)）。
  - 适用场景：编写/迁移 V8 插件；排查 startup snapshot 生成/失效/fallback、`Kabegame.fs` / `input` 只读挂载 / `Kabegame.ffmpeg`、`fetch`、`URL`、`crypto`、`DOMParser`；更新 JS 插件模板和类型声明；排查 V8 任务偶发卡死不动（`RefCell already borrowed`）或跑插件时进程闪退；排查 V8 后端 Android 交叉编译（依赖门控 / 自建预编译产物 / NDK 链接）或网络/`Response`/`Headers` 行为。

- [crawler/TASK_CONFIG.md](crawler/TASK_CONFIG.md)
  - 主题：收集弹窗的三层配置（plugin config ⊂ task config ⊂ 自动任务 `RunConfig`）、任务级 `isDryRun` 的冻结与继承规则、插件变量的前端转换与后端合并 / 校验 / 链式 `when` 过滤、路径类变量在冻结时解析成只读 VFS 挂载并把运行时 config 改写成虚拟路径，以及全局唯一 `taskConfig` 的回填与交互规则。
  - 适用场景：改动收集弹窗、任务「再次执行」、「以此配置运行」、插件变量表单或运行配置回填；排查默认值优先级、显式 `null`、`required` 拦截、隐藏字段仍被提交、`when` 链未传播，或路径变量解析 / 改写失败。

- [../third-patches/deno/README.md](../third-patches/deno/README.md)
  - 主题：`deno_core` 的上游 vendor base 与 kabegame patch series。`third/deno` = `denoland/deno` monorepo submodule（pin `v2.9.0`，`libs/core` 与 crates.io deno_core 0.405.0 逐字节一致），经 `[patch.crates-io] deno_core = third/deno/libs/core` 单一来源消费；4 个 patch（扩展 JS 内嵌 / 共享 V8 platform 初始化 / Android Bionic errno / 内嵌行为 feature 门控）只作用于 `libs/core`，`deno task patch deno` 按 reset 模型全量应用。Deno CLI 一律使用官方二进制，与这组 patch 无关；`serde_v8`/`deno_ops` 作为 monorepo path 依赖单份解析（无 path-vs-registry 重复）。
  - 适用场景：新 checkout 后准备构建 V8 后端（先 `deno task patch deno`）；升级 deno_core 版本 re-vendor；排查 deno_core patch 应用/漂移或 serde_v8/deno_ops 解析来源。不要把这里的 patch 当成 Deno CLI 定制。

- [../third-patches/rusty_v8/README.md](../third-patches/rusty_v8/README.md)
  - 主题：Android 版 `librusty_v8` 自建产物的可复现构建。`third/rusty_v8` = `denoland/rusty_v8` submodule（pin `v149.4.0` = Cargo.lock 的 v8）是**就地复用的胖构建树**（nested submodules + 已编译 target/ 都在其中，增量复用、不重拉/重编，`ignore = dirty`）。`deno task build:v8`（`scripts/build-v8.ts`，仅 Linux）幂等应用补丁并构建：补丁是 `third-patches/rusty_v8/` 顶层 `*.patch`，均 `git -C third/rusty_v8 apply`（0002 路径带 `build/` 前缀，跨进嵌套 build 子模块），**由 build-v8.ts 应用而非 `deno task patch`**——patch-manager 现只对**纯净树** forward、对**脏树** reverse（幂等），本胖树常驻脏态故被跳过。产物 `bin/android/arm64/rusty_v8-build/{*.a,src_binding.rs}` gitignore、不入库。**`v8` 不经 `[patch.crates-io]`**——git 仓缺发布版的 `gen/` binding，patch 会破坏桌面构建；app 构建仍用 crates.io v8 + 注入 archive/binding。
  - 适用场景：Linux 上复现/增量重建 Android v8 产物；升级 v8/deno_core 后重建；排查补丁应用（含跨嵌套子模块）、patch-manager 纯净度门控、from-source fixup、GN/NINJA、bindgen/LIBCLANG（clang19）或 mode-plugin 注入。

## 插件（`plugins/`）

- [plugins/PLUGIN_FILE_ENDPOINT.md](plugins/PLUGIN_FILE_ENDPOINT.md)
  - 推荐配置由 `plugin://…/recommended` rows 观察方读取，按来源版本隔离；写后 `plugin-changed` 差异驱动相关 key 刷新。
  - 主题：插件轻量记录与 `/plugin_file` 按需读取，`v` / `source` / `preview` 参数、白名单、404、ETag、推荐配置动态导入态、Android loopback 转发、前端缓存失效与任务脚本快照。
  - 适用场景：排查文档/图片/模板加载、错误版本或预览失效、商店来源隔离、推荐配置导入态、启动插件负载和脚本按需读取。

- [plugins/PLUGIN_ASSETS.md](plugins/PLUGIN_ASSETS.md)
  - 主题：插件配图的**声明→打包→加载→展示**全链路，核心是**单一坐标系**。涵盖 `kbAssets` 路径数组（为何从 `kbDocAssets` 的「引用串→包内路径」对象收敛为一份插件根相对路径清单、与 `kbDoc` / `kbChangelog` 的职责划分、字段缺失即零资源、`kbDocAssets` 的打包硬错误 vs 加载 WARN 不对称）、**路径归一化契约**（8 条规则、`..` 越界判非法、引用一律按插件根解析而非 md 所在目录、不做大小写归一、Rust/TS 两份同构实现）、**为何交叉校验必须提到分支外**（删掉 md 正则回退后没有兜底，且由此实现「三个键互不依存」）、2MB/10MB 限额、保留声明顺序的 `Plugin.assetKeys` 及 HTTP 按需读取，以及「源」页面（右键）与插件选择器（hover）共用的快捷预览走马灯（路径 `banner` 前缀、声明顺序、通用 `HoverRevealPanel` 容器及其 `trigger`、为何未安装条目不出图、无图时不留 banner 区）与插件详情由路由改为弹窗。
  - 适用场景：给插件补配图；排查文档或更新日志图片「加载失败」、打包报「引用了未在 kbAssets 声明的本地资源」、单文件超 2MB 打包失败、残留 `kbDocAssets` 打包报错；改归一化规则；排查快捷预览面板不弹出或走马灯无图。

- [plugins/PLUGIN_STORE_CACHE.md](plugins/PLUGIN_STORE_CACHE.md)
  - 主题：插件商店缓存机制与更新策略；前端 `usePluginMarketStore` 通过 `startRefreshPlugins` 在启动时先读缓存、再静默强制刷新并每 4h 自动刷新，进入 tab 以 4h 阈值兜底；`installedVersion` 读取时现算，兼容性过滤后的可更新集合驱动桌面/紧凑导航角标、商店源 tab 角标、商店卡片红点与快捷预览（已安装 tab 不提示，更新只能在商店源执行）；后端安装入口校验最低应用版本；以及插件页 `?tab=store:<sourceId>` 导航参数（详情返回恢复商店 tab）。
  - 适用场景：插件列表或导航更新角标延迟、缓存失效与命中行为分析；排查不兼容版本仍提示或被导入、从插件详情返回后 tab 丢失或商店列表重拉、源增删后 tab 未刷新、商店卡片已安装状态不同步。

- [plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md](plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md)
  - 主题：插件详情 **EJS 全链路**（`metadata` 写入 → `/plugin_file` 懒加载 → `ejs.render` → iframe `srcdoc` 注入 `__bridge` → `postMessage` + `proxy_fetch`）。
  - 适用场景：编写/调试 `description.ejs`、理解模板从 ZIP 到展示的流程、排查详情区空白或跨域请求失败。

## Tauri（`tauri/`）

- [tauri/TAURI_ACL_PERMISSION_SYSTEM.md](tauri/TAURI_ACL_PERMISSION_SYSTEM.md)
  - 主题：Tauri v2 ACL（capability/permission）在 kabegame 的运行机制与故障复盘。
  - 适用场景：新增 `#[tauri::command]` 后补 `permissions/*.toml` 白名单、新增窗口 IPC 权限、调整 capability/permission、排查“命令不可用/全部被拒绝”问题。

- [tauri/TAURI_CLI_FORK.md](tauri/TAURI_CLI_FORK.md)
  - 主题：fork 的 `cargo-tauri`（上游 tauri monorepo `third/tauri` + `third-patches/tauri` patch series，基线 2.12.4；先 `deno task patch tauri`）。顶层 `bins` 配置（patch 0009）驱动桌面 `tauri build` 的 cargo `--bin` 编译清单（不再 `--bins` 全量编译；未配置回退 get_binaries 打包清单），Windows 下辅助 bin 由 NSIS 原生装到安装根。`TAURI_ANDROID_PACKAGE` 将 Android Java 包（源码目录/生成 Kotlin/JNI）与 identifier（applicationId，按 mode：dev=`app.kabegame.dev` / prod=`app.kabegame`）解耦，auto-launch 改传全限定类名；`TAURI_NO_WEBKIT_DEPS` 跳过 Linux deb/rpm 的 webkit 依赖注入并对依赖去重。含 TauriCliPlugin 接线（PATH 前置 + dev/build 前增量构建）与升级 re-vendor 流程。整个 tauri 栈经 `[patch.crates-io]` 指向 `third/tauri/crates/*`（单一来源，另见 [../third-patches/tauri/README.md](../third-patches/tauri/README.md)）。
  - 适用场景：android dev/prod 真机并存隔离；排查 `Project directory ... does not exist`、auto-launch 拉起失败、`BuildConfig` 解析错误；升级 tauri-cli 版本；排查 deb 包 webkit 依赖或 Depends 重复。

- [../src-tauri/tauri-runtime-cef/README.md](../src-tauri/tauri-runtime-cef/README.md)
  - 主题：Windows/macOS/Linux 桌面 CEF runtime 后端的架构、平台门控与 CEF Views/windowed GPU 路径；自定义协议、page-load 生命周期与 `invoke` IPC 桥接；**文件拖放**（`TauriCefDragHandler` 把 CEF 回调翻成 Tauri 四态 `WindowEvent::DragDrop`，依赖 patch 0002 补出的 `OnDragOver`/`OnDragLeave`/`OnDrop`，语义对齐 wry）；Windows manifest 与 runtime 安装；`kabegame` package 内的扁平 `kabegame-cef-helper` 子进程、macOS 构建期直链 framework 与裸 exe dev 运行、CefAppProtocol external pump、release 打包、**Chrome ProcessSingleton 双实例收口**（同 profile 双开时后到者识别 `NORMAL_EXIT_PROCESS_NOTIFIED` 干净退出，先到者经 `on_already_running_app_relaunch` 拦掉默认「弹一个浏览器窗口」、转 app 层注册的显示主窗口处理），以及 CEF 上游 pin/patch series 维护流程（`third/cef` 的 gitlink 始终指向官方上游 pin、patch 走标准系列；`automate-git.py` 只 fetch 分支、只认提交，故构建前由 `stageCefPatchesAsCommit()` 把工作区自动固化到 `kabegame-build` 分支——曾经人工维护 fork 分支并让 gitlink 误指向本地提交的做法已废除）。
  - 适用场景：排查桌面 CEF 启动/渲染/IPC、升级 CEF/Chromium（官方 pin + patch series re-vendor）、调整 `tauri-runtime-cef` trait 适配；排查从外部拖入文件被 CEF 直接打开成预览页、`onDragDropEvent` 不触发；排查并发双开（如开机自启竞态）凭空多出一个带应用图标的 Chrome 窗口、或第二实例以 status=101 崩溃；排查 Windows GPU 子进程、macOS 裸跑子进程起不来/窗口空白/黑屏、message pump，或三平台 CEF_PATH 解析与打包；确认自编的 CEF 里到底有没有 kabegame patch。

- [tauri/LINUX_REAL_FILE_DRAG_OUT.md](tauri/LINUX_REAL_FILE_DRAG_OUT.md)
  - 主题：Linux 与 macOS 的 CEF standard 从图库拖出真实本地文件的完整链路。涵盖 Chromium `FilterDropData` 安全边界、前端 image id → Chromium/CEF delegate → Rust DB 授权的三段式权责、Linux「推」(`OSExchangeData`) 与 macOS「拉」(`NSPasteboardWriting` + `public.file-url`) 两种载荷模型的差异、Wayland/X11 的 URL/text/缩略图载荷清理与 macOS 额外要清的 html/download promise、macOS 必须摘掉的 `org.chromium.renderer-initiated-drag` 污染标记（不摘则所有 Chromium 系接收方都收不到文件）、Chromium/CEF/cef-rs/runtime 四层维护位置、label 与 DB 两道安全门，以及 Windows 复用当前媒体 `currentSrc` 的 wildcard HTTP URL 拖出行为。
  - 适用场景：排查 Linux 拖到 GIMP/Krita、浏览器上传框或文件管理器仍得到 localhost URL；升级 CEF/Chromium 或 cef-rs bindings；修改拖出授权、webview label 白名单或 custom mime；确认 Windows `DownloadURL` 为什么不受影响。

- [../third-patches/cef/README.md](../third-patches/cef/README.md)
  - 主题：CEF 官方上游 vendor base、Kabegame 编号 patch series、`deno task patch` reset/apply 模型与 re-vendor 流程。现有三个 patch：0001 扁平子进程路径；0002 给 `CefDragHandler` 补完整的落点侧回调；0003 给 Linux 与 macOS Chromium/CEF 补真实文件拖出的起手侧 delegate、`OnStartDragging` 与 custom data 读取（macOS 另需让 `WebDragSource` 提供 `public.file-url` 并摘掉 renderer 污染标记）。生成的 capi 与 `libcef_dll` 胶水由 `version_manager.py` 在 `cef_create_projects.sh` 里产出、不入 patch。
  - 适用场景：新 checkout 后准备自编 CEF；升级 CEF 7827 pin；修复 Chromium 上游变化导致的 patch context 漂移；给 CEF client 加新回调；维护 Linux 真实文件拖出的 Chromium/CEF 两半 patch。

## 调试（`debug/`）

- [debug/DEBUG_INGEST.md](debug/DEBUG_INGEST.md)
  - 主题：开发期 runtime debug ingest 方法。Vite dev server 提供 `POST /__kabegame_debug/ingest`，前端与 Rust 后端按 `session_id` 发送调试事件，middleware tee 到 `.kabegame/debug/debug-<session_id>.ndjson`。同一 middleware 还兼职 **CDP 端口寄存**（`/__kabegame_cdp/register` 登记 + `/__kabegame_cdp` 查询），把 CEF 随机分配的调试端口交给 `kabegame-chromium` skill。
  - 适用场景：仿 Cursor Debug Mode 的插桩式排查；需要把前端和 Rust 后端运行时状态汇总到同一个 NDJSON 会话文件；用 curl 验证 debug endpoint 或读取 session 日志；排查 CDP 端口发现（skill 连不上跑起来的 app）。

## 组件库（`ui/`）

- [ui/BUSY_TASKS_POLLING.md](ui/BUSY_TASKS_POLLING.md)
  - 主题：后台忙碌任务的「唤醒事件 + 500ms 快照轮询」统一协议；`useSnapshotPoller` 的 key 单例、setTimeout 链、请求不重叠、invalidate generation 与 starting 启动窗口规则，以及 busy / download 两个实例的权威边界。
  - 适用场景：新增后台进度卡片；排查空闲仍轮询、finished 丢失后卡片不消失、旧快照复活、下载抽屉与失败重试进度不一致。

- [ui/COMPONENT_LIBRARY.md](ui/COMPONENT_LIBRARY.md)
  - 主题：**本仓不再依赖 npm element-plus**，组件与图标已 vendor 成自有组件库 `@kabegame/element-plus` / `@kabegame/element-plus-icons`（fork，不跟上游）。涵盖 vendor 动机（从没覆盖 EP 全局 token 导致的 1733 行覆盖 + 147 处 `!important`）、三处接线（vite alias / **两处** tsconfig `paths`，app 的是整体覆盖 / web `manualChunks` 必须判在 node_modules 闸门之前且 `-icons` 在前）、`vueJsx()` 插件的必要性、前缀现状（namespace 两个开关仍是 `el`，翻之前必须清零业务侧 `.el-*`，及字面量 transition 名等漏网处）、**加主题的正确姿势**（下沉到 `common/var.scss` 的 token map，`--kb-el-* ← --anime-*`，date-picker 是范例）、自有组件放哪（可直接进 vendored 包，`KbTab` 已取代 `ElTabs`；theme-chalk vs SFC scoped 的分流）、图标 svg 真源 + 零依赖 Deno 生成器，以及 scss 自包含 / `process.env.NODE_ENV` / `.tsx` JSX 类型等踩坑。
  - 适用场景：写任何前端组件或样式前先读；排查「从 element-plus 导入报错」；给组件加主题；新增/删除 vendored 组件；加图标；改 alias / tsconfig paths / chunk 划分；准备翻 `kb-el` 前缀。
  - 配套：[../packages/kabegame-element-plus/README.md](../packages/kabegame-element-plus/README.md) 与 [../packages/kabegame-element-plus-icons/README.md](../packages/kabegame-element-plus-icons/README.md) 记录各自与上游的逐项结构差异。

- [ui/FILE_DROP_ZONES.md](ui/FILE_DROP_ZONES.md)
  - 主题：桌面文件拖入的**区域级**结构。涵盖窗口级 `useFileDrop` 与区域级 `<DragFileZone>`（注册表持有响应式 props）的分工、Enter `(0,0)` 与按 z 序（`elementsFromPoint` + 父链）命中契约、画廊/普通画册/文件夹画册统一走 `local-import` 扁平递归导入（文件夹画册带 `outputDir=sync_folder` + `copy_to_dir`）、收藏/隐藏拒绝规则、`KbPath` 的单文件/单文件夹拖入，以及应用自身拖出媒体通过 `dragstart` 标记 + `enter` 快照实现全程静默的原因。
  - 适用场景：给页面新增/修改拖入热区；排查拖入无反应、弹窗遮挡仍导入画廊、错误创建同步画册、内部拖出误触发导入、提示「此处不支持」、浮层坐标或样式异常。

## 国际化（`i18n/`）

- [i18n/I18N_MIGRATION.md](i18n/I18N_MIGRATION.md)
  - 主题：i18n 迁移约束、命名空间规范与落地状态。
  - 适用场景：新增国际化 key、迁移旧文案、核对多语言覆盖。

## 设置（`settings/`）

- [settings/SETTINGS_BACKENDS.md](settings/SETTINGS_BACKENDS.md)
  - 主题：前端设置后端抽象。涵盖 `tauri` / `localStorage` / `query` / `readonly` 四类 descriptor、getter-only tauri key 的 `refresh(key)` 单键读取、事件驱动保存状态机、query adapter 注入和 pathRoute 接入边界。
  - 适用场景：新增设置 key；新增运行时状态类单键刷新；迁移 URL query 状态；排查设置保存态、web readonly 回弹、query 参数同步和 localStorage 迁移。

## 壁纸（`wallpaper/`）

- [wallpaper/WINDOW_MOUNT_WEMT.md](wallpaper/WINDOW_MOUNT_WEMT.md)
  - 主题：Windows 窗口壁纸按 WPE 运行时层级挂到 WorkerW，移除旧 Progman 同级 Z-order 修正；列出证据、实现边界与真机验证项。

- [wallpaper/NATIVE_WALLPAPER_COMPAT.md](wallpaper/NATIVE_WALLPAPER_COMPAT.md)
  - 主题：Linux / Windows 原生壁纸的图片格式兼容层。涵盖独立的 `wallpaper_compatible_path`、惰性 JPEG/PNG 转码与复用、样式重应用路径、best-effort 回退，以及删除图片时对兼容副本的安全清理。
  - 适用场景：排查 GNOME/Windows 设置 WebP、AVIF、HEIC、HEIF 后壁纸空白；扩展原生壁纸格式白名单；维护兼容副本生命周期。

## 构建打包（`build/`）

- [build/PLATFORM_SHARED_LIBS.md](build/PLATFORM_SHARED_LIBS.md)
   - 主题：三平台动态库与 CEF 运行时打包。涵盖 `OSPlugin.bundleLibs`、`kabegame-cef-helper` 的编译方式（build 经 `tauri build -- --bin` 随主编译产出；dev 与 Windows build 由 ComponentPlugin 预构建）、主程序/helper 的 Linux rpath 差异、macOS framework/files 注入、Windows NSIS 搬运，以及虚拟盘驱动/系统依赖策略。
  - 适用场景：新增/升级运行时动态库;排查最终用户报 `libx264.so.X: cannot open`、macOS `Library not loaded` 或画册盘驱动缺失;调整 build-ffmpeg / DLL 复制 / dmg fixup / NSIS hook 流程。

- [build/LINUX_BUILD_WORKFLOW.md](build/LINUX_BUILD_WORKFLOW.md)
  - 主题：**本机 Linux 构建工作流**——因本机 glibc 2.43 太新，出货用的 `.deb` 在 Ubuntu 22.04 guest（glibc 2.35）里做最终链接（不重编 CEF/Chromium/V8）。核心是 **profile 隔离 + 构建属地**模型：guest 完整挂载仓库、等同一台开发机（无 `target-22`、无 `.vm/cef-prod` 侧拷贝、无 `-22`/`-web` 后缀）；host 只跑 debug（`target/debug`），**release 与 FFmpeg/x264 产物构建只在 guest**（`target/release`），由 `requireUbuntu2204()` 守卫强制（逃生阀 `KB_ALLOW_HOST_BUILD=1`），chromium/v8 构建豁免。涵盖 virtiofs 同路径挂载、`paths.ts` 的路径/target 单一来源、glibc 地板验证；以及踩坑：**预编译 `.a` 的 `__isoc23_*`（2.38 新名符号、无版本标签、易漏判）必须重编 x264+FFmpeg**、`.pc` 烧死的绝对路径、构建脚本写死 `target/release`、`package-plugin.ts` 误跑 host cli、web docker 构建会覆盖树内 Linux FFmpeg 产物。
  - 适用场景：出货 Linux deb（标准流程）；判断某个预编译 `.a`（x264/FFmpeg/v8）能否跨 glibc 复用；排查 `version 'GLIBC_2.xx' not found`、`undefined symbol: __isoc23_*`、`.pc` prefix 失效、构建被守卫拒绝、`CARGO_TARGET_DIR` 未被某脚本尊重；复现/维护 22.04 构建 guest。

## 应用更新（`updater/`）

- [updater/AUTO_UPDATE_FLOW.md](updater/AUTO_UPDATE_FLOW.md)
  - 主题：桌面端 GitHub Release 自动更新全链路。**状态机 + 调度 + 下载 + 安装归后端权威**（`UpdaterService` 单例，仿 `OrganizeService`），前端镜像（`get_updater_state` hydrate + 事件刷新）。涵盖 6-phase 状态机（unchecked/checking/checked/updateAvailable/downloading/restartable）、`checking`/`downloading` 独占不可重入、restartable 重检保留、tag-only 版本比较 + `v` 前缀归一化、asset 平台/模式匹配、三事件（`updater-state-change`/`update-download-progress`/`update-download-error`）、平台安装差异（macOS `open` dmg 后退出 / Windows 跑 setup.exe / Linux 仅跳转）。
  - 适用场景：新增/排查更新流程与状态机；排查「下载途中刷新丢状态」「下载中仍能触发检查」「restartable 误降级」；调整 asset 匹配 / 平台安装；排查 NEW/重启按钮、changelog 弹窗、检查更新转圈。

## 维护规则

- 新增流程文档后，必须在本索引补充条目（链到具体文件路径 + 主题 + 适用场景）。
- 发生流程级改动时，先更新对应文档，再更新本索引描述（若语义有变化）。
- **third-patches reset 模型**：patch-manager 接管的系列可自由增删改和重编号；`deno task patch <dir>` 先把子模块 reset 到纯净基线，再按文件名顺序全量 apply，`-r` 仅 reset。操作会丢弃子模块未提交改动，本地开发应先提交到分支。`rusty_v8` 是唯一的手动例外（就地复用的胖构建树，patch 由 `scripts/build-v8.ts` 应用）；`cef` 的正式补丁位于 `third-patches/cef/` 并由 patch-manager 应用，`scripts/build-chromium.ts` 仅将已应用补丁的工作树临时固化成 `kabegame-build` 提交，供只认提交的 automate-git 使用。详见 [third-patches/AGENTS.md](../third-patches/AGENTS.md)。
