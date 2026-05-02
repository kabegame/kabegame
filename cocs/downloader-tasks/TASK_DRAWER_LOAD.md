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

---

## 3. 约定

- 每页固定 **20** 条（`TASK_PAGE_SIZE`）
- 后端按 `start_time DESC` 排序，新任务在前
- Android 1s 轮询仍调用 `loadTasks()` 全量，会覆盖分页结果（需保证运行中任务状态同步）
