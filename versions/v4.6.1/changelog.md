# v4.6.1 changelog

## 用户侧

### Added
- 新增任务级空跑（dry-run）：插件、网页收集、本地导入和自动任务均可完整执行而不下载、不入库；CLI 使用 `--dry-run`，原仅打印配置的行为改为 `--print-config`。空跑任务只显示一个「跳过」数字，统计插件发现了多少个本应下载 / 导入的项目。
- 插件路径类变量（`path` / `file` / `folder` / `file_or_folder`）现在真正可用：用户选中的文件或文件夹会只读挂进本次任务，插件脚本可直接用 `Kabegame.fs` 读取，或把路径交给 `Kabegame.downloadImage()` 入库；源文件不会被改动，任务结束后挂载自动失效。Android 支持选择文件（系统选择器返回的 `content://`），暂不支持文件夹变量。
- 收集弹窗里的路径变量控件支持从系统拖入文件或文件夹（单文件 / 单文件夹，扩展名按变量 `options` 过滤）；拖入类型不符或一次拖入多项时提示「此处不支持」。

### Optimized
- 图片网格翻页提速：随机、名称等排序先只按图片 id 过滤、排序、分页，再为当前页读取完整信息。5.5 万张图、多条搜索排除条件、随机排序翻到第 200 页时，查询耗时从约 240ms 降到约 110ms；画册按画册顺序翻页约快三倍。
- 画册事件按视图依赖收紧刷新：收藏心形原地更新、改名不重读网格、树计数按分区更新，并补齐任务 / 畅游「无画册」筛选的成员变化刷新。
- 图片网格按当前筛选、排序和事件内容跳过无关刷新；隐藏过滤开启时直接刷新剔除图片，预览字段就地更新，减少后台下载与整理对浏览的干扰。
- 画册树与画廊筛选树只刷新可见展开分支；加载更多只读新页，搜索与读取失败时保留旧内容，图片计数独立更新。
- 画廊、画册、任务与畅游图片网格在删除、隐藏、加入 / 移出画册后立即刷新当前页与总数，后台下载等事件按窗口合并刷新；并发的刷新请求只采用最新发出的结果，旧结果不会覆盖新列表。
- 运行配置开启定时后，卡片与详情会补上调度器算出的下次运行时间；列表读取失败时提示；停在「我的配置」时「插件推荐」标签也显示推荐数。
- 运行配置新增、导入、编辑、复制、定时开关与删除后，通过事件更新当前列表与总数；推荐导入态由插件变更事件只刷新相关插件，刷新失败保留已有卡片。
- 插件列表改为轻量清单，文档、配图与模板经 `/plugin_file?...v=<版本>` 按需加载；推荐配置按来源和版本读取，商店详情也可查看包内 PathQL provider，任务脚本在冻结时读取。
- 运行配置卡片的定时图标改为进度圆盘，扇形表示本周期剩余时间占比（每周多选日期按相邻两次运行的间隔计算），去掉「几小时后」的相对时间文字。
- 运行配置页改为 chip 过滤与卡片网格，可按状态、最近结果、插件和定时模式筛选并切换六种排序；卡片直接显示最后一次任务和下次运行。插件推荐会标记是否已导入，定时规则新增每小时与每周多选日期。
- 任务抽屉与自动配置页改为按需分页加载：启动时只查询一次各状态任务数用于右上角徽章，打开抽屉时先加载 20 条，滚动到底继续加载，关闭后释放（只记住搜索词）；自动配置页及每张配置卡片下的任务列表同样分页加载。任务很多时启动和打开抽屉不再卡顿。

### Fixed
- 修复运行配置页桌面布局的页头缺少周围间距，与画廊统一为 20px 页面内边距。
- 修复图片删除 / 从画册移除确认框的「取消」按钮在非中文界面下仍显示中文。
- 修复 Web 开发模式遗漏 `/plugin_file` 代理导致插件文档和配图请求返回页面 HTML。
- 修复收集弹窗打开时把文件拖到弹窗上却导入画廊的问题：拖入命中改为按 z 序取最上层元素，弹窗覆盖区域现在提示「此处不支持拖入这些文件」。
- 修复整理过程中缩略图补充但视图没有更新的bug。

