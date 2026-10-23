# 任务列表与自动配置按需加载

任务和自动配置不再由 `crawlerStore` 在启动时全量读取并常驻内存。列表由当前可见页面通过 PathQL
按需持有：打开时加载第一页与总数、触底时扩大累计窗口、关闭或卸载时清空并停止观察。任务与
运行配置统一通过 `usePathqlLookAll` 同批观察累计行与总数。应用启动期只保留
任务状态分组计数，供右上角徽章和「清除全部」使用。

## 1. 生命周期与数据属主

任务抽屉的状态由 `TaskDrawer.vue` 内的 `usePagedTaskList` 持有；自动配置页由
`usePagedRunConfigs` 持有；配置卡片下的关联任务也各自使用 `usePagedTaskList`。任务详情与配置弹窗只查
当前 id。`crawlerStore` 只保留命令包装与新任务表单状态，不再保存任务或运行配置列表。

```
打开任务抽屉 / 搜索变化（stop 后 start）
    → 激活 usePathqlLookAll 观察方，清空行与总数，目标页回到 1
    → pathqlRequest$.next 请求 all key
    → pathql_all 同一读快照读取 [fetch tasks://<过滤>/x20x/1, count tasks://<过滤>]
    → 观察方落地行与总数

触底
    → 以已落地页加一为目标页 N
    → 请求 [fetch tasks://<过滤>/x<20*N>x/1, count tasks://<过滤>]
    → 同批替换整个累计窗口与总数；失败保留旧数据，重试同一窗口

关闭任务抽屉
    → active=false，queries=null，停止观察当前 key
    → 清空当前行、总数与进度节流记录
    → 仅保留 taskDrawerStore.search
```

`usePagedTaskList` 与 `usePagedRunConfigs` 使用相同的累计窗口分页方式，`hasMore` 由已落地页、行数与
总数推导。两者的 `start` / `loadMore` 与任务列表在用户写操作后的 `refresh` 都只经 `pathqlRequest$` 发请求，next 即返回，
结果与最新请求的 loading / error 由观察方落地，加载图标用 `useLoadingDelay` 延迟展示。换 key 或停止观察后，
旧响应不会覆盖新窗口；同 key 的并发结果由核心 pending 窗口处理，不再维护 generation 或缓冲事件。
详情弹窗打开后才挂载 `AutoConfigRelatedTasks`，关联任务查询因此仍按需启动。

## 2. PathQL 路径

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 状态徽章 | `tasks://status` | `list` 一次 `GROUP BY status`，数量在 child `meta.count` |
| 任务首页 | `tasks://x20x/1` | 按 `COALESCE(start_time,0) DESC, id DESC` |
| 任务累计两页 | `tasks://x40x/1` | 每次读取从首行开始的累计窗口，与总数同批 |
| 任务搜索 | `tasks://~any/plugin/<id>/~or/plugin_search/<q>/~end/x20x/1` | 本地化插件名先在前端解析成插件 id，再与 id 子串分支做 OR |
| 配置关联任务 | `tasks://run_config/<configId>/x20x/1` | 走 `idx_tasks_run_config` |
| 自动配置首页 | `run_configs://sort/next/x20x/1` | 累计窗口；支持 `next/last/result/name/plugin/created` 与 `desc` |
| 配置过滤 | `run_configs://paused/last/failed/mode/hourly/search/<q>/…` | 状态、最近结果、定时模式、名称/说明搜索可叠加 |
| chip 计数 | `run_configs://<其它过滤>/state\|last\|mode\|plugin` | 打开下拉时按去掉本维度后的上下文 `GROUP BY` |
| 单行 | `tasks://id_<id>` / `run_configs://id_<id>` | 详情观察及命令写后返回使用 |

