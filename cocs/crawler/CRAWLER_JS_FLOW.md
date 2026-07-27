# JS 爬虫（WebView 后端）加载与运行流程

本文档描述 **crawl.js**（WebView 后端）从任务提交、窗口创建、导航到任务完成的当前链路。

---

## 1. 流程总览

```
用户启动插件任务
    -> TaskScheduler::enqueue 在提交时解析插件（含内建插件）、校验版本、合并配置并冻结 TaskParams
    -> TaskScheduler.tasks 注册 Arc<Task>，队列只保存 task_id
    -> worker 取 Arc<Task>，把任务置为 Running
    -> WebView 分支初始化 Task.page_stack 顶部 initial 页面，并 begin_webview_session()
    -> AppCrawlerWebViewHandler 创建 label=`crawler-<task_id>` 的独立 WebView 窗口并加载 base_url/about:blank
    -> startup.rs 从 Task.params.plugin 读取 crawl.js，从 Task.params.config 读取冻结配置，烘焙进 bootstrap
    -> 页面每次加载执行 media_capture.js -> media_download.js -> bootstrap
    -> crawl.js 通过 Kabegame.pageLabel()/pageState()/state() 读取 Task 内状态
    -> Kabegame.to()/back() 直接维护 Task.page_stack 并 navigate
    -> Kabegame.exit()/error() 先 allSettled 当前页未决 downloadImage，再发送 TaskResult
    -> worker await TaskResult 后等待该任务 pending + active 下载排空
    -> 有下载时状态 Running -> WaitingDownloads，排空后销毁窗口并进入终态
```

---

## 2. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 任务调度 | `src-tauri/kabegame-core/src/crawler/task_scheduler/mod.rs` | `TaskScheduler` 注册表、提交时冻结参数、worker、取消和 `TaskResult` 收尾 |
| 任务条目 | `src-tauri/kabegame-core/src/crawler/task_scheduler/task.rs` | `Task` / `TaskParams` / `TaskResult`，保存 progress、headers、page stack、WebView state、completion、CancellationToken |
| WebView 桥 | `src-tauri/kabegame-core/src/crawler/webview.rs` | `CrawlerWebViewHandler` trait、窗口 label 工具和 CEF 下载投递反调 |
| 窗口创建与注入 | `src-tauri/kabegame/src/startup.rs` | 从 `Task` 取 crawl.js/config，创建 crawler 窗口并把 CEF Requested/Finished 与 worker oneshot 对接 |
| Tauri 命令 | `src-tauri/kabegame/src/commands/crawler.rs` | 按 `crawler-<task_id>` label 找 `Task`，维护 page stack/state、下载、日志、进度、`TaskResult` completion |
| Bootstrap 模板 | `src-tauri/kabegame/src/webview_js/bootstrap.js` | 构造闭包局部 `Kabegame`，执行烘焙进来的 crawl.js |
| 媒体捕获脚本 | `src-tauri/kabegame/src/webview_js/media_capture.js` | 捕获 Blob/MSE 字节 |
| 媒体落盘脚本 | `src-tauri/kabegame/src/webview_js/media_download.js` | data/blob/MSE 经会话 VFS 分块落盘、显式合流并统一提交 |

---

## 3. 关键语义

### 3.1 提交即冻结

`TaskScheduler::enqueue` 是参数冻结边界：

- 所有任务（普通插件和内建 `local-import`）都走同一条冻结路径：提交时执行 `resolve_plugin_for_task_request`、`check_min_app_version`、`resolve_crawl_output_dir`、`build_effective_user_config_from_var_defs`，并把结果存入 `TaskParams`。
- `local-import` 是 `PluginBackend::Builtin` 插件，`PluginManager::get` 先查内建静态表；内建插件不进入 `get_all`，但 `get_plugins` / web 插件索引 / IPC 列表会追加 `scriptType=builtin` 的内建记录，前端管理类列表用 `visiblePlugins` 过滤隐藏。同名 kgpg 双重防护：`parse_kgpg` 在安装/临时运行/商店缓存入口统一拒绝内建保留 id（`refresh_plugins` 扫描对同名文件先行跳过、`refresh_plugin` 对内建 id no-op，避免残留文件炸掉整次刷新），运行时 `get()` 另有内建优先兜底。
- 内建插件展示元数据（`name` / `description` / `iconPngBase64` / `config.vars`）由后端静态表下发，前端任务抽屉和运行参数展示不再维护 `local-import` 名称、图标、变量名特判。
- `TaskParams.plugin` 是非空 `Arc<Plugin>`，不再保存冗余 `plugin_id`；`plugin_version()` / `base_url()` 直接从 `plugin` 派生。内建插件 `var_defs` 为空，配置合并会原样透传用户配置。

