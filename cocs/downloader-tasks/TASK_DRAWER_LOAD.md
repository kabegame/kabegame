# 任务抽屉加载流程

本文档描述任务抽屉的分页加载机制，用于减轻任务数量多时打开抽屉的卡顿。

---

## 1. 流程概览

```
打开任务抽屉（TaskDrawer onMounted）
    → crawlerStore.loadTasksPage(20, 0)
    → invoke("get_tasks_page", { limit: 20, offset: 0 })
    → 后端 Storage::get_tasks_page(limit, offset)
    → 返回 { tasks, total }，写入 crawlerStore.tasks 与 tasksTotal

用户滚动任务列表到底部
    → TaskDrawerContent handleTasksListScroll
    → 若 scrollTop + clientHeight >= scrollHeight - 60 且 hasMore
    → crawlerStore.loadTasksPage(20, tasks.length)
    → append 到 tasks，更新 tasksTotal
```

---

## 2. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 后端存储 | `src-tauri/kabegame-core/src/storage/tasks.rs` | `get_tasks_page(limit, offset)`，LIMIT/OFFSET 分页，返回 `(Vec<TaskInfo>, u64)` |
| 命令 | `src-tauri/kabegame/src/commands/task.rs` | `get_tasks_page` 命令，返回 `{ tasks, total }` |
| 前端 store | `packages/core/src/stores/crawler.ts` | `loadTasksPage`、`tasksTotal`、`loadTasks`（Android 全量） |
| 抽屉容器 | `apps/kabegame/src/components/TaskDrawer.vue` | onMounted 调用 `loadTasksPage(20, 0)`；清除完成后重置为第一页 |
| 抽屉内容 | `packages/core/src/components/task/TaskDrawerContent.vue` | 触底检测、`loadMoreTasks`、`displayTaskCount`、`hasMore` |
| 重跑弹窗 store | `apps/kabegame/src/stores/collectDialogs.ts` | 驱动网页收集与本地导入的全局弹窗宿主，并传递任务参数快照 |

---

## 3. 约定

- 每页固定 **20** 条（`TASK_PAGE_SIZE`）
- 后端按 `start_time DESC` 排序，新任务在前
- Android 1s 轮询仍调用 `loadTasks()` 全量，会覆盖分页结果（需保证运行中任务状态同步）

---

## 4. 任务右键菜单

任务行右键菜单依次提供：停止（仅 `running` / `waiting_downloads`）、详情、图片、日志、
再次执行（按平台与任务类型判断）、保存为配置、删除。详情与日志复用
`TaskDrawerContent` 已挂载的 `TaskParamsDialog` / `TaskLogDialog`；图片进入任务详情路由；停止、
保存为配置和删除沿用抽屉原有处理函数。

`TaskDrawer` 是 `.app-container` 的直接子节点，而该容器会把除背景层、拖入层外的直接子元素设为
`position: relative; z-index: 1`。因此右键菜单若留在 `TaskDrawer` 的 fragment 根部，overlay 的
`position: fixed` 会被这条高特异性规则覆盖并被已 Teleport 到 `body` 的抽屉盖住。菜单宿主必须在
`TaskDrawer.vue` 中通过 `<Teleport to="body">` 脱离该规则，再由 `useModal` 分配层级；不要把此行为
下沉到通用 `ContextMenu.vue`，否则会破坏其他调用方的 scoped `:deep` 样式边界。

“再次执行”只打开表单并回填原任务参数，不直接提交，也不继承原任务的 `runConfigId`：

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
