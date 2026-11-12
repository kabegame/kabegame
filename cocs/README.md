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
    选择、`ipcProtocol` / `dataDir` 门控（当前 v5）、`PluginRun` 共享实现、`--print-config` / 任务级 dry-run、只在内存中传递的 `--freeze-template`、逐任务下载并发的
    `TaskSetMaxConcurrentDownloads`、`local-import` 任务、`pathql query` 本进程只读 Storage、
    CLI 禁用 metadata 迁移、v5 起带可选 `target` 的壁纸设置变体（轮播路径 / 样式 / 过渡 / 当前壁纸，
    删除 `ByMode` 两个 getter 与切模式交换样式的变体）、`KABEGAME_SQL_DEBUG` 以及 `IpcClient` 连接/事件语义。
  - 适用场景：新增 CLI 数据命令、IPC 协议变体，或排查 CLI 与运行中主程序的数据/任务差异、
    PathQL 实际 SQL 与耗时；外部集成经 IPC 读写某个壁纸目标的设置。

## Provider DSL（`provider-dsl/`）

- 状态：基于 SQL 的内置 Provider（root/gallery/shared/VD）均由 `dsl_loader::DSL_FILES` 中的 DSL 提供；
  唯一保留的 programmatic provider 是 `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs`
  （`plugin://` schema，按 `installed/<id>/<version>`、`byStore/<sourceId>/<id>/<version>`、
  `byPreview/<token>/<id>/<version>` 寻址；预览不可列举，商店只读缓存，元数据来自 `PluginManager`，recommended 行附带 Storage 当前导入态；不走 SQL provider），由 `providers/init.rs` 经
  `register_programmatic_provider` 注册。

- [provider-dsl/RULES.md](provider-dsl/RULES.md)
  - 主题：声明式 Provider DSL（v0.7）的加载期与运行期语义合约 —— schema 之外的规则。涵盖文件格式（json5 / YAML 双 loader，按扩展名选择；长 SQL 用 YAML `|-` 块标量换行书写及其禁忌）、路径折叠、ContribQuery 累积语义（fields/join/where/group_by/order 各自规则；排序项仅 `{sql, order: asc|desc, prepend?}`，全局排序指令为 `{all: revert|clear}`；offset 累加、limit 末次胜；schema 只登记数据表名、`plugin://` 走程序化 schema）、**`where` 的 WhereQuery 谓词树**（字符串=原子 / 数组=OR / `{not}`=取非；fold 期坍缩成一条，树上无 AND 节点；`where_clear` 按坍缩串整棵匹配）、嵌套目录清除上一层等值条件、分页写法（列举子项在 `list.sql` 里 bind 分页；`albums://` 等本地路由的行分页仍用 `x<N>x/<页>`，画廊续接用全局 `_kb_x<N>x/<页>`；分页节点只切页）、**全局前缀表**（`register_global_table`、本仓 `_kb_` 与 `kb_global.json5`、全局表优先解析及 provider key 缓存失效）与 **Resolve 透传条目 `passthrough: true`**（只折叠目标 query、current 不变，`_kb_co` 必须放在维度路径末尾）、**子查询边界 `~~`**（此前查询冻结成物化 CTE FROM，内层 ORDER BY/LIMIT 保留，外层不重放根贡献；配合 `group_by` 按外层行计数；物化顺序支撑 rank 定位；`~~<别名>` 把内层挂到别名下、表名留给外层回表，用于不可走索引排序的延迟回表；画廊实际路径为 `filter/…/~~/rank/~~p/lookup/gallery`，外层按序号取序）、**路径 WHERE 组合器 `~any`/`~or`/`~not`/`~end`**（分支旁路、组内只许 where + LEFT JOIN、`\~` 转义、尾部不自动闭合）、List 静态/动态项、`${...}` 模板（含 §6.5：属性值求值后像数字就变成数字，十六进制、前导零要带前缀传）、`as + in_need`、缓存、安全、保留标识符（`~` 与 `_kb_` 前缀）和主机协调模式；以及**插件 provider 与宿主的 `plugin_im` 约定**（§3.3.2：宿主只 join 不投影，插件 where 读 `plugin_im.data` 并包 `COALESCE`，`list.sql` 自行 join `metadata`，这样细分条件才能进 `~any` / `~not`）。
  - 适用场景：实现引擎 loader / 解析器；随机 / 名称等排序翻深页慢、想让内层只排 id 再回表；编写 *.provider.json5 / *.yaml 文件；编写或迁移插件的 extend provider；调整 `_kb_*` 全局续接段、透传或排序链；给 where 写 OR / NOT；分页之后按行计数（`~~` + `group_by`）或排查子查询慢；排查解析优先级、缓存失效、跨字段约束、组内贡献或未闭合组错误；排查某个参数化路径段只对个别取值（纯数字、前导零、含 `e`）查不到或报错；设计第三方插件可贡献的 provider。
  - 配套：[../src-tauri/kabegame-core/src/providers/schema.json5](../src-tauri/kabegame-core/src/providers/schema.json5) 为语法 schema。

- [provider-dsl/VD_INTEGRATION.md](provider-dsl/VD_INTEGRATION.md)
  - 主题：VD 作为 Provider DSL 引擎**消费者**的落地方案。涵盖 i18n 路径分发（`i18n-<locale>` 静态层 + 每语言独立 router）、插件维度的 `get_plugin` SQL 函数桥（主机注册的 SQL 函数把 PluginManager 元数据和按 locale 解析的 `displayName` 接入 SQL 上下文）、`vd_plugins_router` 与 `plugins_provider` 双层结构、典型路径折叠示例。
  - 适用场景：新增 / 修改 VD 维度路径树；接入需要主机协调的非 SQL 数据；理解 i18n 切换、插件装卸的缓存行为。

- [provider-dsl/ALBUM_SUB_TREE.md](provider-dsl/ALBUM_SUB_TREE.md)
  - 主题：`albums://by_sub_tree` 的按名称递归画册树查询，以及 CLI `--album` 通过父路径直接子项解析目标画册 id 的契约。
  - 适用场景：导入图片时按 `/父画册/子画册` 定位画册；新增或排查 albums 子树 PathQL 路由。

## MCP（`mcp/`）

- [mcp/MCP_SERVER.md](mcp/MCP_SERVER.md)
  - 主题：桌面端应用 Web 服务器的统一监听器、浏览器拒绝边界、JSON-RPC/SSE/媒体/MCP 路由（`/file` 对目录型 WPE 行返回文件清单、对目录内文件流式返回），MCP URI path/read 与 tool/write 能力体系、`list_pathql_entry` 懒树发现契约、不可列举的 `_kb_*` 全局续接段，以及画廊末两段 `_kb_x<N>x/<数字>`（原始 images 根仍用 `x<N>x/<数字>`）的 500 行分页护栏；并说明为什么不能在 `gallery_all_router.json5` 加 limit。
  - 适用场景：新增或排查桌面 Web 服务器、RPC/SSE、MCP 资源/工具/能力开关；维护 PathQL 发现、全局段说明与分页护栏；避免用 DSL LIMIT 破坏全局 COUNT、前端总数和页数。

## Web 版（`web/`）

- [web/CDN_MEDIA.md](web/CDN_MEDIA.md)
  - 主题：Web release 的媒体路径 CDN 转写边界，原图、缩略图、浏览器兼容副本与壁纸兼容副本的字段映射，以及线上 `images` / `thumbnails` / `compatibles` 必须同时指向 OSS 挂载的部署约束；**前端静态资源**经生产 web 构建的 Vite `base` 指向 `cdn.kabegame.com/web/`（服务器出口带宽仅 4～5 Mbps 且共享，OSS 并发约 5 倍并自带 gzip），`deploy-web.sh` 先经服务器本地暂存目录 `cp` 进 ossfs2 挂载点（ossfs2 按写入时文件名定 MIME，rsync 临时文件改名会让 JS 变成 `octet-stream`）、校验入口脚本类型后才停服，只增不删；bucket CORS 放行 demo 域名；插画经 `src/assets/illustrations.ts` 按模式取 WebP / 原图，`dropUnreferencedSrcAssets` 删掉未引用的那份。
  - 适用场景：Web RPC 返回服务器本地路径、CDN 媒体 404、调整媒体字段或迁移线上媒体目录；demo 首屏慢、静态资源 404 / 被浏览器拒绝执行（MIME、CORS）、部署 web 版、新增插画或 `public/` 大文件。

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
    favicon 自适应图标与删除后禁用、国产 ROM 静默拦截）、已知 Channel 生命周期（tauri 补丁 10）与 tao JNI 局部引用残留。
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

- [gallery/SAVED_VIEWS.md](gallery/SAVED_VIEWS.md)
  - 主题：查询行 ⋯ 视图菜单（只剩轮播与收藏视图，chip 显隐开关已删除）的收藏视图。
    - **数据**：前端 Dexie `kbg-saved-views`，存「查询体」，即过滤 + 排序，无根前缀 / hide / no-album / 分页尾；随机排序不带种子。
    - **来源**：按 ImageGrid adapter 分区，所有画册 / 任务 / 站点各共用一份；由扩成 `{ path, source, pathFor }` 的 `gridViewKey` 注入，各页不传 props。
    - **名字**：可空，为空即用路径；显示名不分大小写唯一，路径同来源唯一。
    - **排序**：面板打开时读一次、打开期间冻结；点一行只应用，收起时才给最后应用的那条记最后使用。
    - **编辑**：改名，或用当前视图更新（先预览差异，确定才写），只读组合展示。
    - **移除**：popconfirm。
    - **嵌套弹层**：靠组件库的 `clickOutsideIgnore` / popconfirm `popperClass` 不关面板；紧凑档改对话框。
    - **画廊路径**：不再恢复上次浏览路径，`gallery-path` 全平台走 URL query；非画廊页点画廊过滤链接改为显式跳 `/gallery`。
  - 适用场景：
    - 改收藏视图的存储 / 排序 / 冲突规则；
    - 排查点编辑或移除时 ⋯ 面板被关掉、列表顺序不对或不更新、画册间收藏不共享、轮播来源 ↻ 不显示；
    - 排查画廊重启后视图被重置（预期行为），或在任务 / 畅游页点画廊过滤链接把本页路径冲掉。

- [gallery/LABEL_ALBUMS.md](gallery/LABEL_ALBUMS.md)
  - 主题：标签森林由内部节点 `label_dir` 与叶子 `label` 组成；目录只能装子画册、叶子只能挂图。涵盖同级 key（不区分大小写）唯一、v031 的 `label_key` / 派生列 `label_path`、目录/叶子按 PathQL 列举计数、`storage/labels.rs` 标识符规则、`ensure_label_path` 的目录段/叶子寻址与类型冲突逐项跳过、标签来源、`search/label` 的完整路径子串匹配与不相关 `IN` 子查询写法（为何不用相关 EXISTS / JOIN + group_by），以及分页查询树 / 选择器 / 预览面板。
  - 适用场景：新增或排查标签画册的建立、移动、改 key；插件下载或迁移没有挂上标签；标签搜索结果不对或变慢；给预览弹窗注入 app 侧信息面板。

- [gallery/COLOR_PALETTE.md](gallery/COLOR_PALETTE.md)
  - 主题：壁纸色盘（最多 5 个代表色 + 占比，`images.palette` 的 JSON 文本）与按颜色排序。
    - **提取**：`media::palette` 的四步（16×16 区域平均 → 按整张图的平均彩度定合并半径 → 从最密处取种子、按半径收点、成员取平均 → 再并一遍 → 按占比取前几个、再给鲜艳色留一个名额）与各自的理由；各类型的来源（图片读缩略图、GIF 原文件抽帧、视频均匀抽 8 帧、WPE 网页 / 场景取 `schemecolor` 作者值再退到预览图）；常量及依据。
    - **距离**：OKLab 色差（明度折半）按占比加权平均，0–65535，65536 留给没有色盘；算例与量程的理由。
    - **存储**：色桶表 `color_buckets`（主键即 rgb，12 个基本色桶 + 用户保存的最多 24 个）、关系表 `image_color_distances`，「每张图对每个色桶恒有一行」的不变量与维持它的三处写入（v052 铺行、`add_image`、保存色桶），删图 / 删色桶；v052 与回填作业 `image_palette`（只处理 `palette IS NULL` 的行，算不出的不重试）；整理的「重新计算代表色」（`recompute_palette`，与回填共用 `PaletteSourceRow` / `store_recomputed_palette`，算不出保留原色盘、没变不写，计数 `palettes_updated`）。
    - **查询**：两个排序段 `sort/by-color_0x<rrggbb>`（INNER JOIN 关系表、沿索引读、只认色桶）与 `sort/by-any-color_0x<rrggbb>`（宿主函数 `kb_palette_distance` 现算），两段同序、用哪个由调用方选；属性带 `0x` 是因为引擎会把像数字的属性值转成数字；`color_buckets://` 与 MCP 行的 `hex` 派生字段；列表字段 `palette`；实测耗时。
    - **命令与事件**：`add_color_bucket` / `delete_color_bucket`、错误码、`color-buckets-change`。
    - **前端**：`colorSortFor` 选段与色桶列表变化时的校正、排序下拉里就地展开的色桶面板、基本信息里的色带、回填补丁与字段依赖表的 `palette`。
    - **调参**：约 3.5 万张真实缩略图上的聚合方式、黄绿青色桶颜色、距离量程三张对比表与结论；已知的局限。
  - 适用场景：
    - 新增入库入口（必须算色盘并填 `ImageInfo.palette`）、改色盘算法或常量、改基本色桶；
    - 排查按颜色排序结果为空（颜色不是色桶却用了 `by-color`、色桶被删、纯数字颜色被数字化）、新图或存量图排在最后、两个段顺序不一致、排序变慢或执行计划不走 `idx_image_color_distances_bucket`；
    - 排查基本信息里没有色带、回填期间网格反复刷新、保存色桶很慢或被拒、删色桶后视图 / 轮播为空；
    - 排查某类图的代表色不对（淡色图只剩 1 色、视频只取到第一帧、WPE 壁纸的颜色来源）。