段值必须使用 `@kabegame/pathql-client` 的 `encodeSeg`；它执行 PathQL 引擎层转义，不是 URL 编码。
任务根查询 `LEFT JOIN run_configs` 并带出 `run_config_name`，因此一页任务不需要逐项查配置。配置已删除时
该列为 `NULL`。运行配置根查询反向 `LEFT JOIN tasks`：join 条件用相关子查询按
`(run_config_id, start_time DESC)` 取最新任务，命中 `idx_tasks_run_config`，同时投影 `last_task_*`、
`last_result` 与 `schedule_mode`；不在 `run_configs` 冗余保存最后任务。

任务列表始终按 `COALESCE(start_time,0) DESC, id DESC` 排序；新增、删除或 startTime 变化时，
由后端重新计算整个已加载窗口，前端不再拼接游标页、按 id 补读新任务或维护本地总数。
后端仍可解析 `before_` 路由段，前端列表已不再使用。

## 3. 事件、计数与写操作

任务与运行配置统一通过 `kbEvents` 的 `kbEvent$` / `on` 消费事件，同名事件共享 `@/api.listen`，
分别接入 Tauri 与 Web SSE。观察方只看数据并注册 `refreshOn` 过滤器；核心按每个 key 的统一 500ms
窗口请求，空闲时首票立即刷新，窗口内合并后续刷新信号。配置事件仍携带全局递增 `seq`，
观察方只依赖核心的前端请求序号，不使用事件序号配对响应。

- 任务列表：一个 `usePathqlLookAll` 同批观察累计行与总数。`TaskAdded`、`TaskDeleted`、
  diff 含 `startTime` 的 `TaskChanged` 触发刷新，过滤与排序统一由后端路径决定。
- 任务列表补丁：通过 `kbEvent$("tasks-change")` + `normalizeTaskEvent` 规范化并合并已加载行的 diff，
  包括进度、张数、状态、结束时间与错误等字段；纯进度保持单调并做 100ms 节流，completed 强制为 100%。
  其它 `TaskChanged` 不请求列表、不按 id 查询或插入未知任务，不在本地增减总数。
- 配置关联名：直接订阅 `auto-config-change`，不再维护 generation 或启动期缓冲；`configchange`
  按 id 调用 `fetchRunConfig`，`configdelete` 清空同 `runConfigId` 行的 `runConfigName`。
- 状态计数：`taskDrawerStore` 在 setup scope 中用一个 `usePathqlLookAll` 观察
  `[{ kind: "list", path: "tasks://status" }]`，按 `meta.count` 生成 `statusCounts`。创建时请求一次；
  `TaskAdded`、`TaskDeleted`、diff 含 `status` 的 `TaskChanged` 触发核心窗口刷新，无独立 300ms 定时器。
  徽章、终态数量和清除确认文案均读这份计数，不依赖已加载页。`refreshCounts()` 只请求自身 key，即发即返回。
- 任务详情：页面存活时用 `usePathqlLooker(kind: "rows")` 观察编码后的 `tasks://id_<id>`，进入、换任务、
  重新激活时手动请求一次，离页 key 为 null。仅本任务的 `TaskDeleted` 触发核心刷新，读到空行置 null；
  `TaskChanged` 直接合并 diff，首读未回、task 仍为 null 时请求自身 key，由核心处理并发返回。
- 自动配置列表观察 `auto-config-change`，以及共享 `isRunConfigTaskSignal` 识别的任务刷新信号：
  带 `runConfigId` 的任务新增、任意任务状态变化、任务删除。核心按 key 用统一 500ms 窗口重读行与总数，
  不在前端插入、删除、过滤或重排行。
- `TaskChanged` 中的 `status` / `endTime` / `successCount` / `failedCount` / `error` 只补丁
  `lastTask.id` 匹配的行并重算 `lastResult`；进度等其它字段不进入配置行。仅张数/进度变化不触发请求。
- 页头失败数独立观察 `run_configs://last` 的 list，取 `failed` 项的 `meta.count`，挂载请求一次，
  后续使用与列表相同的事件过滤器；chip 分面仍在打开下拉时一次性读取。
