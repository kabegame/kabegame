# 下载器流程与设置

本文档描述下载队列、worker 循环、以及相关设置的流程与涉及代码文件。

---

## 1. 流程总览

```
用户/任务发起下载
    → DownloadQueue::download() 入队
    → job_notify 唤醒 worker
    → download_worker_loop 取 job、执行下载
    → 完成后：in_flight--、capacity_notify、job_notify
    → wait_after_download_if_needed（按 downloadIntervalMs 等待，可被 exit_notify 中断）
    → 回到 loop 顶部继续取下一 job
```

---

## 2. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 下载队列与 worker | `src-tauri/core/src/crawler/downloader/mod.rs` | DownloadQueue、DownloadPool、download_worker_loop、wait_after_download_if_needed；`DownloadRequest` 可携带 `custom_display_name` / `metadata`（`Option<serde_json::Value>`；来源可为 Rhai `download_image(url, #{ name, metadata })` 或 WebView `ctx.downloadImage` 的同名 opts 字段），入库时写入 `images.display_name` / `images.metadata`（JSON） |
| 失败重试调度 | `src-tauri/core/src/crawler/scheduler.rs` | `retry_failed_image`、`download_handles`、批量重试/取消 |
| 设置持久化 | `src-tauri/core/src/settings.rs` | SettingKey::DownloadIntervalMs、get/set_download_interval_ms |
| 命令层 | `src-tauri/app-main/src/commands/settings.rs` | get_download_interval_ms、set_download_interval_ms |
| 前端设置 | `packages/core/src/stores/settings.ts` | downloadIntervalMs、buildSettingKeyMap |
| 设置项 UI | `apps/main/src/components/settings/items/DownloadIntervalSetting.vue` | 下载间隔设置（桌面 el-input-number，Android 两列 Picker） |
| 两列 Picker | `packages/core/src/components/AndroidPickerDuration.vue` | 秒+毫秒（100ms 步进）两列选择 |

---

## 3. 下载间隔设置（downloadIntervalMs）

- **范围**：100～10000 ms
- **默认**：500 ms
- **语义**：每次下载完成后，worker 在进入下一轮取 job 前等待该时长
- **中断**：等待期间监听 `pool.exit_notify`，缩容或停止时可立即响应

---

## 4. worker 循环关键点

- **完成后等待**：`wait_after_download_if_needed` 在 `in_flight` 扣减与 `notify` 之后执行，不阻塞入队容量
- **去重短路分支**：命中已存在图片时同样走统一收尾（in_flight--、notify）并执行 `wait_after_download_if_needed` 后 `continue`；同时会将任务 `tasks.dedup_count` 自增，并广播 `task-image-counts`（按需携带 `dedupCount` 等字段，见下文）。
- **退出信号**：`exit_notify` 用于缩容；worker 在 `select!` 中可被唤醒并退出

---

## 5. 任务图片数量事件（task-image-counts）

- **事件名**：`task-image-counts`（`DaemonEvent::TaskImageCounts`）。
- **载荷**：`taskId` 与下列字段中**出现的一个或多个**（均为当前绝对值）：`successCount`、`deletedCount`、`failedCount`、`dedupCount`。
- **持久化**：`tasks.success_count` / `tasks.failed_count` 与 `images` / `task_failed_images` 保持同步；`deleted_count`、`dedup_count` 仍为任务表列。
- **发送时机示例**：下载成功 `add_image` 后；去重命中 `increment_task_dedup_count` 后；失败记录新增/删除后；前端/整理删除图片后（`commands/image.rs`、`organize.rs` 等）。

### 与画廊监听相关的 `images-change` / `album-images-change`

下载器在 `src-tauri/core/src/crawler/downloader/mod.rs` 入库时按表拆分广播：**仅影响 `images` 表**时发 `images-change`（`reason: add` 等）；**同时变更 `album_images`**（收藏画册、目标画册等）时另发 `album-images-change`。详见 [gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md](../gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md)。

---

## 6. 失败图片列表（TaskDetail / FailedImages）

任务详情页的「失败图片」过滤视图与 **全部失败图片页**（`FailedImages.vue`，可按插件筛选）均展示 `task_failed_images` 表中的记录，支持：

- **Header 快照**：失败写库时会把该图片当次下载的最终 `http_headers`（任务配置 + 脚本动态修改 + 默认流程后的最终值）序列化到 `header_snapshot`；老记录该字段可能为空。
- **单次重试**：`retry_task_failed_image(failed_id)` → `TaskScheduler::retry_failed_image` **spawn** 异步任务调用 `download_image_retry`（入队前可能在 `download()` 内等待容量，可 `cancel_retry_failed_image` 通过 `JoinHandle::abort()` 取消等待）；优先使用失败记录里的 `header_snapshot`，为空时回退到任务级 `tasks.http_headers`；成功时删除记录、失败时更新 `last_error` 与 `header_snapshot`。不在重试前清空 `last_error`（由下载结果写回）。
- **调度器句柄**：`TaskScheduler` 维护 `download_handles: HashMap<failed_id, JoinHandle>`，与单次/批量重试一一对应。
- **批量重试 / 取消 / 删除（前端按当前插件筛选传 ID 列表）**：
  - `retry_failed_images(ids)`：对给定 id 逐个 `retry_failed_image`，跳过已有 handle 的 id。
  - `cancel_retry_failed_image` / `cancel_retry_failed_images(ids)`：移除并 abort 对应 `JoinHandle`（已入队完成的 handle 上 abort 为 no-op，正在下载的不受影响）。
  - `delete_failed_images(ids)`：先 `cancel_retry_failed_images` 再 `Storage::delete_failed_images`，按任务扣减 `failed_count` 并广播 `failed-images-change` + `task-image-counts`。
- **单条删除**：`delete_task_failed_image(failed_id)` 删除记录后，发送 `removed` 细粒度事件，并广播 `task-image-counts` 更新 `failedCount`。任务删除（`delete_task`）和清除已完成任务（`clear_finished_tasks`）时，会同时删除该任务下所有失败图片记录并发送 `removed` 事件；启动时迁移会清理任务已不存在的孤儿失败图片。
- **变更事件**：失败图片入库/更新/删除时，后端通过 `failed-images-change`（`DaemonEvent::FailedImagesChange`）广播细粒度 payload：`reason`（`added/removed/updated`）、`taskId`。其中 `added` 使用 `failedImages`（数组），`removed` 使用 `failedImageIds`（数组），`updated` 使用 `failedImage`（单条完整数据）。
- **前端同步**：`apps/main/src/stores/failedImages.ts` 在 `App.vue` 顶层初始化监听后，不再防抖全量拉取；改为按事件 payload 在内存中做 diff（新增 `unshift`、删除 `splice`、更新按 id 替换），仅在异常 payload 下兜底 `loadAll`。
- **排序**：失败列表统一按 `id DESC`（自增 id 倒序）返回，避免依赖时间字段排序。
- **进度显示**：任务详情仍监听 `download-state`（preparing/downloading/processing/failed）与 `download-progress`（received_bytes/total_bytes），以 URL 为 key 在前端 `downloadStateMap` 中维护阶段与百分比，失败项卡片展示阶段标签与进度条。

相关命令：[`src-tauri/app-main/src/commands/task.rs`](/src-tauri/app-main/src/commands/task.rs)；前端：`apps/main/src/views/TaskDetail.vue`、`apps/main/src/views/FailedImages.vue`、`apps/main/src/stores/failedImages.ts`。