## 本地文件夹（`local-folder/`）

- [local-folder/LOCAL_FOLDER_SYNC.md](local-folder/LOCAL_FOLDER_SYNC.md)
  - 主题：本地文件夹同步的 `fs_listener` / `synchronizer` 双管道、路径集合 + `stat` 分类、逐画册 slot 与并发限制、全量/diff 触发矩阵、文件与文件夹删除语义、`make_visible` 唤醒 + 500ms 快照轮询、延迟卡片和逐任务 toast；并记录手动增删边界（Del/右键删除源文件、拖入经 `local-import` 扁平复制到 `sync_folder`、新文件探测到下载占用标记即放弃导入并由下载器补挂、数据库成员写守卫保持只读）；以及 **WPE 壁纸子目录按「文件」对待**（挂到父画册、不建子画册、目录内部变化忽略、整个目录消失即删行，已有子画册的目录保持原样，快速路径下存量目录要等下一次变化才识别）。
  - 适用场景：新增或排查本地文件夹监听与同步；理解目录删除为什么保留图片行；维护取消、抢占、进度和事件溢出行为；排查同步目录里的 Wallpaper Engine 壁纸被拆成散图 / 多出子画册 / 删目录后行还在。

## Wallpaper Engine 壁纸（`wpe/`）

- [wpe/WPE_IMPORT.md](wpe/WPE_IMPORT.md)
  - 主题：目录型 WPE 壁纸的入库模型（`local_path` 是目录、`type` 为 `x-wpe/*`，`plugin_id` / metadata 由宿主定为 `wpe-import` + `project.json`）、
    **四个入口共用的入库函数 `ingest_wpe_dir`**（`wpe-import`、local-import、插件下载经 `postprocess_downloaded_image` 的目录分支，文件夹同步直接调用；
    原地入库按路径幂等，下载产物整目录移到下载目录、去重命中时删除）、**目录哈希**（`wpe::dir_hash`：相对路径排序 + 域前缀，`hash` / `size` 取整个目录，
    存量行由回填作业 `wpe_dir_hash` 重算）、**经 Web 服务器传输**（`/file/<目录>` 返回文件清单、目录内文件流式返回，`kabegame-server` 插件 + SDK
    `downloadWpeWallpaper` 把另一台机器上的壁纸整目录传过来）、格式表占位条目、
    **`wpe` feature 门控**（桌面主程序与 CLI 开启，Android / Web 不开；三个桌面平台都能导入与预览，Linux 没有桌面壁纸）、Steam 库发现与手选文件夹的两层扫描、导入时的 `WPE/<genre|rating|feature>/<tag>` 标签（作者 `tags` + WPE 工坊缓存的 Steam 标签，缓存没有时从 `project.json` 推导；key 是 Steam 原文，名称按语言翻译）、WPE 安装目录设置 `wpeEngineDir`（为空时查 Steam 库或从库内壁纸往上找并写入，壁纸设置可覆盖）、`wpe-import` 内建任务与「壁纸」收集入口、
    WPE 行的色盘来源（视频从 `compatible_path` 抽帧，网页 / 场景取 `schemecolor` 的作者值、没有则预览图）、
    删除 / 整理 / 虚拟盘 / 原生壁纸的按类型分流护栏，以及壁纸窗口复现作者视频属性（作者值取自图片 metadata + Kabegame 覆盖）；壁纸窗口（窗口模式每块在线屏一个，label 池见 [wallpaper/MULTI_SCREEN.md](wallpaper/MULTI_SCREEN.md)）为 `index.html?window=wallpaper&slot=<序号>` + `WallpaperWindow.vue`（IPC / init 看门狗 + 后端 ping 看门狗 / 握手，按后端的布置读壁纸目标）+ 纯渲染组件 `WallpaperStage.vue`；
    **web 导入与预览内嵌**：`x-wpe/web` 入库（`compatible_path` 为空）、`WallpaperStage` 独立 web 层（sandbox `file:` iframe，`src` 直接取壁纸目标的 `webEntry`，由补丁 05 允许应用页赋 `file:` src；不参与双层过渡、切走即销毁）、
    `ImageContent` 的 `wallpaper` 形态 + `WpeWallpaperContent` + 预览画布 `WallpaperPreviewCanvas`（按内容固有尺寸，和单独的图片一样显示；网页壁纸按主屏尺寸排版）、`get_wallpaper_target_for_image`、应用背景与预览同走原图形态实时渲染（不交互、静音），以及子 frame 也有 IPC 桥之后由 ACL 兜底的纵深防御；
    **网页壁纸 iframe**（tauri 补丁 18–19 起预览与桌面统一）：图库预览（主窗口）与桌面（壁纸窗口）都是 `WallpaperStage` web 层里的 `file:` iframe，两个窗口建窗前都登记 `allow_file_documents` 与 `allow_app_local_resources`，壁纸窗口不再整窗导航，窗口后端的 `set_wallpaper` 只开关 Windows 轮询式鼠标移动 / 左键转发（`set_mouse_forwarding`、`input_forward`、`inject_mouse`，壁纸窗口给 Stage 传 `interactive`）；ping 在网页壁纸显示期间交给 iframe 里的垫片应答；`localStorage` 预览与桌面同一分区、互通；CSP `frame-src … file:`；
    **网页壁纸目录索引**：`wallpaper/wpe_web_dir_index.rs` 在 `init_heavy_globals` 里 Storage 就绪后、Services 前先订阅图片事件再全量扫描（`list_wpe_web_rows` 走 `idx_images_type`），向 runtime 注册 `set_file_scope_resolver`，随图片事件维护；`file:` 文档只能访问自己的壁纸目录与它的用户选择、应用页发起的 iframe 导航只能落进库里某个网页壁纸目录，建表失败时全拒；
    **运行时垫片与宿主协议**：all-frames 垫片 `wpe_shim.js`（只在顶层直接子 `file:` iframe 且有子 frame 桥时启用）、一种传输（直接 `invoke("wpe_web_pull_state")` 与 `listen`，命令按 `CallerOrigin` 的文档 URL 认出是哪张，事件只投递到本 frame、frame 销毁时随 `SubframeDestroyed` 清掉，首批请求由 CEF 07 文档头直接归属）、语言（`setting-change`）与本张 `metadataId` 补丁触发重拉、load 后首次全量 + 之后按键差异 + 换 listener 补投 + 拉取编号丢弃乱序、运行时按 initiator 与 CEF 07 文档 URL 合成 IPC `Origin`（远程 `file:` 来源 + `frames: "sub"` 只得 `wpe-web-capability`，绑定 `main` 与 `wallpaper`），以及网页壁纸只能监听四个事件（`allow-listen` 作用域，tauri 补丁 15）；**音量**：垫片经 `postMessage` 向父页面 `WallpaperStage` 要宿主音量（`kabegame:wpe-volume-request` / `kabegame:wpe-volume`，协议在 `wpeWebVolume.ts`，只认 `isTrusted` 且来自父窗口的消息，回复前按静音），桌面与预览回设置里的壁纸音量、应用背景与 `paused` 回 0，变化时父页面主动推；垫片把它乘到 `HTMLMediaElement`（接管 `volume` / `muted` / `play`，页面读到自己设的值）与 Web Audio（连到实时 `destination` 的连接改接到每个 context 一个主增益，不 `suspend`），嵌套 iframe 的声音与经嵌套 frame 拿原始原型的绕过管不到；**右键**：垫片（场景宿主也加载）在捕获阶段把可信的 `contextmenu` 经 `postMessage`（`kabegame:wpe-contextmenu`，`wpeContextMenu.ts`）交给父页面，`WallpaperStage` / `WpeSceneView` 校验来源、按 iframe 显示矩形换算坐标，预览弹窗在那里弹出上下文菜单；
    **图库媒体走 `file://` 与按发起 frame 分档的闸门**（Phase 6b，CEF 补丁 06）：三个桌面平台的主窗口与壁纸窗口都登记 05，应用页主 frame 的 `<img>` / `<video>` / CSS 子资源免检，子 frame 导航与 `file:` 文档按网页壁纸目录索引裁决；前端 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 在桌面产出 `file://`，下载 / 复制兜底直接 `fetch(file:)`、Windows 拖出自 Phase 6d 起改走 03 真实文件链路（`CF_HDROP`）；插件详情 EJS iframe 改 opaque origin + 内层 CSP；删除桌面本地 HTTP 服务；插件文件改由 Tauri 原始字节命令读取，06 的私有 CORS 列表与运行时跨源白名单开放 `fetch(file:)`。
    **用户属性面板**（Phase 7）：作者属性在预览右栏 / 设置页「当前壁纸」编辑，用户值存图片 metadata 顶层 `userProperties`（只存与默认值不同的键），写入经 `Storage::rewrite_image_metadata` 事务改写（新行 + 改指 + 删无引用旧行、沿用搜索词）后发 `metadataId` 补丁，垫片与面板都按它重拉；属性定义在 core `wpe::user_props` 解析一次，WPE 内置 `ui_` 词条只读读取用户 WPE 安装目录的 `locale\ui_<码>.json`；显示条件是照 WPE `$parse.readOnly` 的白名单解释器（不 eval、失败当显示）；`file` / `directory` 的放行由网页壁纸目录索引按当前 metadata 覆盖（`metadataId` 补丁到达与 `wpe_web_pull_state` 返回前各写一次，改目录后旧目录立即不可读），目录文件列表进状态，垫片实现目录回调与 `wallpaperRequestRandomFileForProperty`。
    **封面**：预览的右键菜单与工具条把当前画面设为壁纸封面（与暂停、清空脚本存储同为预览专属菜单项，由预览弹窗处理、画廊菜单没有），截主窗口整窗（不用 `clip`，它会让整个窗口跳变）再按画布比例裁，写进 `thumbnails_dir`、换 `thumbnail_path`，作者的 `preview.*` 不动、可恢复；画面确定实时渲染之前置灰（场景看 `WallpaperStage` 的 `sceneLive`，网页看 `ready`），后端不记实时状态，恢复默认封面在详情栏，设置页没有封面按钮；
    **音频与媒体集成**（Phase 8，只 Windows）：页面登记音频 / 媒体监听时垫片调 `wpe_web_media_subscribe` 交出 Tauri Channel（只回本 frame），订阅按 `(label, SubframeId, 类型)` 归属调用方 frame（tauri 补丁 18 公开 `ipc::CallerFrame`），`SubframeDestroyed` 即释放、同 frame 同类替换、窗口销毁释放整个 label（Channel 发往已销毁 frame 被静默丢弃、发送不失败，不能靠发送失败）；`WpeMediaHub` 有订阅才开 WASAPI 回环（33ms 一帧、定时器与采集包解耦、静音补零衰减）与 SMTC 监视（设置「媒体集成」`wpeMediaIntegration` 默认开），自定频谱算法常数在 `SpectrumTuning`，封面 PNG data URL 与量化直方图配色 `rgb()`；`audio` 只对 `supportsaudioprocessing: true` 放行。
  - 适用场景：新增 WPE 类型或阶段（web / scene）、排查壁纸目录被当文件处理、
    本地导入把壁纸目录拆成散图、同一张壁纸入库两次或去重不命中、下载的壁纸目录没有移到下载目录 / 临时目录有残留、
    `/file` 取壁纸清单或目录内文件 404、mac 上经 `kabegame-server` 传 Windows 壁纸失败、
    删除记录误删 `preview.*`、整理误删目录行、WPE 壁纸在非窗口模式下不可用，或想了解视频属性来源；修改壁纸窗口的渲染 / 过渡 / 入口分发；
    排查网页壁纸白屏 / iframe 被 CSP 拦截 / 页面 `fetch` 同目录文件失败或越界读被放行（`deny file:` 日志，看 `requester`）/ 新导入的网页壁纸被闸门拒绝（目录索引没跟上）/ 预览画布比例或交互 / 切走后渲染进程未回收、非 Windows 平台的 WPE 行为；
    排查网页壁纸页面调用应用命令被 ACL 拒绝 / 收不到属性 / 改语言后页面没反应 / 桌面点击或移动不触发页面事件；
    排查壁纸或网页壁纸卡死、白屏不自动恢复（ping 由谁应答）；
    排查网页壁纸 iframe 的事件监听残留、切换后仍在投递；
    排查桌面图库图片 / 视频不显示（`ERR_UNKNOWN_URL_SCHEME`、图库媒体被误判 `deny file:`）、下载拿到 `file://`、插件详情模板的请求被 CSP 拒绝。
    排查属性改了页面不变 / 预览与桌面不同步 / 草稿串到下一张、属性标签显示 `ui_` 键名、显示条件显隐与 WPE 不一致、`file` / `directory` 属性选的文件被 `deny file:` 或目录回调不触发；
    排查网页壁纸频谱不动 / 一直满格 / 静音后不回落、没有歌名封面或进度、切走壁纸后仍在采集或订阅数不降、音频订阅被拒；
    排查网页壁纸音量不跟壁纸音量设置、开着应用背景时背景也出声、页面一打开先响一下或一直没声、页面读到的 `volume` 被改；
    排查在预览的网页 / 场景壁纸上右键不弹菜单或菜单位置不对；排查「设为壁纸封面」「暂停」菜单项不出现、一直置灰或过早可用、封面截到残缺画面或带上看板娘、截取时窗口跳变、恢复后封面不对；
    排查导入后缺标签或标签与 WPE 显示不一致、标签名称没翻译或语言不对。