- 详情弹窗观察编码后的 `run_configs://id_<id>` rows key，打开或换配置时请求一次；
  当前 key 尚无落地数据时保持加载态，空结果视为已删除。任务关联配置名直接订阅配置事件，
  不缓冲事件，`configchange` 按 id 读取，`configdelete` 清空关联名。

抽屉删除单任务、清除已完成任务在写入成功后，分别请求当前累计列表 key 和计数 key；
不重置已加载窗口，不等待 `refreshCounts()` 返回新数据，也不做本地事件投递。
`handleDeleteAllTasks` 的确认文案继续读取当前 `statusCounts`，命令返回 `{ taskIds, count }` 中的 count
用于成功提示。调整任务并发返回任务行，仍通过 `patch` 本地补丁；停止任务由后续 `TaskChanged` 推进状态。
其它观察方由后端事件刷新。前端一次性任务读取封装与 `pathqlCount` / `TotalSnapshot` 已移除，
计数统一经 `pathql_all` 的 count/list 查询；后端 `pathql_count` 命令保留。

### 运行配置写操作：命令返回行，观察方消费事件

`crawlerStore` 的新增、导入、复制、编辑、定时开关与删除统一调用 `services/runConfigWrites.ts`。
命令只接收业务参数，core 写库后直接返回保存的 PathQL 单行（删除返回 null）；Tauri / Web dispatch
直接转发。app IPC 新增/更新直接返回单行，删除保留无 data 的 null 响应，CLI 请求与协议版本不变。
前端写服务直接返回 `invoke` 结果，不登记当前窗口、不缓冲或本地发布配置事件。

写库提交后照常广播 `auto-config-change`；写后不主动请求，列表、失败数与详情由核心事件窗口刷新。
调用方不需要知道观察 key；换路径后旧结果由观察方隔离。列表行与总数同批落地，不依赖后端快照序号。
推荐导入态由下面的独立观察方读取，不附在写响应中。

运行配置 add / copy 比较新配置插件，update 比较新旧插件，delete 比较旧插件的推荐导入态；
只读已安装包与同 id 且包文件仍在本地的 `store_plugin_cache` 条目，不下载。写库提交后按 pluginId 合并，
每个插件最多发送一条 `plugin-changed { pluginId, changes: { recommendedConfigs: { <path>: { imported } } } }`，
仅包含导入态实际变化的路径；同一路径优先采用已安装插件的新状态，没有该状态时采用变化来源的新状态。
写库提交后先发推荐导入态的插件事件，再发 `auto-config-change`；只改名称、计划时间等不影响匹配的字段不发插件事件。
覆盖安装（升级或同版本重装）也发 `plugin-changed`，`changes` 是必含 `version` 的完整插件 JSON；首次安装与卸载仍用 `plugin-added` / `plugin-deleted`。

### 推荐配置观察方

`useRecommendedPresets` 共用于自动配置推荐 tab、插件详情与收集对话框的 `PluginConfigPanel`。
通过共享 `pluginResourceBase` 生成已安装、byStore、byPreview 三种来源的版本路径，各段独立编码。
每个声明了推荐文件的插件一个 `plugin://…/<id>/<version>/recommended` rows key，使用 `usePathqlLookMany` 观察。
新 key 进入集合时经 `pathqlRequest$` 请求一次，手动 refresh 请求全部活跃 key；enabled=false 时没有 key。
只接受同插件含 `version` 或 `recommendedConfigs` 的 `plugin-changed`，统一由核心 500ms 窗口刷新。
只改计划时间不产生导入态事件，也不读取推荐行；升级后换 key、退订旧版本。

后端 `recommended_rows` 按 kbRecommendedConfigs 声明顺序读取本地 JSON，共用匹配规则，
由宿主覆盖 `pluginId`、basename `filename`、完整 `path` 与 `isImported`。
匹配比较插件、URL、规范化变量、HTTP headers 和 dry-run，忽略名称、定时设置；坏文件跳过并 WARN。
推荐目录 list 列出每个声明 path，单项 recommended/<path> 与 asset 使用相同的单段转义规则。
provider 仅持坐标，每次现场解析，版本不符为空；商店只读缓存，不下载。

