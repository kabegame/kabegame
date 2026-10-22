# v4.6.1 changelog

## 用户侧

### Added
- 新增任务级空跑（dry-run）：插件、网页收集、本地导入和自动任务均可完整执行而不下载、不入库；CLI 使用 `--dry-run`，原仅打印配置的行为改为 `--print-config`。空跑任务只显示一个「跳过」数字，统计插件发现了多少个本应下载 / 导入的项目。
- 插件路径类变量（`path` / `file` / `folder` / `file_or_folder`）现在真正可用：用户选中的文件或文件夹会只读挂进本次任务，插件脚本可直接用 `Kabegame.fs` 读取，或把路径交给 `Kabegame.downloadImage()` 入库；源文件不会被改动，任务结束后挂载自动失效。Android 支持选择文件（系统选择器返回的 `content://`），暂不支持文件夹变量。
- 收集弹窗里的路径变量控件支持从系统拖入文件或文件夹（单文件 / 单文件夹，扩展名按变量 `options` 过滤）；拖入类型不符或一次拖入多项时提示「此处不支持」。

### Optimized
- 画册树与画廊筛选树只刷新可见展开分支；加载更多只读新页，搜索与读取失败时保留旧内容，图片计数独立更新。
- 画廊、画册、任务与畅游图片网格在删除、隐藏、加入 / 移出画册后立即刷新当前页与总数，后台下载等事件按窗口合并刷新；并发的刷新请求只采用最新发出的结果，旧结果不会覆盖新列表。
- 运行配置开启定时后，卡片与详情会补上调度器算出的下次运行时间；列表读取失败时提示；停在「我的配置」时「插件推荐」标签也显示推荐数。
- 运行配置新增、导入、编辑、复制、定时开关与删除后，通过事件更新当前列表与总数；推荐导入态由插件变更事件只刷新相关插件，刷新失败保留已有卡片。
- 插件列表改为轻量清单，文档、配图与模板经 `/plugin_file?...v=<版本>` 按需加载；推荐配置按来源和版本读取，商店详情也可查看包内 PathQL provider，任务脚本在冻结时读取。
- 运行配置页改为 chip 过滤与卡片网格，可按状态、最近结果、插件和定时模式筛选并切换六种排序；卡片直接显示最后一次任务和下次运行。插件推荐会标记是否已导入，定时规则新增每小时与每周多选日期。
- 任务抽屉与自动配置页改为按需分页加载：启动时只查询一次各状态任务数用于右上角徽章，打开抽屉时先加载 20 条，滚动到底继续加载，关闭后释放（只记住搜索词）；自动配置页及每张配置卡片下的任务列表同样分页加载。任务很多时启动和打开抽屉不再卡顿。

### Fixed
- 修复 Web 开发模式遗漏 `/plugin_file` 代理导致插件文档和配图请求返回页面 HTML。
- 修复收集弹窗打开时把文件拖到弹窗上却导入画廊的问题：拖入命中改为按 z 序取最上层元素，弹窗覆盖区域现在提示「此处不支持拖入这些文件」。

## 插件开发侧

### Added
- 路径类变量传入脚本的值改为**只读虚拟路径**：文件为 `{getRoot()}/input/<key>/<原文件名>`（该目录只含这一个文件），文件夹为 `{getRoot()}/input/<key>/...`；`input` 子树不可写、不可 rename、不可硬链接，复制到 `tmp` 允许。宿主绝对路径不再进入 JS。
- 插件新增 common.isDryRun 配置

### Fixed
- 宿主注入的 `common` 键统一为 `baseUrl`：V8 `crawl(common)` 与 WebView `Kabegame.common` 一致，修正 4.6.0 只改了 SDK 类型与官方插件、宿主仍注入 `base_url`，导致读取 `common.baseUrl` 拿不到 `kbBaseUrl` 的问题。

## 开发侧

### Changed
- 运行配置列表改为同批观察累计行与总数，失败数与详情统一由事件刷新；写命令直接返回单行/null，移除旧行快照与事件暂存通路，CLI / app IPC 保持兼容。
- 插件资源与 MCP 改为 `plugin://installed/<id>/<version>`、`byStore/<sourceId>/<id>/<version>`、`byPreview/<token>/<id>/<version>`，旧仅 id 路径移除；新增 recommended 目录/单项资源与读能力。插件事件统一为 plugin-added / plugin-changed / plugin-deleted；推荐配置由 kbEvents rows 观察方按 plugin-changed 刷新，移除动态 HTTP 标注和写响应的推荐导入态。
- 隐藏图数、畅游站点计数与画册页头部迁到 kbEvents pathql 观察方；畅游计数随页面释放，画册详情与图片计数分 key 观察，手动刷新等待两段落地。
- 树数据源改为 `TreeQuerySource` 查询描述，逐页观察 pathql `all` key；补充字段统一走 `TreePage.extra`，移除纯净候选缓存，Promise 等待保留在模型中。
- 新增 `services/kbEvents`（rxjs）：后端事件源 `kbEvent$` 与 pathql 核心数据源分离；ImageGrid 的行与总数改为 pathql 核心上的观察方 `usePathqlLooker`（行读 `pathql_fetch`、总数由 `useLookAll` 观察 `pathql_all` 计数批，按前端请求序号落地，不再依赖后端快照 `seq`）：观察方只看不请求，以 `refreshOn` 按单事件注册过滤器，核心对每个 key 统一 500ms 窗口、任一过滤器同意即刷新。唯一请求入口 `pathqlRequest$.next([kind, key])` 即发即返回，主动请求只有事件窗口与用户操作（路径变化、手动刷新、`mutate`）两条通路；每个 key 维护 pending 窗口，任一请求返回即取消更早的 pending，观察方看到最后可得的数据与最新请求的 loading / error。`usePagedGallery` 不再负责加载，`GridRefreshContext` 去掉 `refreshPage` / `loadTotalImagesCount`。ImageGrid 同批读取分子与 adapter 可选分母，向插槽 provide `{ total, unfilteredTotal }`（`gridTotalKey`），画廊工具栏只注入这一对数量。新增宿主 `pathql_all`：查询按序执行、整批失败，阻塞线程钉住只读连接并开启事务，保证整批 SQL 共享同一个 WAL 读快照。字段补丁改用 `imagePatches$`（`image-changed` 与收藏画册成员变更各自防抖、各自合并），ImageGrid 与预览弹窗不再订阅 `dataChangeHub`。`batch_delete_images`、`batch_remove_images`、`add_images_to_album`、`add_task_images_to_album`、`remove_images_from_album` 去掉 `view` 参数与返回快照。
- 桌面文件拖入的 `v-drag-file` 指令重构为 `<DragFileZone>` 组件：注册表持有响应式 props，命中改为按 z 序（`elementsFromPoint` + 父链），修复 teleport 弹窗遮挡时底下热区抢 drop 的问题；画廊、画册、插件页与路径控件的热区行为保持不变。