- [wpe/WPE_SCENE.md](wpe/WPE_SCENE.md)
  - 主题：场景壁纸（`x-wpe/scene`）的前端渲染路线：WebGPU 在 `WallpaperStage` 的 scene 层、前端 `fetch(file:)` 读资源、前端编译，Rust 只做导入；以及着色器翻译器 `wpesl2wgsl` 的摘要。翻译器的完整契约见 [../src-tauri/wpesl2wgsl/README.md](../src-tauri/wpesl2wgsl/README.md)：
    - **构建**：编成 wasm、不链进应用；`deno task build:wpesl2wgsl` 产出到 `bin/wasm/wpesl2wgsl/`，kabegame 命令不带 `--skip vue` 时拷进前端，缺失只告警。
    - **输入**：WPESL 原文、头文件（缺失时返回 `missing` 让调用方重试）、COMBO 与绑定的纹理。
    - **输出**：WGSL 与反射（共用的 std140 uniform 块、纹理绑定 `1 + 2n` / `2 + 2n`、location、COMBO 来源）。
    - **语料**：本机语料 2026-11-12 为 161/167，全部场景实际发出的请求全部通过（P7）；naga 源码嵌在翻译器里，GLSL 前端加了照 fxc 的 HLSL 隐式转换模式，翻译器照 WPE 自己的预处理与改名规则；请求夹具重放与逐字节基线防回归。
    - **`scene.pkg`**：移植自 linux-wallpaperengine 的目录表读取，前端经带 `Range` 头的 `fetch(file:)` 按条目区间读（`wpe-scene/compile/pkg.ts`）。
    - **编译管线**（`wpe-scene/compile/`）：资源按项目散文件 → `scene.pkg` → WPE `assets/` 查找（`file:` 响应没有长度，散文件不探测大小；effect 内的资源按 effect.json 所在目录与来源排先后），产出渲染器唯一输入 `SceneBundle` 与 `unsupported` 能力键；Worker 编译、主线程代读文件，读取错误回传时保留类型；确定退回就停止编译（`exhaustive` 列全）。
    - **能力表**（`features.ts`，P2a）：只报真正改变画面的特性，中性字段逐项写明依据；着色器不按名字白名单，改核内置 uniform（`ENGINE_UNIFORMS`）、引擎 COMBO 与 `_rt_*` 默认纹理；effect 逐项检查；场景脚本由 P3b 运行，运行期的脚本错误不进 `unsupported`。P4a 起粒子细分成 `particle:*`（从模块表生成），关键帧值报 `value:animation`，`object:parent` 只剩灯带父对象，父链成环报 `object:parent-cycle`，风、重力键实测中性，`perspectiveoverridefov` 解析给透视粒子，`alphawriting: "default"` 放行。
    - **脚本 API 检查**（`compile/scriptApi.ts`，2026-11-07 改定）：编译期扫描会执行的脚本，用到 WPE 有、我们没实现的 API（表来自 WPE 自带的 `lib.sceneScript.d.ts` 减去已实现部分，实现一个删一个）报 `script:api:<分组>.<成员>`、整张退回；推翻了 P3b「不做静态扫描」的约定，起因是 3304642534 的音频条静默缺了一整组。P6 前置起，导出了运行时还不调的回调（`cursor*`、`media*Changed` 等，表 `MISSING_SCRIPT_CALLBACKS`）报 `script:callback:<名>`。
    - **场景后处理档位**（`postprocess.ts`、设置 `wpeScenePostprocess`）：跟随 WPE 时只读 `<WPE 安装目录>/config.json` 的 `postprocessing`，按 WPE 规则判定场景实际的泛光 / HDR（HDR 也认属性对象的生效值）与泛光参数缺键默认值；`WpeSceneView` 随 `setting-change` 重新加载，HDR 切换重建场景目标格式。
    - **泛光与 HDR**（P2b，`compile/bloom.ts` + `render/bloom.ts`）：全部图层之后拷一次快照跑泛光链，着色器全用 WPE `materials/util/` 原件翻译；LDR 1/4 → 1/8 → `_rt_Bloom` → `combine_ldr`；HDR 场景目标 / 快照 / 合成 RT 为 `rgba16float`、颜色乘 `brightness`，最多 8 级金字塔（名义纹素 `g_RenderVar0`、SrcAlpha/One 上采样、最粗两级 bicubic、float32 参数换算），收尾用 `combine_hdr` 的 `LINEAR` 变体（8 位画布上与 WPE 的 `saturate(lin())` 逐值等价）；关闭档与 P2a 逐字节相同。P3c 起 `general.bloom` 每帧读，开关与级数就地（金字塔建满全部可用级），HDR 只在加载时判定。dev 探针 `window.__kabegameSceneProbe`（`wpe-scene/dev/`，生产构建摇掉）做链路隔离验证（RenderDoc 快照 → 我们的泛光链 → 与 WPE 逐像素比）与固定时刻渲染读回。
    - **壁纸样式与留白**（`render/layout.ts`、`sceneStyle.ts`、`wpeSceneStyle.ts`）：上屏时按 Kabegame 样式铺放，几何同图片层，宿主启动时经 postMessage 取样式、变化时父页面推，改样式不重编译；`fit` / `center` 的留白是 `schemecolor`（WPE 的规则，用户值已并入属性全集，改色就地生效），非铺满样式下指针换算到场景上；场景分辨率在导入时写进 `images.width/height`（Rust 只从入口 json 或 `scene.pkg` 里取这一项），预览据此按场景比例显示。
    - **FreeImage `.tex`**：PNG / JPG mip 由主线程 `createImageBitmap` 解码并跨重新编译缓存（`decode.ts`），纹理尺寸取头里的图像尺寸（UV 为 1）。
    - **材质常量取值**（`compile/materialValues.ts`，2026-11-08 对齐 WPE，`p4b-vec` 实测）：数字进向量铺满、字符串进向量按空格切、float 只收数字、缺省先转字符串、属性值与脚本写回走同一个 setter、就地写整体重写；翻译器只在材质键不同时拆两阶段同名 uniform，同键合并取片元注解。
    - **渲染器**（`wpe-scene/render/` + `components/wallpaper/WpeSceneView.vue`）：WebGPU，RGBA8 / BC3 / 位图纹理、std140 uniform 打包与内置 uniform（P2a 起按 WPE 校正：空槽分辨率、`Texel`、`g_Screen`、`g_Time` 回绕、窗口坐标的指针、效果矩阵）、混合照 LWE，场景分辨率离屏目标再 cover 到画布；Tint 前言 `diagnostic(off, derivative_uniformity)`；`WpeSceneView` 自读用户属性与后处理设置、按 `metadataId` 补丁重编译，不能渲染时 emit `fallback(reasons)`；dev 下 `localStorage["kabegame-dev-scene-force-render"]` 强制渲染半成品。
    - **图层渲染图**（`render/graph.ts`，P2a）：直接上屏（P1 路径）或「基础 pass 关混合画满合成 RT → effect ping-pong（fbos / bind / target / compose / copy / swap）→ 最后一个启用 effect 的最后一个绘制 pass 借基础材质 blend 上屏」；合成 RT 数 min(2, 写进合成链的次数)；colorBlendMode 31 → additive，其它非 0 → passthrough（`scene.json` `version` > 2 用 genericimage4）；`_rt_FullFrameBuffer` 是 `copyTextureToTexture` 快照，每图层至多一次。P3c 起 effect `visible` 绑属性或挂脚本时进 bundle，`variantPlans` 加载时预建管线，运行时单图层同步切换。
    - **general 字段**（P3c，`GENERAL_FIELDS`）：清屏色、环境光就地，`clearenabled: false` 用两张场景目标交替对齐 WPE 的 N−2 累加，HDR 下底图过一次 `lin`；相机不能绑，`g_EyePosition` 是 `(W/2, H/2, 2000)` 加本帧的抖动偏移（P5a）。
    - **属性快速路径**（P3a）：编译期每处 `{user}` 登记成绑定表（属性名 + condition → 图层字段 / 材质常量 / 泛光参数 / 重编译原因，目标用 scene.json 坐标做稳定键）；宿主一个应用函数（加载传全集、运行时传增量）把增量分成就地写与重编译，就地写落在不依赖 GPU 的 `SceneState` 上、`GpuScene.sync` 下一帧刷 uniform / 图层可见性 / 泛光链；只有 `general.hdr`、`colorBlendMode`、`size` 仍重编译，文档有和 WPE 的对照表；`visibleBound` 的图层不可见也建资源、`encode` 整段跳过；COMBO 绑用户属性报 `combo:user-binding`，条件可见不再退回；面板写库尾随 300 ms 去抖，拖动中场景不跟手。
    - **光照**（`#require LightingV1`）：`#require` 是预处理期现场生成源码，`LIGHTING=0` 时为空；灯数取 `general.lightconfig` 不数灯对象，`point` 是遗留灯；宿主 `compile/lights.ts` 算 uniform，经 `litDefines` 传 `LIGHTS_*`，`HDR`、`SCENE_ORTHO` 经 `engineDefines` 全局传（`#ifdef HDR`，关闭时不写键），`TEX<n>FORMAT` 只给声明 `formatcombo` 的槽位；边界是无 effect 图层，其余报 `lighting:*` / `lightconfig:*`。
    - **场景脚本**（P3b）：宿主内同源 `about:blank` realm 以 `file:` 经典脚本加载 `baseclasses.js`，用户源码各自作 blob 模块；按场景生成 import map 查 WPE `jsmodules`；`init` / 属性回调 / 帧计时器 / `update` 的写回进入 `SceneState`，重编译保留 realm 并重放写入；回调出错只禁用该回调。含环境改写、持久 `localStorage`、音频缓冲、API 清单、缺口、语料结论与 dev 探针。
    - **层级**（P4a）：世界矩阵 `W_parent · T · Rz·Ry·Rx · S` 沿父链累乘（实测四角差 6.1e-5 像素），`visible` 沿父链继承、`alpha` / `color` / `brightness` 不继承，分组节点只有变换；改父层变换或可见性时子孙一起标脏；写死不可见的祖先下面不建资源（`buildableLayers`）；成环断边并退回，灯带父对象仍报。
    - **粒子**（P4a，`particles/` + `compile/particles.ts`）：模块表是唯一事实来源，解析、能力表与模拟器分发读同一张表；模拟器纯 TS、float32 定长列、共用 `R`、模块按 JSON 顺序、帧内顺序照 WPE、两遍模式接 `maxFps`、预热固定一遍且步数按 float32、发射欠账；绘制按 `objects` 顺序与图像层混排，每粒子 4 顶点、偏移按反射布局，透视粒子相机反向 Z，正交深度 ±2000，帧时间钳到 `[0.0001, 0.25]`；`instanceoverride` 就地从基值重乘；隐藏清空、重新显示不预热、暂停不步进；每层约 0.1 ms，P4a 不设 `maxcount` 上限；dev 探针 `particleTrack` / `particleCorners` / `renderFrame` 的确定性回放 / `host.particles`；对比工具是 `kbp-tools` skill（数据在 `ignore/p4/`），抓 WPE 帧用 `wpe-renderdoc` MCP，驱动 Kabegame 用 `kabegame-dev` MCP。
    - **粒子与纹理**（P4b）：纹理格式表 `TEXTURE_FORMATS`（`compile/tex.ts`，0 / 4 / 6 DXT3 / 7 DXT1 / 8 RG88 / 9 R8，原样上传、不转通道，alpha-priority 实测中性）；粒子帧表只看槽 0（TEXS 解析、`SPRITESHEET*` / `THICKFORMAT` 宏、`g_RenderVar1`、frame 列与 `a_TexCoordVec4C1`，图像层帧动画仍报 `tex:animation`）；发射时序（`duration` / `delay` / emitter `flags` bit1、bit2 周期发射）、`boxrandom` 与档 2 模块；噪声 `snoise1/2/3` 逐位移植 WPE，场景时间 `T` 取本帧 `g_Time`；`REFRACT` / `CUTOUT` / `NORMALMAP`（每个折射对象前一次快照）；`instanceoverride.colorn`（系统色 + HSV 平移，scene.json `version` < 5 或没有颜色模块时再乘 `colorn`，改色就地生效）；近似倒数不复刻、验收按误差包络放宽；能渲染 14 → 20 张。
    - **控制点、世界空间与拖尾**（P4c）：控制点是系统的一份状态（`particles/controlpoints.ts`，个数 = 模块引用的最大下标 + 1，`base = I + offset`，每帧发射前更新一次；`flags` bit0 跟随指针、bit1 场景坐标、bit2 在顶层系统只让实例覆盖不生效，JSON `angles` / `locktopointer` / bit3 / bit4 中性；`instanceoverride` 控制点静态值替换平移与 3×3）；指针点是光标下的场景点：`sceneCursor` 按壁纸样式的铺放反算（`fill` 等于 WPE 的居中盖满裁切，`fit` / `center` 留白外推），`pointerScenePoint` 照 WPE 反投影，和 `g_PointerPosition` 只在 `fill` 下不同，开场由应用页问一次真实光标（`wpe_scene_cursor`，P5a 收尾）、之后在收到 `pointermove` 时更新；`controlpointattract` 改速度、乘 `k`、缺省钳制开，`origin` 中性，删除判定按位移线段；世界空间系统模拟时乘 `W`、发射器 `origin` 不经 `W`、绘制用单位阵，`movement` `flags` bit0 只在本地系统变换重力；一帧里粒子先于脚本步进（`sync` → `stepParticles` → 脚本 → `sync` → `update`）；`spritetrail` 的宏与 `g_RenderVar0`，`sprite` 三种朝向在 CPU 上按绘制模型矩阵现算，退化的拖尾粒子与 NaN 朝向不画；多 renderer 照报；能渲染 20 → 22 张（`1838478131`、`3832772446`），带粒子的场景里粒子用法完全覆盖 22 → 44 张。
    - **绳、映射与距离类**（P4d）：`rope` / `ropetrail` 的 pass 一律换成 `genericropeparticle`，翻译器把几何着色器展开进顶点着色器（请求带 `geometry`，每段一个实例、按实例步进的三角形带、`draw(maxVertices, 段数)`，零向量 `normalize` 整段落到裁剪体外，规则见 wpesl2wgsl README）；rope 表是出生序、判死保序删除，段顶点与 `TL` / `TP0` 照 WPE（`Rf = min(fps, R)` 的 `fps` 是宿主帧上限），存活数 2 特例、≤ 1 不画；ropetrail 每粒子位置历史、每系统计时器（余量丢掉、每帧最多采一次、预热后塌缩），`g_RenderVar0` 每帧写，渐隐只在 `uvscrolling` 时生效；`mapsequence*` 是第一批带状态的 initializer（序号复位时清零，between `flags & 0x20` 新周期清零，around 的残留字按「不乘 `count` 覆盖」实现、配周期发射照报 `…:periodic`）；`remap*` 一条管线两种变体（18 处，`particlesystemtime` init 是系统时间 / op 是场景时间，op 噪声是 FastNoise2 加 `R` 种子，写控制点置 `0x10000`、op 只写 lane 0，init 的控制点输入把点写成 0），`timeofday` 与 op 输出 `maxlifetime` 照报；距离类读 `previous`、两遍模式平移两次，`vortex_v2` 切向乘 `k`，两处 WPE 的「相等时存 1.0」照做；对象不可见时照常更新控制点、系统时间照常累加、不发射；近似倒数不复刻（`remapvalue` 输出 `speed` 过零可能整段反向、maintaindistance 的 `rsqrtps` 随机游走）；只解锁 `2254685070`，粒子用法完全覆盖 44 → 57 张（152 张口径）/ 46 → 61 张（165 张口径）。
    - **相机**（P5a，`render/parallax.ts` / `shake.ts` / `layout.ts`）：视差点 P 每帧一次（指针钳到 0…1、y 翻转后按 `mouseinfluence` 插值，`delay` 一阶平滑、k 用本帧 dt，P 不钳制、`g_ParallaxPosition` 钳制；初值是 WPE 相机缺省 eye 带来的 (W/2 + 2, H/2 + 2)，关掉视差时冻结），每次绘制按根对象的 `origin` 与 `parallaxDepth` 右乘平移（effect 中间 pass 与透视粒子也带，合成 RT 的基础 pass 与粒子模拟不带）；抖动是按 `g_Time` 的确定性正弦、按 float32 算（`roughness 0.1` 正好在临界上），加到 eye、视差点与 `g_EyePosition`；`zoom` 绕场景中心缩放正交投影，透视粒子的相机距离跟着变；一帧里先求相机、粒子用上一帧的相机模拟、脚本之后才定绘制用的视差；开场由应用页问一次真实光标（`wpe_scene_cursor` → `kabegame:wpe-scene-pointer`，只在可交互时）；前置修正材质 JSON 注释、translucent / additive 不写深度、`cropoffset` / 对象 `config` 中性、模型布尔键只认 `true`；测试工程和 WPE 整帧 0 差异，能渲染 23 → 36 张；dev 回放收逐帧光标（时间线 `cursors: "log"`，kbp 日志五列）。
    - **图像模型标志**（P5b，`compile/bundle.ts` / `render/graph.ts` / `render/scene.ts`）：尺寸照 WPE 的顺序（模型宽高 → 对象 `size` → `autosize` 覆盖成槽 0 图像尺寸，`projectlayer` 取正交投影，三者都缺 1×1）；UV 内缩分两块（直接上屏看 `fullscreen` / `nopadding` / `passthrough` / `solidlayer`，末 pass 不看 `nopadding`）；图像层 `perspective: true` 在上屏时换透视粒子的视图投影；组合层（passthrough 模型）的基础 pass 按 `copybackground` 画 composelayer 着色器（图层 MVP 采快照）或清成透明，无 effect、无子层、cbm 0 / 31 时不画，合成 RT 按 `size`；`fullscreen` 是 2×2 NDC 四边形，带 effect 时快照拷进合成 RT 0、上屏用 NDC 正交；带子层的组合层（组）编译期定归属与先序子树，子孙画进组的合成 RT（局部正交 `inverse(W_组)`，`copybackground: false` 时 alpha 取 MAX，无 effect 时用 `effectpassthrough` 上屏），组里读快照 / fullscreen / 透视照报；`instanced` 纯色图层用对象 `instance` 覆盖材质的 `combos` / `textures`，合成 RT 仍按纹理图像尺寸（`util/white` 32×32）、不内缩，`usertextures` 照报；纹理标志 `0x20` 是视频位（更正读码）；测试工程和 WPE 整帧最大差 2，解锁 `1923929928`（`1333579536` 加 P4e 一起）。
    - **声音**（P6a，`compile/sounds.ts` + `audio/`）：声音对象进 bundle 的声音表，排期器（纯 TS）照 WPE 实测复刻 `loop` / `single` / `random`、`startsilent`、音量为 0 不开始等规则，播放后端用媒体元素 + Web Audio、不整段解码（散文件 `file:`、pkg 条目按区间读成 Blob）；增益 `min(1, volume²·h) / h`，宿主音量 h 由垫片放进只读的 `window.__kabegameHostVolume`；渲染器在粒子之后、脚本之前推进；声音层的脚本对象有 `ISoundLayer` 的 `play` / `pause` / `stop` / `isPlaying` 与 `volume`（步骤 2）；有粒子层的场景里任意接收者访问这四个名字照报 `script:api:particle.*`（P4f 实现）；单声道比 WPE 响约 4 dB 是已知差异。
    - **scene 层**（`WallpaperStage`，P1-5）：web 层之上独立一层、同一时间一个 `WpeSceneView`；loading → live / fallback（结果出来前不显示、不发 `ready`，桌面保留上一张；能渲染直接淡入，退回或 10s 超时才显示壁纸目标的 `previewPath`）；场景 → 场景有短暂空档；壁纸样式由宿主铺放；属性面板对场景隐藏 `file` / `directory`；应用背景与预览同走原图形态、实时渲染且不交互；壁纸窗口实测不被判为隐藏（rAF 144 Hz）。
    - **预览画布尺寸**（`canvasSize`）：画布像素 = 布局 × DPR × 父页面量的显示缩放（`kabegame:wpe-scene-display`，iframe 里量不到祖先 transform），超上限等比缩、250 ms 核对；脚本 `engine.screenResolution` 按缩放 1 算；`center` 是一个场景像素对一个布局 CSS 像素。
    - **场景宿主**（P3-0，进行中）：场景宿主是一种特殊的网页壁纸。独立的纯 TS + Vite 项目 `apps/wpe-scene` 构建进 `resource_dir/wpe-scene`（dev 直接写 `target/debug/resources`、不经 tauri-build，prod 进 `src-tauri/kabegame/resources` 打包）；`get_wpe_scene_host_url` 给应用页 `file:` 地址，应用页附 `kbScene` / `kbInstance`；解析器给宿主目录专门范围（宿主目录 + WPE `assets` / `config.json` + 库内全部场景目录，场景目录随图片事件维护）；网页壁纸的命令与事件经 `wpe-web-capability` 照常可用，场景专用命令由按确切地址运行时注册的 `wpe-scene-host-capability` 放行。P3-0a 已接通属性拉取、`wpe_scene_target`、暂停与音量、`wpe_scene_report` 状态和日志；P3-0b 已把编译、渲染与探针迁进宿主；CEF 08 使子 frame 不跨窗口复用渲染进程，CEF 09 使同进程 iframe 每帧只派发一次 rAF。实测表含 Worker 不能 `fetch(file:)`、`localStorage` 与网页壁纸共用（允许）、同窗口 `file:` frame 互相可达（接受）。
    - **字体引擎 `wpefont`**（P6b 1b 起）：FreeType 2.14.3（`third/freetype`）+ HarfBuzz 15.0.0（`third/harfbuzz`）+ C 胶水 `src-tauri/wpefont/`，`deno task build:wpefont` 编成 wasm32-wasip1 reactor（首次经 `scripts/download.ts` 的 `fetchPinned` 下 wasi-sdk 34 工具链，要带 wasm32 目标的 LLVM clang），`WpefontPlugin` 拷进宿主；`src/wpefont/index.ts` 主线程加载（WASI 桩、失败返回 null 并留原因），排字与度量 26.6、位图拷出、另给 `FT_LOAD_NO_BITMAP` 的轮廓框（几何用，1c）；300 DPI、两条 hinting 规则（TrueType 没有 `fpgm` 强制自动 hinting，CFF 走原生）；宿主 `file:` 范围逐个放行 `%WINDIR%\Fonts` 下 13 个系统字体文件；版本依据是 1a 和 WPE 图集的逐像素对照，子模块版本与 1a 发布包逐字段相同。
    - **文本对象**（P6b 1d 起，静态文字）：编译期 `compile/texts.ts` 规整字段、定位主字体、编四个 WPE 自带材质（`basefont` / `basefontrgba` / `fontbackground` / `composelayer_clearalpha`）；宿主主线程 `text/host.ts` 的 `SceneTexts` 在建 GPU 资源前排好全部文本层（wasm 与字体跨重编译保留、每次加载新建图集），经 `GpuScene.build` 的 `texts` 交给渲染器；渲染图的 `text` 步骤（直接上屏「背景 → 字形 → 彩色字形」，合成路径先清成背景色或 clearalpha 再画字形、之后 effect 链照图像层），矩阵 `textMatrices`，图集是运行时纹理（`render/text.ts`）；能力键 `text:script` / `text:script:<键>` / `text:msdf:<键>` / `text:anchor:<值>`、`text:engine`；六个测试工程和 WPE 整帧逐像素相同。
  - 适用场景：开发 scene 渲染的任一 Phase；构建或升级字体引擎 `wpefont`（`build:wpefont` 找不到 clang / 工具链下载失败、字形或步进与基线不同、宿主读不到系统字体）；排查文本场景退回（`text:*` 键、`text:engine`、`render:text-layout`）、文字位置 / 换行 / 背景色 / 彩色 emoji 与 WPE 不同、文本层上的 effect 画面不对；搭建或排查场景宿主 iframe（加载不了、`deny file:`、宿主 IPC 被拒、dev 下宿主产物不更新）；读创意工坊场景的 `scene.pkg`；改着色器翻译规则；排查某个 WPE 着色器翻译失败或输出的 WGSL 被拒；调整 wasm 构建链；排查场景资源找不到、编译慢或请求过多、`unsupported` 误报 / 漏报；排查 effect 链 / colorBlendMode / 快照画面不对、改「场景后处理」后场景没重新判定、改属性时 4K 纹理重复解码；排查改属性后画面不变、明明能就地改却整场重编译、条件可见不切换、拖动滑块跟不跟手；排查 `LIGHTING` 材质、灯对象、`lightconfig` 的画面或不支持项；排查场景脚本不生效、报错或被禁用、灯带颜色不动、脚本写回后画面不变、`jsmodules` 找不到、改属性后脚本没收到；排查泛光 / HDR 与 WPE 不一致（用 dev 探针对 RenderDoc 抓帧做链路隔离）、HDR 下显存或帧时间；排查壁纸样式不生效、留白颜色不对、`fit` / `center` 下光标效果对不上、预览比例不对；排查场景画面与预览图不一致、动画不动、属性不生效、WebGPU / BC 不可用或 Tint 报错导致退回预览图；排查预览 / 桌面场景一直转加载、先闪预览图、切换时残留画布或多个 GPU 设备、桌面场景停帧；排查子图层位置 / 旋转不对、隐藏父层后子层还在、带父对象的场景仍退回；排查粒子场景退回（看 `particle:*` 键）、粒子数量 / 轨迹 / 尺寸和 WPE 不一致、改粒子属性后整场重编译或旧粒子被清掉、隐藏后再显示粒子瞬间涌出、透视粒子位置不对、粒子场景加载慢或掉帧；排查脚本场景因 `script:api:*` / `script:callback:*` 退回、实现了新脚本 API 或回调后表没删、本来能渲染的场景被误报、脚本导出的回调认不出；排查预览场景有留边、画面缩小或模糊、宽高比不对、`center` 下预览与桌面构图不同。排查 R8 / RG88 / DXT1 / DXT3 纹理颜色或通道不对、粒子帧表不播放 / 帧序不对 / 混帧不对、`tex:animation` 误报、`boxrandom` / 周期发射 / `duration` / `delay` 的粒子数和 WPE 不一致、湍流类粒子轨迹发散、折射粒子画面或快照次数不对、粒子颜色和 WPE 不同（`colorn`、场景 `version`）、改粒子颜色属性后存活粒子变不变色。排查粒子不跟鼠标、跟随点和光标对不上（`fill` / `fit` / `center` / `tile`、窗口与场景比例不同）、控制点位置不对（`offset`、`instanceoverride` 控制点、`flags 2`）、吸引 / 排斥的强度或范围和 WPE 不一致、世界空间粒子随对象一起跑或出生点不对、脚本移动对象时粒子出生点晚一帧、`movement` 重力方向不对、拖尾长度 / 宽度不对、速度为 0 的拖尾粒子该不该画、`sprite` 朝向不对（`upright` / `fixed`、对象带 x / y 旋转）、带两个 renderer 的粒子场景退回。排查绳不画 / 只画一部分 / 形状或顺序不对（rope 表、零长段、几何着色器展开报错、`TRAILSUBDIVISION`）、绳的 uv 或滚动和 WPE 不同（`uvsmoothing`、填充期的 `fps`、`uvscale`）、拖尾长度 / 采样节奏 / 渐隐不对或预热后拖尾形状不对、`mapsequence*` 的粒子位置顺序不对或隐藏后序号没重来、`remap*` 的输入 / 变换 / 输出取值和 WPE 不一致（噪声、`particlesystemtime`、写控制点）、距离类粒子跟随 / 拉回 / 减速或 `vortex_v2` 旋转方向和 WPE 不一致、对象隐藏再显示后粒子被一次拽过去或系统时间不连续。排查视差方向 / 幅度不对（`mouseinfluence` 为负、只看根对象、指针在中心时的静止偏移、`fit` / `center` 下的指针）、打开后视差或跟随粒子停在中间、开场从中心滑过来的轨迹和 WPE 不同、关掉再打开视差后画面跳动、`depthparallax` 类 effect 不跟鼠标、抖动的幅度或节奏和 WPE 不同（`roughness` 临界、`g_EyePosition`）、缩放后画面或透视粒子 / 跟随粒子位置不对、脚本写 `zoom` / `cameraparallax*` / `parallaxDepth` 的生效时机；带注释的材质 JSON 解析失败、`depthwrite` / `cropoffset` / 模型布尔键误报；回放开窗期间光标动过的抓帧（逐帧光标）；排查组合层 / 可调整组合层 / 全屏组合层的位置、裁切或背景不对、`copybackground` 关掉后的透明度、组的子层画到了组外或重复画在顶层、组里子层的 alpha、`fullscreen` 层没铺满或跟着变换走、带 3D 旋转的图层没有透视、`nopadding` / `autosize` 的边缘或尺寸、纯色图层（instanced）的颜色、效果变糊或纹理没换、`model:passthrough:children:*` / `object:instance:*` 等键误报。