worker 启动后不再重新解析 DB/PluginManager。提交失败由 `enqueue` 内统一把任务 transition 到 `Failed`。

`run_task` 先按 `plugin.script.is_builtin()` 分发内建插件；当前仅 `local-import` 路由到 `run_builtin_local_import`。非内建任务再按 WebView/V8 脚本后端运行。

### 3.2 Task 内状态

运行中任务只存在于 `TaskScheduler.tasks: StdRwLock<HashMap<String, Arc<Task>>>`：

- `Task.cancel: CancellationToken` 是任务取消的唯一权威。
- `Task.progress` 内存累加后写回 DB 并发 `tasks-change/TaskChanged`。
- `Task.headers` 保存任务级 header 快照；V8 和 WebView 修改 header 都写回 DB。
- `Task.page_stack` 保存 WebView/V8 当前页面栈。
- `Task.webview` 保存 `TaskResult` completion sender、心跳 sender（见 3.6）与 `Kabegame.state()` 的任务级 state。

旧的 `CRAWLER_SESSIONS`、`JsTaskContext`、`JsTaskPatch`、独立 `PageStackStore` 与 `canceled_tasks` 表已经移除。

### 3.3 Bootstrap 每页执行

Tauri initialization script 在每次页面加载时执行：

1. `media_capture.js` 捕获 Blob/MSE。
2. `media_download.js` 注册共享媒体落盘/提交入口。
3. 烘焙后的 `bootstrap.js` 捕获并隐藏 `__TAURI_INTERNALS__`。
4. 闭包内构造 `Kabegame`，直接执行插件 `crawl.js`。

跨页状态不能依赖上一页 JS 变量；应使用 `Kabegame.state()` / `updateState()` 与 `Kabegame.pageState()` / `updatePageState()`。

### 3.4 导航与回退

`crawl_to`：

- 用当前 page stack 顶部 URL 或 `TaskParams.base_url()` 解析目标 URL。
- 将新页面 `{ url, page_label, page_state }` push 到 `Task.page_stack`。
- 调用当前 WebView 的 `navigate`。

`crawl_back`：

- 从 `Task.page_stack` 弹出指定数量页面。
- 用新的栈顶 URL 执行 `navigate`。

`crawl_get_page_label` / `crawl_get_page_state` 始终从栈顶读取；初始值为 `initial` 和空对象。

### 3.5 任务结束与取消

`crawl_exit` / `crawl_error` / 任务取消都通过 `TaskScheduler::complete_webview_task` 发送 `TaskResult` 通知 worker。正常或错误脚本结果到达后，`run_task` 在销毁 WebView 前等待该任务全部 pending + active 下载完成；V8 分支在脚本 join 后使用同一个排空 helper。计数非零时任务转为持久化状态 `waiting_downloads`，每次下载完成由 `capacity_notify` 唤醒；120 秒无进展超时，数量下降会重置期限。

取消顺序为：

1. 先 `Task.cancel.cancel()`。
2. 再 `DownloadQueue::cancel_task_downloads(task_id)`。
3. 最后发送 WebView completion 并唤醒等待下载容量的调用方。

这个顺序用于避免下载 job 从 pending 取出到 active 登记之间的竞态。

排空期间取消会立即打断等待并返回 `TaskError::Canceled`；WebView 随后销毁，销毁钩子会丢弃剩余 CEF completion tx，避免 worker 永久占槽。

`TaskResult = Result<(), TaskError>`；`TaskError::Canceled` 不携带脚本原始消息，worker 在任务终态统一写入 `"Task canceled"`。其它错误走 `TaskError::Other(String)`，若 token 已取消仍按取消终态保留原始错误。

### 3.6 心跳看门狗（WebView 无响应检测）