前端先按清单顺序发布占位，收到行后按 path 替换；已有内容在刷新和失败时保留，首次失败移除占位。
在途结果的新旧由 pathql 核心 pending 窗口判断，不维护推荐专用序号，也不依赖运行配置事件补位。

## 4. 涉及代码

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| Provider DSL | `src-tauri/kabegame-core/src/providers/dsl/{tasks,run_configs}/` | 过滤、最后任务 join、分组计数、排序与分页 |
| 服务 | `apps/kabegame/src/services/{tasks,runConfigs,runConfigWrites}.ts` | 路径构造、行规范化、事件解析与配置写命令 |
| 分页状态 | `apps/kabegame/src/composables/{usePagedTaskList,usePagedRunConfigs}.ts` | 任务 / 配置累计窗口同批观察行与总数，任务高频展示字段就地补丁 |
| 徽章 | `apps/kabegame/src/stores/taskDrawer.ts` | 状态计数与搜索词 |
| 页面 | `TaskDrawer.vue`、`AutoConfigs.vue`、`TaskDetail.vue` | 各自观察当前可见数据，用户操作请求自身 key，事件由核心窗口刷新 |
| 重跑弹窗 store | `apps/kabegame/src/stores/collectDialogs.ts` | 驱动网页收集与本地导入的全局弹窗宿主，并传递任务参数快照 |

## 5. 任务右键菜单

任务行右键菜单依次提供：停止（仅 `running` / `waiting_downloads`）、详情、图片、日志、
再次执行（按平台与任务类型判断）、保存为配置、删除。详情与日志复用
`TaskDrawerContent` 已挂载的 `TaskParamsDialog` / `TaskLogDialog`；图片进入任务详情路由；停止、
保存为配置和删除沿用抽屉原有处理函数。

`TaskDrawer` 是 `.app-container` 的直接子节点，而该容器会把除背景层、拖入层外的直接子元素设为
`position: relative; z-index: 1`。因此右键菜单若留在 `TaskDrawer` 的 fragment 根部，overlay 的
`position: fixed` 会被这条高特异性规则覆盖并被已 Teleport 到 `body` 的抽屉盖住。菜单宿主必须在
`TaskDrawer.vue` 中通过 `<Teleport to="body">` 脱离该规则，再由 `useModal` 分配层级；不要把此行为
下沉到通用 `ContextMenu.vue`，否则会破坏其他调用方的 scoped `:deep` 样式边界。

“再次执行”只打开表单并回填原任务参数，不直接提交，也不继承原任务的 `runConfigId`。判断与分流逻辑在
`composables/useTaskRerun.ts`（`canRerun` / `rerunTask`），抽屉右键与任务详情页 header 的「再次执行」
（`HeaderFeatureId.TaskRerun`，紧凑模式进 fold）共用这一份：

- 普通插件走「先写再打开」：`await writeTaskConfig(taskConfigFromTask(task))` 把任务参数写进全局
  `crawlerStore.taskConfig`（含输出画册），再 `crawlerDrawerStore.open()` 打开 `App.vue` 常驻的
  `CrawlerDialog`——后者对来源无感，只响应式编辑这份全局对象。详见
  [../crawler/TASK_CONFIG.md](../crawler/TASK_CONFIG.md)。
- 内建 `webpage` 通过 `collectDialogs.openWebpage` 打开全局 `WebpageCollectDialog`。
- 内建 `local-import` 仅在桌面端通过 `collectDialogs.openLocalImport` 打开全局
  `LocalImportDialog`；若原任务来自文件夹画册拖入，只有提交时画册仍是原画册，才继续透传
  `outputDir` 与 `copy_to_dir: true`。

全局弹窗实例由 `App.vue` 唯一承载。Web 版不显示内建 `webpage` / `local-import` 的再次执行；
Android 不显示桌面专用的 `local-import` 再次执行。
