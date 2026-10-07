# 忙碌任务快照轮询

整理、隐藏清理、文件夹同步、插件 metadata 迁移和单图下载的高频进度统一采用「后端持有快照、
前端按需轮询」。生命周期提示事件仍保留，但不能作为卡片消失或 store 复位的唯一依据。

## `useSnapshotPoller` 契约

`apps/kabegame/src/composables/useSnapshotPoller.ts` 提供不绑定组件 scope 的模块级轮询器：

- `key` 是全局单例键；同 key 的 service、store 或组件拿到同一实例。
- `start()` 注册全部 `wakeEvents` 并立即请求一次。`isActive(snapshot) === false` 时停止，不做空闲轮询。
- `wake()` 立即请求；如果已有请求在途，只登记一次补拉，绝不重叠。
- 活跃时在上一次请求返回后用 `setTimeout` 等 500ms 再请求，不使用 `setInterval`。
- `invalidate()` 增加 generation，丢弃旧 generation 的在途响应并补拉，防止已结束卡片被旧快照复活。
- `dispose()` 清 timer、事件监听和单例注册。

系统只建立两个实例：

- `busy-tasks`：请求 `get_busy_tasks_snapshot`，一次分发整理、隐藏清理、文件夹同步与 metadata 迁移；
  `busy-tasks-change` 只负责唤醒。
- `active-downloads`：请求 `get_active_downloads` 并整表对齐 `downloadState`；`download-state` 负责唤醒，
  `download-removed` 可提前删除并 invalidate。

## 权威边界

快照是任务是否仍在运行的权威来源。轮询发现 `running=false` 或条目从数组消失时，store 必须立即
收尾，不等待 finished 事件。`*-finished` 只负责 toast、取消状态和 `lastError`，`applyFinished` 必须幂等。

前端主动启动整理或隐藏清理时，`begin()` 先乐观显示运行态，再 invoke 后端。store 的 `starting=true`
期间忽略旧快照中的 `running=false`；invoke 成功或失败后清掉 `starting` 并 invalidate。取消、finished、
`download-removed` 等会改变当前镜像的操作也应先 invalidate 在途响应。

后端 writer 只更新自己的内存状态，不发送高频进度事件。任务开始并写好状态后发送唤醒事件；
finished 事件可丢，最多只影响 toast，不能让 UI 永久停在 100%。更新器下载是独立状态机，不适用本规则。