隐藏的爬虫窗口收不到用户输入，CEF 内置 hung-renderer 检测（基于输入回执）永远不会触发；渲染进程卡死（死循环 JS 等）时 completion 永不到达。为此 WebView 会话带一条心跳链路：

- `bootstrap.js` 在每页 document-start 立即 invoke 一次 `crawl_heartbeat`，之后每 **60 秒**一次；页面导航重跑脚本、重新起 interval。
- `crawl_heartbeat` 命令按 label 找到 `Task`，经 `Task::heartbeat_webview()` 向会话的心跳 channel 发一个信号。
- `run_task` 的 WebView 分支不再裸 await completion，而是 `select!` 循环等待 completion / 心跳 / **120 秒**超时（`WEBVIEW_HEARTBEAT_TIMEOUT`）；收到心跳重置超时，超时则以 `TaskError::Other("WebView 窗口无响应")` 结束任务（不刷新窗口——刷新会导致任务状态不稳定），随后走既有的下载排空 + 销毁窗口收尾。

渲染进程真崩溃时心跳同样停止，由同一条超时路径在 ≤120 秒内兜底。可见窗口（主窗口/Surf）则由 `tauri-runtime-cef` 的 `RequestHandler` 用 CEF 内置检测处理：`on_render_process_unresponsive` 直接 terminate 渲染进程、`on_render_process_terminated` 自动 `reload` 恢复（`crawler-*` 窗口在这两个回调里被排除）。

### 3.6 下载与媒体

`Kabegame.downloadImage` 的普通 HTTP/HTTPS URL 统一调用 `DownloadQueue::download_image`，在容量满时挂起 JS promise；worker 根据任务插件为 WebView backend 把 job 反投到对应 CEF 窗口，等待条目内 oneshot 后统一执行后处理。页面自发下载在首次 `Requested` 时取消并入队，worker 第二次发起后才真正落盘。

`data:` / 普通 `blob:` / MSE `blob:` 保持对插件相同的 `downloadImage(url, opts)` 调用形状，但内部不再走专用媒体上传命令：

1. `media_capture.js` 继续维护 Blob/MSE 捕获表；MSE 下载前仍由 `ensureFullyBuffered` 高倍速全缓冲并侦测换集，之后检查 DRM、截断和空数据。
2. `media_download.js` 通过 `crawl_fs_get_root` 在当前任务 VFS 的 `tmp/media-*` 建子目录，以 8 MiB Raw IPC 分块写每条流；`crawl_fs_fwrite` 的短写会循环补齐。CEF 桌面端 raw 分块不走标准 invoke（postMessage JSON 通道会把 `Uint8Array` 退化成数字数组），改经 runtime 注入的 `window.__kb_raw_invoke__`（`cef-ipc://localhost/raw` 帧化通道，见 `tauri-runtime-cef/src/ipc.rs`），无桥平台回退标准 invoke。
3. 多 SourceBuffer 显式调用 `crawl_ffmpeg_mux`，容器规则为任一流 MIME 含 `webm` 则 WebM，否则 MP4。
4. `bootstrap.js` 注入的 `window.__kb_media_submit__` 把最终虚拟绝对路径作为 `crawl_download_image.url` 提交。宿主将其解析为内部 `task-vfs://`，scheme downloader 从 VFS 流式读取并进入 `DownloadSink` / 统一后处理。
5. `finally` 递归删除本次 `tmp/media-*` 子目录。`crawl_download_image` 会等待下载完成，因此清理不会早于 task-vfs 读取。

同一 `media_download.js` 也供 surf 使用，但提交回调由 `surf_bootstrap.js` 注入为 `surf_import_media`，以会话 VFS 的 Path 直通入库；媒体脚本本身不判断窗口类型。

下载请求使用 `Task.headers_snapshot()`；页面 Referer 由当前 page stack 顶部 URL 派生。

---

## 4. 约束

- 事件契约不变：任务进度、状态和计数仍走 `tasks-change` / `TaskChanged` camelCase diff；日志仍走 `task-log`。
- WebView 后端仅桌面使用；Android 走 V8 后端。
- `Task` 内部锁使用 std 锁，调用方不得跨 `.await` 持有这些锁。
- `TaskScheduler` 队列只保存 `task_id`，运行参数一律从 `TaskScheduler::get_run(task_id)` 读取。