## 下载与任务（`downloader-tasks/`）

- [downloader-tasks/DOWNLOADER_FLOW.md](downloader-tasks/DOWNLOADER_FLOW.md)
  - 主题：当前下载器全链路与模块边界。涵盖任务级 dry-run 的下载/metadata/local-import 三个 nop 点、全局与逐任务下载并发闸门（pending + active 原子判断、运行中实时调整）、`mod.rs` scheme registry / `queue.rs` worker / `content.rs` Android content downloader 的分工，`download_with_retry` 通过 `DownloadSink` 溢写（5 MiB 阈值）返回 `DownloadOutcome`（Bytes/Path）、单图字节进度写入 `active_downloads` 并由前端 500ms 快照轮询、Android 通知 1s ticker、Fatal/Retriable/Resumable 三级错误重试、crawler/surf 捕获 blob/data/MSE 后经会话 VFS Raw IPC 分块落盘、显式 FFmpeg 合流、页面自发原生下载落 VFS `tmp/Downloads` 后经事件出口交给 crawler 插件或 surf 自动导入（含压缩包解压）、crawler 通过 task-vfs 流式提交与 surf 通过 `surf_import_media` Path 直通、surf `DownloadState` 终态 toast、畅游一键下载（Rust 权威 run 状态机 + Tauri Channel、无 window 全局的页面媒体发现、HTML+CSS 页面快照入 metadata 与详情回看；快照详情按畅游 / 内建 webpage 图片来源识别，快照上限与搜索索引规则下沉 core `storage::page_snapshot`，冻结开关同时作用于网页收集）、DRM 拒绝、统一 `postprocess_downloaded_image`（`PostprocessSource` 枚举；`Path` 来源是目录时按 Wallpaper Engine 壁纸目录入库，整目录移动 / 去重时删除）、`downloadImage` 的 `relocate` 选项（只对任务 VFS 路径生效，worker 不下载、直接把 VFS 里的文件或目录交给后处理移走）、URL 与 hash 两级去重及可选的去重 metadata 来源重绑定（命中 WPE 行时不改挂）、入库前尽力算色盘（`compute_for_row`，随 `ImageInfo.palette` 交给 `add_image`）、入库后 best-effort 原生元数据（EXIF/PNG chunk）逐图计算与一图一行存储（`image_metadata` 表）、桌面落盘（目标名原子占坑 + 原生占用标记：Unix `flock` / Windows share mode，Windows 只经占坑句柄写，守卫持有到入库后才释放，新建文件入库后按直接父目录补挂文件夹画册）、Android MediaStore copy 与 content URI 沿用、统一源文件清除（桌面回收站分块/降级、Android MediaStore 直删/批量授权）、隐藏图片分批清理服务的 busy 快照轮询、失败重试、任务计数经 `tasks-change` / `TaskChanged` diff 同步、`Task.cancel` 取消语义、启动临时文件清理，以及只对实际插入发送、按单画册拆分的 **`album-images-added`**（删除为 deleted、排序才是 change，隐藏只发隐藏画册自身事件）（连同图片新增 / 删除 / 字段补丁与 `hidden-cleanup-finished`）。
  - 适用场景：下载任务生命周期、偶发 `UNIQUE constraint failed: images.local_path` 或同名图片互相覆盖、插件把 VFS 里的文件或壁纸目录交给下载器（`relocate`）后源没被移走或报错、去重命中后 WPE 行的详情 / 属性面板失效、下载目录与文件夹画册重叠、Android `content://` 与 HTTP/HTTPS 下载差异、畅游一键下载与取消、页面快照回看、JS 爬虫或畅游窗口的页面自发原生下载、`blob:` / `data:` / MSE 媒体下载、会话 VFS 写入与清理、MSE 多 SourceBuffer 显式合流、surf 导入与终态反馈、源文件删除/回收站护栏、清空隐藏画册、失败重试、状态流转问题；任务 success/deleted/failed/dedup 计数与前端同步；排查下载后列表/画册未刷新。

