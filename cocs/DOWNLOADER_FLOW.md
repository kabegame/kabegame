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
| 下载队列与 worker | `src-tauri/core/src/crawler/downloader/mod.rs` | DownloadQueue、DownloadPool、download_worker_loop、wait_after_download_if_needed |
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
- **去重短路分支**：命中已存在图片时同样走统一收尾（in_flight--、notify）并执行 `wait_after_download_if_needed` 后 `continue`
- **退出信号**：`exit_notify` 用于缩容；worker 在 `select!` 中可被唤醒并退出
