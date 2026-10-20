# 任务列表与自动配置按需加载

任务和自动配置不再由 `crawlerStore` 在启动时全量读取并常驻内存。列表由当前可见页面通过 PathQL
按需持有：打开时加载第一页与总数、触底时追加、关闭或卸载时清空并退订。任务使用 keyset 游标；
运行配置因支持多种排序，使用页码分页。应用启动期只保留
任务状态分组计数，供右上角徽章和「清除全部」使用。

## 1. 生命周期与数据属主

任务抽屉的状态由 `TaskDrawer.vue` 内的 `usePagedTaskList` 持有；自动配置页由
`usePagedRunConfigs` 持有；配置卡片下的关联任务也各自使用 `usePagedTaskList`。任务详情与配置弹窗只查
当前 id。`crawlerStore` 只保留命令包装与新任务表单状态，不再保存任务或运行配置列表。

```
打开任务抽屉
    → 先订阅 tasks-change 与 auto-config-change
    → 并行 fetch tasks://<过滤>/x20x/1 与 count tasks://<过滤>
    → 合并首页请求期间缓冲的事件

触底
    → 取当前末行 (COALESCE(start_time, 0), id)
    → fetch tasks://<过滤>/before_<startTime>_<id>/x20x/1
    → 按 id 去重后追加

关闭任务抽屉
    → generation 自增，作废在途请求
    → 退订两个事件源、清空当前行
    → 仅保留 taskDrawerStore.search
```

自动配置列表采用相同生命周期，但按 `x20x/<页码>` 加载并按 id 去重。详情弹窗打开后才挂载
`AutoConfigRelatedTasks`，关联任务查询因此仍按需启动。

## 2. PathQL 路径

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 状态徽章 | `tasks://status` | `list` 一次 `GROUP BY status`，数量在 child `meta.count` |
| 任务首页 | `tasks://x20x/1` | 按 `COALESCE(start_time,0) DESC, id DESC` |
| 任务下一页 | `tasks://before_<ts>_<id>/x20x/1` | keyset 游标，不使用 OFFSET |
| 任务搜索 | `tasks://~any/plugin/<id>/~or/plugin_search/<q>/~end/x20x/1` | 本地化插件名先在前端解析成插件 id，再与 id 子串分支做 OR |
| 配置关联任务 | `tasks://run_config/<configId>/x20x/1` | 走 `idx_tasks_run_config` |
| 自动配置首页 | `run_configs://sort/next/x20x/1` | 页码分页；支持 `next/last/result/name/plugin/created` 与 `desc` |
| 配置过滤 | `run_configs://paused/last/failed/mode/hourly/search/<q>/…` | 状态、最近结果、定时模式、名称/说明搜索可叠加 |
| chip 计数 | `run_configs://<其它过滤>/state\|last\|mode\|plugin` | 打开下拉时按去掉本维度后的上下文 `GROUP BY` |
| 单行 | `tasks://id_<id>` / `run_configs://id_<id>` | 详情、事件补行和命令写后返回使用 |

段值必须使用 `@kabegame/pathql-client` 的 `encodeSeg`；它执行 PathQL 引擎层转义，不是 URL 编码。
任务根查询 `LEFT JOIN run_configs` 并带出 `run_config_name`，因此一页任务不需要逐项查配置。配置已删除时
该列为 `NULL`。运行配置根查询反向 `LEFT JOIN tasks`：join 条件用相关子查询按
`(run_config_id, start_time DESC)` 取最新任务，命中 `idx_tasks_run_config`，同时投影 `last_task_*`、
`last_result` 与 `schedule_mode`；不在 `run_configs` 冗余保存最后任务。

游标必须取已加载列表的最后一行，并始终保留 `id` 作为同时间戳的稳定次序。列表开启期间若有新行插入
头部或旧行删除，下一页仍从旧末行继续，不会产生 OFFSET 翻页的重复和漏行。

## 3. 事件、计数与写操作

`services/tasks.ts` 和 `services/runConfigs.ts` 分别维护一个底层 `listen`。首个调用方订阅时建立监听，
最后一个调用方退订时释放；页面和卡片只获得轻量订阅函数，不会各自创建 IPC 监听。

- `TaskAdded`：事件只提供 id 语义；列表通过 `tasks://id_<id>` 重读完整行，匹配当前过滤后按 id 插入。
  这是新行进入已打开列表的**唯一入口**（不认识的任务的 `TaskChanged` 会被忽略，不再补拉），所以后端每个
  建任务入口都必须在写库后发 `emit_task_added`：手动 `start_task` 与调度器 `schedule_trigger_once`
  （定时触发与漏跑补跑共用）都已遵守，新增入口照此办理。
- `TaskChanged`：只补丁已加载行；纯进度保持单调并做 100ms 节流，终态完成强制为 100%。
- `TaskDeleted`：已加载行立即移除。
- `configchange` / `configdelete`：任务列表开启期间更新同 `runConfigId` 行的配置名，删除后置空。
- 自动配置列表收到 `configadd` / `configchange` 时按 id 重读该行；同时订阅 `tasks-change`：`TaskAdded`
  以 `runConfigId` 更新最后任务，`TaskChanged` 只合并当前 `lastTask.id`，`TaskDeleted` 命中最后任务时重读配置。
  每次补丁后都重新计算 `last_result`、过滤匹配与当前排序位置；移入/移出时去抖重拉 count。页码间可能因并发
  写入错位，追加时统一按 id 去重。

`taskDrawerStore` 是唯一常驻任务订阅者。首次创建时读取一次 `tasks://status`；新增、删除或状态变化后
300ms 去抖重拉。徽章、终态任务数和清除确认文案均读这份计数，不依赖当前已加载页。

用户直接触发的写操作在命令返回时立即应用本地结果：调整任务并发返回任务行；清除完成任务返回
`{ taskIds, count }`；新建、复制、编辑或切换定时返回配置行；删除成功即移除。对应广播仍保留给其它
视图，当前视图再次收到时按 id 幂等合并。停止任务是异步收尾的例外，状态只由后续 `TaskChanged`
推进。

## 4. 涉及代码

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| Provider DSL | `src-tauri/kabegame-core/src/providers/dsl/{tasks,run_configs}/` | 过滤、最后任务 join、分组计数、排序与分页 |
| 服务 | `apps/kabegame/src/services/{tasks,runConfigs}.ts` | 路径构造、行规范化、单例事件订阅 |
| 分页状态 | `apps/kabegame/src/composables/{usePagedTaskList,usePagedRunConfigs}.ts` | 生命周期、事件合并、去重与在途请求作废 |
| 徽章 | `apps/kabegame/src/stores/taskDrawer.ts` | 状态计数与搜索词 |
| 页面 | `TaskDrawer.vue`、`AutoConfigs.vue`、`TaskDetail.vue` | 各自持有当前可见数据并立即应用写结果 |
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
