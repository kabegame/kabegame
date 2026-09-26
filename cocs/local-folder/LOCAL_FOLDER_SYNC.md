# 本地文件夹同步

本地文件夹同步由两条彼此解耦的管道组成：`fs_listener` 负责把操作系统文件事件收敛成
路径集合，`synchronizer` 负责分类、排队和执行。监听层不解释 Create/Delete/Modify，也不直接
访问图片库；执行层收到一批路径后再读取磁盘现状，因此重复事件、乱序事件和
Create→Delete 抵消都归结为同一次 `stat`。

## 事件管道

Linux inotify、Windows `ReadDirectoryChangesW` 与 macOS FSEvents 都上报完整路径和可选的
文件/目录提示。listener 按路径做集合并集，提示冲突时降为 `Unknown`；尾随静默 1500ms 后
发车，连续写入最多等待 5000ms。内核事件队列溢出只记日志，不触发全量扫描。

listener 同时订阅画册增删改事件并维护直接目录监听。新子画册建立后，同步器会调用带 ack 的
`reconcile_now()`，确认监听已就位才投递首次全量任务，避免监听建立窗口内的文件变化丢失。

## 执行管道

每个画册有一个串行 slot，slot 可同时积累一条全量请求和一组 diff 路径。worker 取任务与置空闲
状态都在同一把锁内完成，在飞期间到来的路径会排到下一趟，不会因 `try_lock` 或有限重试被丢弃。
所有画册共用 `available_parallelism()` 个许可；扫描、SQLite 与 `stat` 所在任务统一通过
`spawn_blocking(handle.block_on(..))` 执行，不占用 Tokio worker。

非派生全量请求（Manual、System、Event）会抢占同画册的在飞任务；请求需要向下同步时，也会
取消子树内的在飞任务并清空旧待办。Startup 与 Spawned 只合并排队。被抢占任务仍发 finished
事件，但带 `preempted: true`，前端不显示取消提示。

## 全量与 diff

一个全量任务只扫描一个目录。目录 mtime 没有越过 `lastSyncedAtMs` 时不登记运行卡片、不读取
本层文件，只列出直接子目录并按 `descend` 派生任务。需要扫描时，文件进度按本层条目数计算；
子目录分别投递新任务，最大深度沿用 `DEFAULT_MAX_DEPTH`。

| 触发来源 | 任务 | 向下策略 |
| --- | --- | --- |
| 应用启动 | Full | shallow=`none`，recursive=`createMissing` |
| 右键同步 | Full | 菜单分别对应 `none` / `existing` / `createMissing` |
| Albums 刷新 | Full | 只同步当前画册一层（`none`） |
| 新建画册、切换同步模式 | Full | 按所选模式 |
| 事件中新目录 | Full | 新画册首次扫描，`createMissing` |
| 普通文件事件 | Diff | 只处理本批路径 |

diff 对存在的媒体文件复用 `import_one`，对消失文件调用
`delete_images_with_events(ids, false)`。若文件父目录也已不存在，则认为它属于整目录删除事件，
跳过图片删除并交给目录规则处理。

## 删除语义

- 文件消失：删除 `images` 行，但绝不删除磁盘文件。
- 文件夹消失：删除对应画册及其子树，只解除 `album_images` 关联，保留全部图片行；根画册同样
  删除。`rm -r` 产生的逐文件事件不会改变这条规则。
- 拔盘或临时卸载会表现为根目录 `NotFound`，因此也会删除画册。图片仍留在图库，但原本的画册
  结构不会自动恢复；这是选择“磁盘现状为画册关系真源”的明确风险。
- `Denied`、`NotADir` 和其他 IO 错误不删画册，仍写入 `folder_status`。

## 运行态与提示

任务开始后满 1500ms 才进入 `FolderSyncService` 的可见快照并显示卡片，卡片展示本目录真实
百分比。finished/toast 以单个任务为单位：错误、用户取消、目录删除、手动快速跳过和实际变化
分别提示；抢占静默。Manual 即使在卡片出现前因目录未变化而跳过，也会收到 finished 反馈。