- [downloader-tasks/VIDEO_INGEST.md](downloader-tasks/VIDEO_INGEST.md)
  - 主题：视频摄入（下载/导入压缩）的平台门控机制。桌面 standard/CLI 使用 rsmpeg/FFmpeg；Android 走 Kotlin `AndroidVideoCompressProvider` 与系统媒体 API，不编译 FFmpeg。画廊播放始终可用（HTML `<video>`，无需 FFmpeg）。
  - 适用场景：新增视频处理调用点；排查桌面 FFmpeg 构建环境；排查 Android content URI 视频预览/维度读取；理解 `deno task build:ffmpeg` 与桌面构建的关系。

- [downloader-tasks/TASK_DRAWER_LOAD.md](downloader-tasks/TASK_DRAWER_LOAD.md)
  - 主题：任务列表与运行配置的 PathQL 按需加载；任务与配置累计窗口分页、运行配置最新任务相关子查询 join、chip 过滤/计数/排序、任务 / 配置列表累计行与总数同批观察、任务状态计数与详情观察方、事件刷新及高频字段补丁（`useTaskRowPatches` 共用）、写后事件刷新、推荐导入态 plugin-changed 观察刷新、**重试链观察方**（`tasks://retry_root/<原始任务 id>` 走 `idx_tasks_retry_root`、只在弹出层打开期间观察、本链新增 / 已持有行删除才刷新、被删的几次补占位），以及任务右键菜单与再次执行的数据流。
  - 适用场景：任务数量多时打开抽屉卡顿、`loadTasksPage` 与 `get_tasks_page` 行为；排查右键菜单层级、菜单动作或三类任务重跑参数回填；排查「重试记录」弹出层不刷新、占位行不对或跳原始任务失败。

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
  - 主题：插件图片 metadata 迁移流程——单一脚本的 `migrate` / `provideLabels` / `provideSearchTextList` 契约、packed 插件版本门控、同插件串行 + pending 续跑、`MetadataMigrationService` 运行态与忙碌卡片、`metadata` 行按 id 不可变、按批（512 行）写回与整轮末尾一次去重合并（只合并本轮新建行，冻结模板 `template` 原样拷贝并参与分区）、批量挂标签、搜索词典与映射重建，以及每批写回提交后立即发出、结尾去重再补发的 `metadataId` 补丁事件。
  - 适用场景：插件升级后历史图片详情或搜索片段变化；排查 metadata 迁移失败或很慢、缓存未刷新、去重合并、版本编码（a.b.c 每段 ≤255）问题。

- [crawler/V8_RUNTIME.md](crawler/V8_RUNTIME.md)
  - 主题：V8 爬虫运行时（桌面 + Android/aarch64，仅 iOS 不支持）的 Web 平台全局、`crawl(common, custom)` 的 `common.isDryRun` 与 `Kabegame.*` 宿主桥（含每任务隔离的 `Kabegame.fs` 与虚拟路径媒体工具 `Kabegame.ffmpeg`）。涵盖 `plugin-runtime` feature 门控（主 app 启用、CLI 排除 deno/rusty_v8）、标准 `fetch` 使用、任务请求头合并、相对 URL 解析差异、SDK 保留工具模块；**文件系统挂载**（`data` / `cache` / `tmp` 可写，路径类变量冻结出的只读 `input`，含 Android `content://` 单文件）；`downloadImage` 的 `relocate` 选项（VFS 路径移走而不是复制，目录即 Wallpaper Engine 壁纸目录）与 SDK 的 `downloadWpeWallpaper`；**运行时架构**（设备端共享 baseline startup snapshot 缓存、fresh fallback、当前 fingerprint=4、V8 版本/CRC 校验、`deno_crypto` cppgc restore 后初始化；**每任务独占 current_thread runtime**，不可借用多线程 runtime 的 `Handle::block_on`，否则 deno_core op 轮询任务跨线程竞争、任务卡死或进程 abort）；**网络宿主化**（`op_kabegame_fetch`/`op_kabegame_to` 走 `reqwest`，不引入 `deno_fetch`/`deno_net`/`deno_tls`，`Response`/`Headers` 在 `prelude.js` 自实现）；**Android 交叉编译**（官方无 Android 预编译，仓库自带 `bin/android/` 自建产物 + mode-plugin 注入 `RUSTY_V8_ARCHIVE`/`RUSTY_V8_SRC_BINDING_PATH`、`V8_FROM_SOURCE` 自建流程、NDK libc++、`RustPlugin.kt` ABI 收敛；WebView 后端另见 [crawler/ANDROID_WEBVIEW_CRAWLER.md](crawler/ANDROID_WEBVIEW_CRAWLER.md)）。
  - 适用场景：编写/迁移 V8 插件；排查 startup snapshot 生成/失效/fallback、`Kabegame.fs` / `input` 只读挂载 / `Kabegame.ffmpeg`、`fetch`、`URL`、`crypto`、`DOMParser`；更新 JS 插件模板和类型声明；排查 V8 任务偶发卡死不动（`RefCell already borrowed`）或跑插件时进程闪退；排查 V8 后端 Android 交叉编译（依赖门控 / 自建预编译产物 / NDK 链接）或网络/`Response`/`Headers` 行为。