## 插件开发侧

### Added
- 路径类变量传入脚本的值改为**只读虚拟路径**：文件为 `{getRoot()}/input/<key>/<原文件名>`（该目录只含这一个文件），文件夹为 `{getRoot()}/input/<key>/...`；`input` 子树不可写、不可 rename、不可硬链接，复制到 `tmp` 允许。宿主绝对路径不再进入 JS。
- 插件新增 common.isDryRun 配置

### Fixed
- 宿主注入的 `common` 键统一为 `baseUrl`：V8 `crawl(common)` 与 WebView `Kabegame.common` 一致，修正 4.6.0 只改了 SDK 类型与官方插件、宿主仍注入 `base_url`，导致读取 `common.baseUrl` 拿不到 `kbBaseUrl` 的问题。

## 开发侧

### Changed
- 画廊拆出 `gallery_router` 窄路由，子 provider 全部回指它；ImageGrid 行查询先按 id 过滤排序切页，经 `~~/rank/~~p/lookup/gallery` 为本页回表补字段并按序号取序，保留原分页状态、计数与预览定位路径；宽入口提前折默认排序兼容 WHERE 组合器，`no-album` 不再依赖宽投影别名。
- PathQL 子查询边界支持 `~~<别名>`：内层挂到该别名下、表名留给外层 `JOIN` 回原表，用于随机 / 名称等不可走索引排序的「内层只排 id、外层回表」；TS 客户端 `$nest(root, alias?)`。images 根改为只投影 `images.id`，gallery / VD / 原始行各自枚举列，不再用 `images.*`；宽高比列举按 `width` / `height` 判有效。
- 自定义 Tauri 插件目录统一迁入 `src-tauri/tauri-plugin-*/`，同步 Cargo / Deno workspace、依赖路径、忽略规则及架构文档。
- 四格漫画合成脚本适配新版 PSD：背景按画格挖洞后再叠加前景装饰，保留独立编号图层，并随成品尺寸一起缩放。
- 过滤走查 Phase E：画册行事件对齐批量新增 / 根删除 / 根移动与字段补丁；成员事件按真实增删和排序分流，隐藏 / 取消隐藏只发隐藏画册自身事件，hide 开启的视图刷新、关闭时按 id 打隐藏补丁。IPC / MCP 写入口补齐事件，前端保留原刷新口径并改写移动后的持有路径。
- 插件 metadata 迁移每批写回提交后立即发 `metadataId` 补丁，结尾去重改指另发一次，迁移中途已打开的详情与 metadata 搜索不再等整轮结束；某批写回或去重失败时，已提交批次的补丁也不会丢。整理补缩略图写库失败时先发出本批已写入的补丁再中止。
- 画册成员表加外键（v046 迁移）：重建 `album_images` 时清掉画册或图片已不存在的悬空成员行；此后加入不存在的画册直接报错，不存在的图片 id 被跳过且不发成员事件，删画册 / 删图片由外键级联兜底。
- 过滤走查 Phase B：新增 imageViewRelevance 统一图片新增 / 补丁 / 隐藏相关性判断；四个 adapter 提供 viewState，ImageGrid 删除触发由 `deletedTrigger` 区分行（包含判断）与总数（任何删除都刷新），带分母时总数对任何新增刷新，imagePatches$ 显式门控隐藏补丁；预览、分面与畅游计数按事件内容收紧，`taskId` 置空只打补丁不刷新。
- 图片事件拆为新增完整行 `images-added`、删除 id `images-deleted`、单图字段 `image-changed.patch` 与多图字段 `images-change.patches`；移除旧 reason / 归属列表与成对粗事件。隐藏由画册成员推导；删除 / 清理任务时外键置空图片归属，为原属图片发 `taskId: null` 补丁，删除当前任务后详情自动离开。
- 原生元数据改为一图一行，移除按哈希共享与引用计数 GC；重解析换新行使缓存失效，删除或替换历史共享行时保留仍被其它图片引用的行。
- 删除畅游记录的 `lastImage` 字段、最新图片查询与 PathQL 占位输出，读取站点记录时不再逐条查询图片。
- 任务列表、状态计数与详情迁到 kbEvents pathql 观察方；任务分页改为累计窗口同批读取行与总数，移除游标、代数号、事件缓冲、独立任务监听和前端 pathqlCount 封装。
- 运行配置列表改为同批观察累计行与总数，失败数与详情统一由事件刷新；写命令直接返回单行/null，移除旧行快照与事件暂存通路，CLI / app IPC 保持兼容。
- 插件资源与 MCP 改为 `plugin://installed/<id>/<version>`、`byStore/<sourceId>/<id>/<version>`、`byPreview/<token>/<id>/<version>`，旧仅 id 路径移除；新增 recommended 目录/单项资源与读能力。插件事件统一为 plugin-added / plugin-changed / plugin-deleted；推荐配置由 kbEvents rows 观察方按 plugin-changed 刷新，移除动态 HTTP 标注和写响应的推荐导入态。
- 预览标签面板改为 kbEvents pathql 观察方（切图与面板内增删后请求自身 key，别处变更经事件窗口刷新，读取失败保留已有标签）；删除 `dataChangeHub` 与本地事件投递 `publishLocal`，事件 payload 类型迁入 `kbEvents/events.ts`，画册改名 / 移动 / 改 key / 删除不再为投递预读画册。
- 隐藏图数、畅游站点计数与画册页头部迁到 kbEvents pathql 观察方；畅游计数随页面释放，画册详情与图片计数分 key 观察，手动刷新等待两段落地。
- 树数据源改为 `TreeQuerySource` 查询描述，逐页观察 pathql `all` key；补充字段统一走 `TreePage.extra`，移除纯净候选缓存，Promise 等待保留在模型中。
- 新增 `services/kbEvents`（rxjs）：后端事件源 `kbEvent$` 与 pathql 核心数据源分离；ImageGrid 的行与总数改为 pathql 核心上的观察方 `usePathqlLooker`（行读 `pathql_fetch`、总数由 `useLookAll` 观察 `pathql_all` 计数批，按前端请求序号落地，不再依赖后端快照 `seq`）：观察方只看不请求，以 `refreshOn` 按单事件注册过滤器，核心对每个 key 统一 500ms 窗口、任一过滤器同意即刷新。唯一请求入口 `pathqlRequest$.next([kind, key])` 即发即返回，主动请求只有事件窗口与用户操作（路径变化、手动刷新、`mutate`）两条通路；每个 key 维护 pending 窗口，任一请求返回即取消更早的 pending，观察方看到最后可得的数据与最新请求的 loading / error。`usePagedGallery` 不再负责加载，`GridRefreshContext` 去掉 `refreshPage` / `loadTotalImagesCount`。ImageGrid 同批读取分子与 adapter 可选分母，向插槽 provide `{ total, unfilteredTotal }`（`gridTotalKey`），画廊工具栏只注入这一对数量。新增宿主 `pathql_all`：查询按序执行、整批失败，阻塞线程钉住只读连接并开启事务，保证整批 SQL 共享同一个 WAL 读快照。字段补丁改用 `imagePatches$`（单图 / 多图字段补丁共用窗口，收藏与隐藏画册成员变更各自防抖合并），ImageGrid 与预览弹窗不再订阅 `dataChangeHub`。`batch_delete_images`、`batch_remove_images`、`add_images_to_album`、`add_task_images_to_album`、`remove_images_from_album` 去掉 `view` 参数与返回快照。
- 桌面文件拖入的 `v-drag-file` 指令重构为 `<DragFileZone>` 组件：注册表持有响应式 props，命中改为按 z 序（`elementsFromPoint` + 父链），修复 teleport 弹窗遮挡时底下热区抢 drop 的问题；画廊、画册、插件页与路径控件的热区行为保持不变。
