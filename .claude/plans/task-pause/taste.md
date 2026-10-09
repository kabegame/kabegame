可以做，但“跨重启”这部分没法靠冻结 V8 运行状态来实现，只能走“插件存断点，重启后从断点重跑”的路线。

## 为什么不能直接冻结 V8

重启后能保持，就要求把 `crawl()` 跑到一半的状态存到磁盘上，包括还没完成的 Promise 链、正在等待的 op（`fetch` / `downloadImage`）和闭包。V8 的 snapshot 只能在启动时、事件循环空闲的时候生成，没法给一个正在 `await` 的 isolate 拍快照，deno_core 也不支持。另外当前的取消逻辑本来就是整个丢掉：

```rust
// plugin/v8.rs:270
// 取消即丢弃整个 run_crawl future，连同未完成的 op 与运行时一起释放。
_ = cancel.cancelled() => Err(anyhow!("Task canceled")),
```

所以分两层做：

## 第一层：不跨重启的暂停（成本低）

JS 是单线程的，绝大部分时间都卡在等 op 返回。所以只要在 op 入口加一道暂停闸，就能做到真正的暂停：

- 在 `Task` 里加一个 `paused` 状态和一个 `Notify`。`op_kabegame_fetch`、`op_kabegame_to`、`op_kabegame_download_image` 在入口处检查到暂停就挂起等待。
- 下载队列不再为这个任务派发新下载，正在下载的让它下完。
- runtime 留在内存里，继续时唤醒就行，插件不用改。
- 任务状态机要加一个 `Paused`：`Running ⇄ Paused`，`Paused` 也可以转到 `Canceled`。
- 需要处理看门狗：WebView 任务有 120s 心跳超时，暂停期间要豁免。

## 第二层：跨重启的继续（插件断点 + 重跑）

**宿主侧**
- 新增 `Kabegame.checkpoint(state)` 和 `common.resume`（也可以叫 `Kabegame.resumeState()`）。断点是 JSON，存在 tasks 表的一个新列里。
- 继续时用同一个 task id、冻结好的 `TaskParams` 新建一个 runtime，把断点交给 `crawl`。插件自己决定从哪里接着跑，比如 `{ page: 7, index: 12 }`。
- 启动时目前会把所有未完成任务直接标成失败：
  ```rust
  // storage/tasks.rs:491
  "UPDATE tasks SET status = 'failed', error = '任务已失效', ... WHERE status IN ('pending', 'running', 'waiting_downloads')"
  ```
  需要改成：有断点、并且插件声明可恢复的任务，转成 `Paused`，其余的照旧标失败。

**关键决策：断点要等下载完成才算数。** 插件调用 `checkpoint` 时，前面的图只是进了下载队列，不一定下完了。如果直接把断点写进数据库，重启后队列里那些没下完的图就丢了。建议的做法是：宿主先把这个断点挂起，等它之前入队的下载全部结束（成功、失败或去重都算），才把它写进数据库。

这样做的理由是：
- 不用把下载队列本身存到磁盘。像 pixiv 这种带签名、会过期的 URL，存下来重启后也用不了。
- 从断点重跑时会再抓一次那一页，已经下过的图会被现有的 URL / hash 去重跳过。只是要注意，这类跳过不能计进 dedup 计数，否则数字会虚高。

**插件侧**
- 在 manifest 里声明 `kbResumable` 之类的标记。没有声明的插件，暂停按钮只在当前进程内有效，退出应用就按现在的方式失效。
- 改造量不大。拿 wallhaven 来说，它就是一个 `for (page = startPage; page <= endPage; page++)` 循环（`index.ts:372`），在每页末尾加一句 `checkpoint({ page })`，开头读 `resume?.page ?? startPage` 就够了。大多数按页翻的插件都是这个形状。

## 需要注意的问题

- **列表在暂停期间变了**：新内容插到前面会让页码偏移。重复的部分有去重兜底，但可能漏掉一些。能用 id 或游标分页的 API（比如 `next` token）可以把游标放进断点。
- **运行时状态存不下来**：每个任务的 VFS（`Kabegame.fs`）、运行时设置的请求头、`page_stack` 都是会话级的，重启后会丢。约定是需要的东西插件自己放进断点里。
- **WebView 任务不在第二层范围内**：页面 DOM 存不下来，最多只能用第一层的进程内暂停。
- 进度值也要一起存，否则继续后进度会从 0 开始。

## 建议

先做第一层，改动集中在 op 闸、下载队列和状态机，插件不用动。第二层只给按页翻的 V8 插件开放，可以先拿 wallhaven 试，验证“下载完成才写断点”这个设计。

要不要我按仓库的计划格式（总体设计思路 → 现状锚点 → 分点方案）出一份完整的方案？