- [crawler/TASK_CONFIG.md](crawler/TASK_CONFIG.md)
  - 主题：收集弹窗的三层配置（plugin config ⊂ task config ⊂ 自动任务 `RunConfig`）、任务级 `isDryRun` 的冻结与继承规则、**任务级失败重试**（`retryCount` 0–10、`retry_attempt` / `retry_root_id` 重试链、只对运行期失败在 worker 收尾时立即按冻结快照重发新任务、运行前失败与取消不重试、`add_and_submit` 共用提交）、插件变量的前端转换与后端合并 / 校验 / 链式 `when` 过滤、路径类变量在冻结时解析成只读 VFS 挂载并把运行时 config 改写成虚拟路径，以及全局唯一 `taskConfig` 的回填与交互规则。
  - 适用场景：改动收集弹窗、任务「再次执行」、「以此配置运行」、插件变量表单或运行配置回填；排查默认值优先级、显式 `null`、`required` 拦截、隐藏字段仍被提交、`when` 链未传播，或路径变量解析 / 改写失败；排查失败后没有重试、重试次数不对、取消后仍重试、定时任务的重试丢了运行配置归属。

- [../third-patches/deno/README.md](../third-patches/deno/README.md)
  - 主题：`deno_core` 的上游 vendor base 与 kabegame patch series。`third/deno` = `denoland/deno` monorepo submodule（pin `v2.9.0`，`libs/core` 与 crates.io deno_core 0.405.0 逐字节一致），经 `[patch.crates-io] deno_core = third/deno/libs/core` 单一来源消费；4 个 patch（扩展 JS 内嵌 / 共享 V8 platform 初始化 / Android Bionic errno / 内嵌行为 feature 门控）只作用于 `libs/core`，`deno task patch deno` 按 reset 模型全量应用。Deno CLI 一律使用官方二进制，与这组 patch 无关；`serde_v8`/`deno_ops` 作为 monorepo path 依赖单份解析（无 path-vs-registry 重复）。
  - 适用场景：新 checkout 后准备构建 V8 后端（先 `deno task patch deno`）；升级 deno_core 版本 re-vendor；排查 deno_core patch 应用/漂移或 serde_v8/deno_ops 解析来源。不要把这里的 patch 当成 Deno CLI 定制。

- [../third-patches/rusty_v8/README.md](../third-patches/rusty_v8/README.md)
  - 主题：Android 版 `librusty_v8` 自建产物的可复现构建。`third/rusty_v8` = `denoland/rusty_v8` submodule（pin `v149.4.0` = Cargo.lock 的 v8）是**就地复用的胖构建树**（nested submodules + 已编译 target/ 都在其中，增量复用、不重拉/重编，`ignore = dirty`）。`deno task build:v8`（`scripts/build-v8.ts`，仅 Linux）幂等应用补丁并构建：补丁是 `third-patches/rusty_v8/` 顶层 `*.patch`，均 `git -C third/rusty_v8 apply`（02 路径带 `build/` 前缀，跨进嵌套 build 子模块），**由 build-v8.ts 应用而非 `deno task patch`**——patch-manager 现只对**纯净树** forward、对**脏树** reverse（幂等），本胖树常驻脏态故被跳过。产物 `bin/android/arm64/rusty_v8-build/{*.a,src_binding.rs}` gitignore、不入库。**`v8` 不经 `[patch.crates-io]`**——git 仓缺发布版的 `gen/` binding，patch 会破坏桌面构建；app 构建仍用 crates.io v8 + 注入 archive/binding。
  - 适用场景：Linux 上复现/增量重建 Android v8 产物；升级 v8/deno_core 后重建；排查补丁应用（含跨嵌套子模块）、patch-manager 纯净度门控、from-source fixup、GN/NINJA、bindgen/LIBCLANG（clang19）或 mode-plugin 注入。

## 插件（`plugins/`）

- [plugins/PLUGIN_FILE_ENDPOINT.md](plugins/PLUGIN_FILE_ENDPOINT.md)
  - 推荐配置由 `plugin://…/recommended` rows 观察方读取，按来源版本隔离；写后 `plugin-changed` 差异驱动相关 key 刷新。
  - 主题：插件轻量记录与桌面命令 / Android-Web `/plugin_file` 按需读取，`v` / `source` / `preview` 参数、白名单、404、ETag、推荐配置动态导入态、Android loopback 转发、前端缓存失效与任务脚本快照。
  - 适用场景：排查文档/图片/模板加载、错误版本或预览失效、商店来源隔离、推荐配置导入态、启动插件负载和脚本按需读取。

- [plugins/PLUGIN_ASSETS.md](plugins/PLUGIN_ASSETS.md)
  - 主题：插件配图的**声明→打包→加载→展示**全链路，核心是**单一坐标系**。涵盖 `kbAssets` 路径数组（为何从 `kbDocAssets` 的「引用串→包内路径」对象收敛为一份插件根相对路径清单、与 `kbDoc` / `kbChangelog` 的职责划分、字段缺失即零资源、`kbDocAssets` 的打包硬错误 vs 加载 WARN 不对称）、**路径归一化契约**（8 条规则、`..` 越界判非法、引用一律按插件根解析而非 md 所在目录、不做大小写归一、Rust/TS 两份同构实现）、**为何交叉校验必须提到分支外**（删掉 md 正则回退后没有兜底，且由此实现「三个键互不依存」）、2MB/10MB 限额、保留声明顺序的 `Plugin.assetKeys` 及 HTTP 按需读取，以及「源」页面（右键）与插件选择器（hover）共用的快捷预览走马灯（路径 `banner` 前缀、声明顺序、通用 `HoverRevealPanel` 容器及其 `trigger`、为何未安装条目不出图、无图时不留 banner 区）与插件详情由路由改为弹窗。
  - 适用场景：给插件补配图；排查文档或更新日志图片「加载失败」、打包报「引用了未在 kbAssets 声明的本地资源」、单文件超 2MB 打包失败、残留 `kbDocAssets` 打包报错；改归一化规则；排查快捷预览面板不弹出或走马灯无图。

- [plugins/PLUGIN_STORE_CACHE.md](plugins/PLUGIN_STORE_CACHE.md)
  - 主题：插件商店缓存机制与更新策略；前端 `usePluginMarketStore` 通过 `startRefreshPlugins` 在启动时先读缓存、再静默强制刷新并每 4h 自动刷新，进入 tab 以 4h 阈值兜底；`installedVersion` 读取时现算，兼容性过滤后的可更新集合驱动桌面/紧凑导航角标、商店源 tab 角标、商店卡片红点与快捷预览（已安装 tab 不提示，更新只能在商店源执行）；后端安装入口校验最低应用版本；以及插件页 `?tab=store:<sourceId>` 导航参数（详情返回恢复商店 tab）。
  - 适用场景：插件列表或导航更新角标延迟、缓存失效与命中行为分析；排查不兼容版本仍提示或被导入、从插件详情返回后 tab 丢失或商店列表重拉、源增删后 tab 未刷新、商店卡片已安装状态不同步。

- [plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md](plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md)
  - 主题：插件详情 **EJS 全链路**（`metadata` 写入 → 桌面命令 / Android-Web `/plugin_file` 懒加载 → `ejs.render` → iframe `srcdoc` 注入 `__bridge` → `postMessage` + `proxy_fetch`），以及 CLI `--freeze-template` 冻结进 `metadata.template` 的模板（与插件模板并行获取、非空即覆盖，去重覆盖时随 data 一起替换或清空，迁移原样保留）。
  - 适用场景：编写/调试 `description.ejs`、理解模板从 ZIP 到展示的流程、排查详情区空白或跨域请求失败；`--id` 测试 id 下载的图片看不到模板。

## Tauri（`tauri/`）

- [tauri/TAURI_ACL_PERMISSION_SYSTEM.md](tauri/TAURI_ACL_PERMISSION_SYSTEM.md)
  - 主题：Tauri v2 ACL（capability/permission）在 kabegame 的运行机制与故障复盘，以及 tauri 补丁 14–17 带来的四项规则：
    JS 事件按接收方 webview 身份投递（忽略前端 `listen` 传的 `target`，`emit_to(App)` 不再送给 JS，`unlisten` 只作用于调用方 webview）、
    `core:event:allow-listen` 的事件名作用域（`{ "event": "x" }`，末尾 `*` 前缀匹配，deny 优先）、capability 的 `frames` 维度
    （`main` 默认 / `sub` / `any`，frame 由 runtime 经请求 extension 上报，CEF 给不出时记 `Unknown`，Android 缺省按主 frame）、
    特赦 webview（`Builder::acl_exempt_webview`，本应用为 `main` 与壁纸窗口 label 池 `wallpaper`、`wallpaper-1` … `wallpaper-7`，只认本地来源主 frame，显式 deny 与 listen 作用域都跳过，
    ACL 照常解析以传递插件作用域）；`permissions/main.toml` 已删除，各窗口的权限文件与判定结果表；
    以及补丁 18–19 的**子 frame IPC**：CEF 下每个子 frame 无条件注入 Tauri 桥（ACL 是唯一闸门），子 frame 请求带 `SubframeId`，
    监听登记 / 事件 / Channel 消息 / 回退响应都送回调用方 frame（JS 监听表 webview → frame → 事件），Channel 取数按 frame 归属，
    `SubframeDestroyed` 清该 frame 的监听，关闭拦截只看主 frame，`tauri::ipc::CallerOrigin`，回退通道的子 frame 占位来源。
  - 适用场景：新增 `#[tauri::command]`（主窗口只需注册，畅游 / 爬虫 / 网页壁纸要补对应 `permissions/*.toml`）、新增窗口 IPC 权限或
    事件监听、调整 capability/permission、排查“命令不可用/全部被拒绝”、`listen` 被拒、`emit_to` 定向事件送错或收不到、
    子 frame 调 IPC 被拒（拒绝文案不带 frame，用主 frame 对照组判断）、iframe 收不到事件或 Channel 消息、
    `cannot be listened: the calling frame cannot receive events`、给 iframe 开 capability（`frames: "sub"`）。

- [tauri/TAURI_CLI_FORK.md](tauri/TAURI_CLI_FORK.md)
  - 主题：fork 的 `cargo-tauri`（上游 tauri monorepo `third/tauri` + `third-patches/tauri` patch series，基线 2.12.4；先 `deno task patch tauri`）。顶层 `bins` 配置（patch 09）驱动桌面 `tauri build` 的 cargo `--bin` 编译清单（不再 `--bins` 全量编译；未配置回退 get_binaries 打包清单），Windows 下辅助 bin 由 NSIS 原生装到安装根。`TAURI_ANDROID_PACKAGE` 将 Android Java 包（源码目录/生成 Kotlin/JNI）与 identifier（applicationId，按 mode：dev=`app.kabegame.dev` / prod=`app.kabegame`）解耦，auto-launch 改传全限定类名；`TAURI_NO_WEBKIT_DEPS` 跳过 Linux deb/rpm 的 webkit 依赖注入并对依赖去重。含 TauriCliPlugin 接线（PATH 前置 + dev/build 前增量构建）与升级 re-vendor 流程。整个 tauri 栈经 `[patch.crates-io]` 指向 `third/tauri/crates/*`（单一来源，另见 [../third-patches/tauri/README.md](../third-patches/tauri/README.md)）。
  - 适用场景：android dev/prod 真机并存隔离；排查 `Project directory ... does not exist`、auto-launch 拉起失败、`BuildConfig` 解析错误；升级 tauri-cli 版本；排查 deb 包 webkit 依赖或 Depends 重复。

- [../src-tauri/tauri-runtime-kbcef/README.md](../src-tauri/tauri-runtime-kbcef/README.md)
  - 主题：Windows/macOS/Linux 桌面 CEF runtime 后端的架构、平台门控与 CEF Views/windowed GPU 路径；自定义协议、page-load 生命周期、文档标题回调（过滤真实弹窗与 DevTools）与 `invoke` IPC 桥接（IPC 由 `GetResourceHandler` 直出）；**`file:` 访问策略**（按 label 登记 04 / 05 能力、07 文档头归属请求，闸门按发起方分档：应用页主 frame 的子资源免检，`file:` 文档按自身路径、应用页发起的子 frame 导航按目标路径向应用注册的 `set_file_scope_resolver` 要访问范围，运行时不存目录）；**子 frame IPC**（渲染进程给每个子 frame 无条件注入 Tauri 桥、请求带 `SubframeId`、`EvalInSubframe` 按 frame 回送、`on_frame_destroyed` 上报 `SubframeDestroyed`、回退通道放行子 frame 交给 ACL）；**文件拖放**（`TauriCefDragHandler` 把 CEF 回调翻成 Tauri 四态 `WindowEvent::DragDrop`，依赖 patch 02 补出的 `OnDragOver`/`OnDragLeave`/`OnDrop`，语义对齐 wry）；Windows manifest 与 runtime 安装；`kabegame` package 内的扁平 `kabegame-cef-helper` 子进程、macOS 构建期直链 framework 与裸 exe dev 运行、CefAppProtocol external pump、release 打包、**Chrome ProcessSingleton 双实例收口**（同 profile 双开时后到者识别 `NORMAL_EXIT_PROCESS_NOTIFIED` 干净退出，先到者经 `on_already_running_app_relaunch` 拦掉默认「弹一个浏览器窗口」、转 app 层注册的显示主窗口处理），以及 CEF 上游 pin/patch series 维护流程（`third/cef` 的 gitlink 始终指向官方上游 pin、patch 走标准系列；`automate-git.py` 只 fetch 分支、只认提交，故构建前由 `stageCefPatchesAsCommit()` 把工作区自动固化到 `kabegame-build` 分支——曾经人工维护 fork 分支并让 gitlink 误指向本地提交的做法已废除）。
  - 适用场景：排查桌面 CEF 启动/渲染/IPC（来源、调用方身份、`deny file:` requester）、升级 CEF/Chromium（官方 pin + patch series re-vendor）、调整 `tauri-runtime-kbcef` trait 适配；排查从外部拖入文件被 CEF 直接打开成预览页、`onDragDropEvent` 不触发；排查并发双开（如开机自启竞态）凭空多出一个带应用图标的 Chrome 窗口、或第二实例以 status=101 崩溃；排查 Windows 畅游 IPC 与页面地址（tauri 补丁 13 改用原生 `ipc://` / `tauri://`，12 保证 `no-referrer` 页面的 `Origin`）；排查 Windows GPU 子进程、macOS 裸跑子进程起不来/窗口空白/黑屏、message pump，或三平台 CEF_PATH 解析与打包；确认自编的 CEF 里到底有没有 kabegame patch。

- [tauri/LINUX_REAL_FILE_DRAG_OUT.md](tauri/LINUX_REAL_FILE_DRAG_OUT.md)
  - 主题：三个桌面平台（Linux / macOS / Windows）的 CEF standard 从图库拖出真实本地文件的完整链路。涵盖 Chromium `FilterDropData` 安全边界、前端 image id → Chromium/CEF delegate → Rust DB 授权（label 白名单 + `is_file()`，`x-wpe/*` 目录行不得拖出）的三段式权责、Linux / Windows 共用 aura「推」(`OSExchangeData`，Windows 落地为 `CF_HDROP`) 与 macOS「拉」(`NSPasteboardWriting` + `public.file-url`) 两种载荷模型的差异、Wayland/X11 的 URL/text/缩略图载荷清理、Windows 额外要清的 `html`（`CF_HTML`）与 `download_metadata`（第二份延迟渲染 `CF_HDROP`）、macOS 额外要清的 html/download promise、macOS 与 Windows 都必须摘掉的渲染器污染标记（macOS `org.chromium.renderer-initiated-drag`、Windows `chromium/x-renderer-taint`；不摘则所有 Chromium 系接收方都收不到文件）、前端 `effectAllowed=copy`（防止资源管理器 / 文件管理器默认移动库内文件）、Chromium/CEF/cef-rs/runtime 四层维护位置、label 与 DB 两道安全门、Windows 放弃 `DownloadURL` 延迟渲染下载的原因，以及 Web 版保留 `DownloadURL` 的分叉。
  - 适用场景：排查 Linux 拖到 GIMP/Krita、浏览器上传框或文件管理器仍得到 URL / 缩略图；排查 Windows 拖到资源管理器没有文件、Word / Outlook 嵌入缩略图、Chrome / Edge / VSCode 收不到文件或库内文件被移走；升级 CEF/Chromium 或 cef-rs bindings；修改拖出授权、webview label 白名单或 custom mime。

- [../third-patches/cef/README.md](../third-patches/cef/README.md)
  - 主题：CEF 官方上游 vendor base、Kabegame 编号 patch series、`deno task patch` reset/apply 模型与 re-vendor 流程。现有十个 patch：01 扁平子进程路径；02 给 `CefDragHandler` 补完整的落点侧回调；03 给 Linux、macOS 与 Windows Chromium/CEF 补真实文件拖出的起手侧 delegate、`OnStartDragging` 与 custom data 读取（Windows 与 Linux 共用 aura 钩子，另清 `html` / `download_metadata`、不打 `chromium/x-renderer-taint`；macOS 另需让 `WebDragSource` 提供 `public.file-url` 并摘掉 renderer 污染标记）；04 按浏览器开启 `allow_file_access_from_file_urls`（建窗 `extra_info` 的 `kabegame.allow_file_access_from_file_urls`，供 `file://` 加载的 WPE 网页壁纸 fetch 同目录文件，目录限制由嵌入方在 `OnBeforeResourceLoad` 负责）；05 按浏览器允许应用页加载本地资源（建窗 `extra_info` 的 `kabegame.allow_local_resources`：渲染侧对最外层主 frame 每次提交的非 `file:` 文档 `GrantLoadLocalResources`、浏览器侧给其进程 `GrantRequestScheme(file)`，弹窗提交的文档 / DevTools / 子 frame 不授（弹窗初始 `about:blank` 按 Blink 规则从 opener 继承、仍过闸门），只放开 `CanDisplay` 与导航、不放开 fetch，供图库预览给 iframe 赋 `file:` src；同样只开门、目录由嵌入方裁决）；06 补全 05 的子资源一半：`ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories`（先调父类）按同一键给非弹窗 browser 的最外层主 frame 塞 `file:` URLLoaderFactory，应用页的 `<img>` / `<video>` 才能真正加载 `file:`（否则 `ERR_UNKNOWN_URL_SCHEME`），工厂照常经 `WillCreateURLLoaderFactory` 包装、每个请求仍到 `OnBeforeResourceLoad`，CORS 模式的 `file:` 请求仍被拒。07 建工厂时捕获文档与父文档 URL，对非 http(s) 请求写归属头并关闭 worker 的 `file:` 工厂。08 关闭子 frame 跨 browser 复用同站点渲染进程；09 让同进程 iframe 的 rAF 每帧只派发一次；10 让建窗 `extra_info` 带 `kabegame.disable_wheel_zoom` 的 browser 忽略 Ctrl+滚轮缩放（`AlloyBrowserHostImpl::ContentsZoomChange` 提前返回；子 frame 里没被页面取消的 Ctrl+滚轮也会缩放整个 WebContents，主文档的监听拦不到）。生成的 capi 与 `libcef_dll` 胶水由 `version_manager.py` 在 `cef_create_projects.sh` 里产出、不入 patch。
  - 适用场景：新 checkout 后准备自编 CEF；升级 CEF 7827 pin；修复 Chromium 上游变化导致的 patch context 漂移；给 CEF client 加新回调；维护三个桌面平台真实文件拖出的 Chromium/CEF 两半 patch；排查某个窗口的 `file://` 页面 fetch 同目录文件失败或意外能读本地文件；排查应用页给 iframe 赋 `file:` src 报 `Not allowed to load local resource` 或被改写成 `about:blank#blocked`；排查桌面图库 `file://` 图片 / 视频报 `ERR_UNKNOWN_URL_SCHEME`（CEF 未带 06）；排查 07 未带时文档归属错误或 worker `file:` 绕过闸门；排查两个窗口的 iframe 共用渲染进程，或同一页面里 iframe 的 rAF 每帧回调多次；排查在壁纸 iframe 上 Ctrl+滚轮把整个应用缩放、缩放重启后还在。

## 调试（`debug/`）

- [debug/APP_LOGGING.md](debug/APP_LOGGING.md)
  - 主题：应用日志框架。全进程一个 tracing 订阅器（`kabegame_core::logging`），控制台 / 按天滚动文件（`<data_dir>/logs/kabegame.<UTC 日期>.log`，同步写、保留 14 个）/ `AppLogLayer`（2000 条环形缓冲 + 广播）/ debug ingest 四层各带过滤器；后端级别固定（release info、dev debug、依赖 warn），`KABEGAME_LOG` 用 `Targets` 语法覆盖；`AppEvent::Log` 是 opt-in 事件（「订阅全部」用 `default_kinds()` 不含它），三个出口先订阅再拉历史、按 seq 去重：Tauri `get_app_logs` + `start_app_log_stream` / `stop_app_log_stream`（经调用页传入的 Channel 批量推送，不用全局事件——Tauri 对未指定 target 的 `listen` 一律放行）、Web super 的 `/logs` SSE 与 `get_app_logs` RPC、IPC `AppLogs` + `SubscribeEvents ["log"]`（CLI `log tail`）；事件管线上逐事件日志只能 `trace!` 的防回环约束；前端 `logger` 经 `tauri-plugin-tracing`（只注册命令、权限只给主窗口）、未捕获异常入日志；控制台与文件共用 `format.rs` 单行格式（前端日志同样记为 `webview:<窗口>`）；写日志的定级与 target 约定。
  - 适用场景：新增或修改日志输出、排查「查看日志」看不到 / 刷屏 / 自激放大、日志文件位置与切分、`KABEGAME_LOG` 调级、CLI `log tail`、Web 端日志暴露范围、前端日志进不了后端。

- [debug/DEBUG_INGEST.md](debug/DEBUG_INGEST.md)
  - 主题：开发期 runtime debug ingest 方法。Vite dev server 提供 `POST /__kabegame_debug/ingest`，前端与 Rust 后端按 `session_id` 发送调试事件，middleware tee 到 `.kabegame/debug/debug-<session_id>.ndjson`。插桩只是 trace 日志（Rust `kabegame_core::kb_debug!`、Tauri 前端经 `tauri-plugin-tracing` 打 `kb-debug {json}`），由主程序 debug 构建的 `DebugIngestLayer` 订阅并批量 NDJSON 转发；Web dev 前端仍直接 POST。同一 middleware 还兼职 **CDP 端口寄存**（`/__kabegame_cdp/register` 登记 + `/__kabegame_cdp` 查询，登记落盘跨得过 vite 重启），把 CEF 随机分配的调试端口交给同一 vite 里的 `kabegame-dev` 插件；插件持有 CDP 连接，对外提供 `/__kabegame_dev/*` 的 REST，`kabegame-chromium` skill 与 stdio MCP `kabegame-dev`（`apps/kabegame-dev-mcp/`）经它驱动 app。
  - 适用场景：仿 Cursor Debug Mode 的插桩式排查；需要把前端和 Rust 后端运行时状态汇总到同一个 NDJSON 会话文件；用 curl 验证 debug endpoint 或读取 session 日志；排查 CDP 端口发现（`status` 报第 2 层 CDP 不在、skill 连不上跑起来的 app）。

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
  - 主题：Linux / Windows 原生壁纸的图片格式兼容层。涵盖独立的 `wallpaper_compatible_path`、惰性 JPEG/PNG 转码与复用、样式重应用路径、best-effort 回退，以及删除图片时对兼容副本的安全清理；macOS 的原生后端经 `NSWorkspace` 逐屏设图、直接交原图，不接入这一层。
  - 适用场景：排查 GNOME/Windows 设置 WebP、AVIF、HEIC、HEIF 后壁纸空白；扩展原生壁纸格式白名单；维护兼容副本生命周期。

- [wallpaper/ROTATION_PATHQL.md](wallpaper/ROTATION_PATHQL.md)
  - 主题：每个壁纸目标的轮播只认目标配置里的一个 PathQL 路径 `rotationPath` 与持久化位置 `rotationPosition`（换路径置 `-1` 并立即把该目标切到第 1 张，停开轮播保持），开关与间隔仍是全局设置；轮播线程一个 ticker，到点对所有活跃目标各切一张（一个失败不影响其它），`rotate(Option<目标>)` 可只切一个目标（换路径、演示过渡、托盘「下一张」），手动切换与改间隔后计时从现在起算，跳过 notify 残留 permit；一个目标的一次切换：count → 出错回落默认随机路径 → 按该目标当前壁纸 id 经 `~~/rank` 定起点（不在路径里才用位置）→ 取该张（画廊走 lookup 形态）→ 带有效样式 / 过渡与布置交给后端；原生模式在尾部拼 `_kb_fc/media-type/image` 只留图片；切换壁纸模式时各目标按当前壁纸 id 经 `~~/rank` 重定位；兼容副本仍由原生后端按需生成；设置页以外的前端入口先经目标选择弹窗选目标再写该目标的路径，轮播来源标记按任一活跃目标命中、「还能不能再设」按是否全部命中；Android Worker 只消费 Rust 预取的 `rotation_queue.json`、读 `wallpaperTargets.multiple`；设置迁移 v003（旧三键换算成路径）与 v005（并入目标）。
  - 适用场景：改轮播选图 / 位置语义、加新的轮播入口；排查轮播不前进、停开后从头开始、换模式后跳张、路径失效回落、原生模式出现视频、手动切换后自动切换的时间不对、托盘「下一张」切错目标；Android 后台轮播不换图或位置不同步。

- [wallpaper/MULTI_SCREEN.md](wallpaper/MULTI_SCREEN.md)
  - 主题：多显示器壁纸的模型与现阶段范围（完成了目标化骨架、macOS 的显示器枚举与设置页布局图、窗口模式每屏一窗、macOS 原生模式逐屏设置：**macOS 的窗口模式与原生模式都可选 `multiple` / `single`**，其余组合只有 `multiple`；多个活跃目标时设壁纸 / 设轮播先经目标选择弹窗；`span`、Windows / Linux 原生模式的 `single`、Windows / Linux 的显示器枚举尚未实现，Windows 窗口模式仍是一个窗口铺主屏）。
    - **原生模式：macOS 逐屏**：`manager/native_mac.rs` 经 `NSWorkspace.setDesktopImageURL(_:for:options:)` 一块屏一块屏地设（`All` 对每块屏各设一次、`One` 设一次，osascript 路径已删除）；屏按 display UUID 在主线程现查 `NSScreen`（`screens::find_ns_screen`），设图在调用线程（一次要等系统 0.6 s 上下，不放主线程）；样式 → 选项的映射（`fill` / `fit` / `stretch` / `center`，逐屏生效、留边黑色、没有平铺）与 macOS 26 实测读回；视频与目录型 WPE 壁纸跳过、保持系统壁纸现状（`can_display`）；WebP 等直接交原图；屏幕变化后只给新接入的屏输出（`outputs_for_new_screens`）；只改各屏当前 Space。
    - **窗口模式每屏一窗**：壁纸窗口 label 池 `wallpaper::WALLPAPER_LABELS`（`wallpaper`、`wallpaper-1` … `wallpaper-7`）与 `is_wallpaper_label`，池要同步登记的四处（ACL 特赦、两个 capability 文件、场景宿主 capability、建窗前的 `file:` 能力）；`plan_windows` / `diff_windows` 按屏的持久标识对齐窗口表（同屏保留不重载、矩形变了重铺、布置变了推事件、多的销毁、缺的新建），`init` / `reconcile` / `cleanup` 串行、布局在后端锁内现算；macOS 按屏矩形铺放；布置 `WindowAssignment { targetId, audible }`（`get_wallpaper_window_assignment` + 只发给该窗口的 `wallpaper-assignment`，`multiple` 下只有主屏窗口出声）；就绪握手、ping 看门狗、桌面鼠标转发每个窗口各一份；壁纸窗口地址带 `&slot=<序号>`。
    - **显示器枚举**：`wallpaper/screens.rs` 的 `ScreenInfo`（持久标识、左上原点的平台桌面坐标、物理像素分辨率、缩放、主屏；主屏第一、其余按 (y, x)）与进程内缓存；macOS 取 `NSScreen`（主线程）+ display UUID，Cocoa 坐标按主屏高度翻转 Y；watcher 线程每 2 s 重新枚举、系统重排通知只负责唤醒，快照稳定 300 ms 才提交，提交顺序是换缓存 → `on_screens_changed(变化前的在线屏)`（重算布局、补种目标，窗口模式下再对齐窗口集合，能逐屏输出的原生后端只给新接入的屏输出；不碰轮播计时）→ 事件 `wallpaper-screens-change { screens }`；`screen_at_cursor`。
    - **显示器模式与目标 id**：`wallpaperDisplayMode`（`multiple` / `span` / `single`）与目标 `multiple` / `span` / `screen:<屏幕持久标识>`，默认显示器 `wallpaperDefaultScreen`。
    - **设置模型**：一个键 `wallpaperTargets: { [目标 id]: WallpaperTargetConfig }`（轮播路径与位置、按壁纸模式存的样式 / 过渡、当前壁纸），core 只按目标 id 读写、有变化才发一次带整个 map 的 `setting-change`；轮播开关与间隔仍是全局键；设置迁移 v005 把 7 个扁平键并入 `multiple`（旧键胜出、幂等）。
    - **控制器**：`Layout` / `Placement`、活跃目标与默认目标的规则、生效的显示器模式（不可用时回落 `multiple` 并写回设置）、缺失目标的补种、`resolve_target` / `target_at_cursor`（规则在纯函数 `target_for_cursor`：逐屏独立下取光标所在屏的目标，取不到或那块屏不在布局里用默认目标；托盘「下一张」用它）。
    - **能力**：`get_wallpaper_capabilities` 为「壁纸模式 → 三个显示器模式各自的可用性 / 样式 / 过渡 / `sharedStyle`」，后端是唯一来源。
    - **有效样式 / 过渡**：只在读取时按能力归一化（存的值在选项里就用，否则取第一项），前后端同规则。
    - **manager trait**：`set_wallpaper(文件, 样式, 过渡, 布置)` 一次输出、后端不反读设置，不带参数的 `reconcile`（布局在后端锁内现算）与 `window_assignment`；删除 `set_style` / `set_transition` / `set_wallpaper_path`。
    - **切换**：改样式 / 过渡（按能力校验、`reapply_target`）、切壁纸模式时样式沿用（`carry_to_mode`：样式 / 过渡按壁纸模式各记各的，只在目标的新模式名下还没有值时才把旧模式的有效值带过去，已有值不动）、切显示器模式、关开壁纸与启动恢复逐目标进行。
    - **命令与事件**：带可选 `target` 的命令（「当前壁纸」类命令不带 `target` 时，壁纸窗口调用取它自己的布置目标）、新增的 `get_wallpaper_targets` / 显示器模式 / 默认屏 / `forget_wallpaper_target` / `list_wallpaper_screens` / `get_wallpaper_window_assignment`、删除的 5 个扁平 getter。
    - **前端**：`utils/wallpaperTargets.ts` 纯规则、`useWallpaperTarget` / `useActiveWallpaperTargets` / `useActiveWallpaperImageIds` / `useActiveWallpaperRotationPaths`，不做本地乐观副本、不再本地清当前壁纸；在线屏 `useWallpaperScreens` 全应用一份、跟随 `wallpaper-screens-change`；壁纸窗口按后端的布置读目标、自己留一份目标数据，不出声的布置把音量压到 0；Web 版把应用背景记在本地的 `multiple` 目标上。
    - **目标选择弹窗与各入口**：`pickWallpaperTarget({ action })`（`useWallpaperTargetPicker.ts` + 挂在 `App.vue` 的 `WallpaperTargetPickerHost.vue`，写法同 `askSettingChoice`）只有一个活跃目标时不弹、同时只有一个请求、打开期间屏减少到一块自动返回；图库 / 预览「设为壁纸」（多选时先选屏再建画册）、画册「设为轮播」、查询行「用当前视图轮播」先选目标再带 `target` 调命令，多目标时成功提示带屏名；与「需要窗口模式」引导的先后（先选屏，引导切模式后按后端的显示器模式重判目标是否仍活跃，不活跃就落到新的默认目标）；多目标下轮播来源标记分「有目标命中」与「全部命中」两档（`useWallpaperRotationSources` + `rotatingTargetIds`），部分命中时「设为轮播」仍可点并另给「停止」入口。
    - **设置页**：壁纸分区分三层（全局 → 显示器布局图 → 选中目标的设置），选中的目标是页面本地状态；显示器模式选择器照能力表置灰并显示原因（`KbSegmentedControl` 的单项 `disabled` / `tip`）；布局图 `WallpaperScreenLayout` 与几何纯函数 `layoutScreens`（并集外接矩形等比缩进容器，块小时依次省略文字）。
    - **其它**：删画册 / 删图对所有目标生效、Android Worker 与 dev 工具 `app_state` 的字段、与重构前的行为差异、加功能时的入口。
  - 适用场景：
    - 开放 `span` 或 Windows / Linux 原生模式的 `single`、给 Windows / Linux 接入显示器枚举、给 Windows 接每屏一窗；
    - 排查 macOS 原生模式下图设到了另一块屏、某块屏没换图、改显示方式不生效或铺法不对、换壁纸时界面卡顿、当前壁纸是视频时桌面没变、接上显示器后新屏不是该有的那张或已有的屏被重设、只有当前桌面（Space）换了图、`span` 置灰的原因；
    - 排查某块屏没有壁纸 / 壁纸窗口数与在线屏数不一致、某个窗口显示的不是它那块屏的目标、插拔显示器后窗口没销毁或没重建、副屏窗口位置或大小不对、关开壁纸或切模式后留下孤儿窗口；
    - 排查各屏复制时副屏也出声或主屏没声、逐屏独立下改一块屏另一块也变、轮播只切了一块屏；
    - 排查副屏上的网页 / 场景壁纸被 ACL 或 `file:` 闸门拒绝、不响应鼠标、某个壁纸窗口反复重载（ping）；
    - 新增要按壁纸窗口 label 登记或判断的代码、改 label 池；
    - 排查布局图不显示、与系统排布不一致、插拔显示器后不更新或更新慢、屏的标识重启后变了、光标所在屏判断不对；
    - 排查显示器模式选项置灰的原因不显示、设置页改的是哪个目标、分段控件里单项禁用；
    - 新增要落到某个壁纸目标的操作入口；排查只有一个目标时也弹窗、选了屏却落到默认屏、弹窗不关或留下遮罩、弹窗里布局图不显示、成功提示的屏名不对、引导切到窗口模式后报「目标不在活跃集合」；
    - 排查逐屏独立下画册 / 视图的「设为轮播」被收起或置灰、轮播标记与实际不符、托盘「下一张」切错了屏；
    - 排查来回切壁纸模式后显示方式 / 过渡被改掉或没有沿用；
    - 给壁纸目标加字段、加按目标读写的命令或前端入口；
    - 排查升级后样式 / 过渡 / 轮播路径 / 当前壁纸丢失或与旧版本不同、切壁纸模式后样式不对、改样式不生效或被拒绝、「壁纸目标不在当前显示器模式的活跃集合里」报错；
    - 排查应用背景或网格的当前壁纸标记不更新、设置项卡在保存中、壁纸窗口没跟上样式 / 过渡 / 当前壁纸的变化；
    - 外部读取壁纸设置（`get_settings`、app IPC、能力表）的形状变化。

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

## 存储（`storage/`）

- [storage/DB_MIGRATIONS_AND_BACKFILLS.md](storage/DB_MIGRATIONS_AND_BACKFILLS.md)
  - 主题：数据库两类迁移——同步 schema 迁移（`user_version` 顺序）与可恢复的异步回填作业（`Backfill` 注册表 + `backfill_jobs` 表，按批 `BEGIN IMMEDIATE` 提交、同事务写回 rowid 游标与进度、崩溃续跑，`BackfillCtx` 的 `with_conn` / `block_on` / `commit`）；`Migration.min_backfill_version` 的同步排干语义与「回填只碰引入时就存在的列」不变量、空迁移登记作业、全新安装不登记、平台门控（被依赖时标记跳过）、CLI 只跑阻塞阶段、`BackfillService` 后台按序运行与忙碌卡片 / `backfill-finished`、失败下次启动重试、`KABEGAME_BACKFILL_SYNC_THROUGH` 调试开关；以及三段式启动（`init_pre` 主线程建窗 → 线程内 `init_heavy_globals` → 主线程 `init_post` → 后台回填 → `Ready`）、`startup_state` watch / `startup-progress` / `get_startup_state`，前端启动页（Init app）mount / unmount 与不安装 i18n 的原因。
  - v049 同步规范化 `images.type` 并建索引；迁移 SQL 与 Rust 写入口的格式表外规则有比对测试，分页执行计划约束见 `provider-dsl/RULES.md` §2.2。
  - v051 是空迁移，登记发布态第一个回填作业 `wpe_dir_hash`：把存量 WPE 壁纸行的 `hash` / `size` 从入口文件重算为目录哈希与目录总字节数（每批 4 行、不持锁读盘、目录缺失跳过；跑完之前存量行按目录哈希查不到）。
  - v052 加 `images.palette`、色桶表与关系表，同步给存量图 × 每个色桶铺一行 65536（铺完再建排序索引），并登记回填作业 `image_palette`：每批 32 行给 `palette IS NULL` 的图算色盘、改写距离、发 `palette` 补丁，算不出的不重试。表的含义见 [gallery/COLOR_PALETTE.md](gallery/COLOR_PALETTE.md)。
  - 主程序每次启动在 schema 迁移之后、读连接打开之前跑一次完整 `ANALYZE`（`Storage::init_global_for_app`，启动页 `analyze` 阶段，失败只告警；CLI 不跑）。
  - 适用场景：新增需要补算数据的迁移或回填作业；排查启动统计刷新耗时或执行计划随统计变化；某个迁移要改动回填读写的列；排查启动卡在启动页、启动页报错、回填不前进 / 重复处理 / 失败重试、忙碌卡片不消失；调整桌面 / Android 启动顺序或主线程要求。

## 维护规则

- 新增流程文档后，必须在本索引补充条目（链到具体文件路径 + 主题 + 适用场景）。
- 发生流程级改动时，先更新对应文档，再更新本索引描述（若语义有变化）。
- **third-patches reset 模型**：patch-manager 接管的系列可自由增删改和重编号；`deno task patch <dir>` 先把子模块 reset 到纯净基线，再按文件名顺序全量 apply，`-r` 仅 reset。操作会丢弃子模块未提交改动，本地开发应先提交到分支。生成新 patch 用 `deno task patch <dir> --gen --from <上一个> --out third-patches/<dir>/NN-xxx.patch`：它用临时 index 重建「基线 + 系列到 `x`」再与工作树 diff，不 reset、不碰真实 index。`rusty_v8` 是唯一的手动例外（就地复用的胖构建树，patch 由 `scripts/build-v8.ts` 应用）；`cef` 的正式补丁位于 `third-patches/cef/` 并由 patch-manager 应用，`scripts/build-chromium.ts` 仅将已应用补丁的工作树临时固化成 `kabegame-build` 提交，供只认提交的 automate-git 使用。详见 [third-patches/AGENTS.md](../third-patches/AGENTS.md)。
