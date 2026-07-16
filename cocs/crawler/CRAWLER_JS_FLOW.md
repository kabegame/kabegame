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
    -> Kabegame.exit()/error() 调用 TaskScheduler::complete_webview_task
    -> worker await TaskResult 后统一 transition、销毁窗口、remove_run
```

---

## 2. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 任务调度 | `src-tauri/kabegame-core/src/crawler/task_scheduler/mod.rs` | `TaskScheduler` 注册表、提交时冻结参数、worker、取消和 `TaskResult` 收尾 |
| 任务条目 | `src-tauri/kabegame-core/src/crawler/task_scheduler/task.rs` | `Task` / `TaskParams` / `TaskResult`，保存 progress、headers、page stack、WebView state、completion、CancellationToken |
| WebView 桥 | `src-tauri/kabegame-core/src/crawler/webview.rs` | 仅保留 `CrawlerWebViewHandler` trait 和窗口 label 工具 |
| 窗口创建与注入 | `src-tauri/kabegame/src/startup.rs` | 从 `Task` 取 crawl.js/config，创建 crawler 窗口并处理 native download 回调 |
| Tauri 命令 | `src-tauri/kabegame/src/commands/crawler.rs` | 按 `crawler-<task_id>` label 找 `Task`，维护 page stack/state、下载、日志、进度、`TaskResult` completion |
| Bootstrap 模板 | `src-tauri/kabegame/src/webview_js/bootstrap.js` | 构造闭包局部 `Kabegame`，执行烘焙进来的 crawl.js |
| 媒体捕获脚本 | `src-tauri/kabegame/src/webview_js/media_capture.js` | 捕获 Blob/MSE 字节 |
| 媒体上传脚本 | `src-tauri/kabegame/src/webview_js/media_download.js` | data/blob/MSE 上传到 Rust |

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
- `Task.webview` 保存 `TaskResult` completion sender 与 `Kabegame.state()` 的任务级 state。

旧的 `CRAWLER_SESSIONS`、`JsTaskContext`、`JsTaskPatch`、独立 `PageStackStore` 与 `canceled_tasks` 表已经移除。

### 3.3 Bootstrap 每页执行

Tauri initialization script 在每次页面加载时执行：

1. `media_capture.js` 捕获 Blob/MSE。
2. `media_download.js` 注册共享媒体上传入口。
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

`crawl_exit` / `crawl_error` / 任务取消都通过 `TaskScheduler::complete_webview_task` 发送 `TaskResult` 通知 worker。取消顺序为：

1. 先 `Task.cancel.cancel()`。
2. 再 `DownloadQueue::cancel_task_downloads(task_id)`。
3. 最后发送 WebView completion 并唤醒等待下载容量的调用方。

这个顺序用于避免下载 job 从 pending 取出到 active 登记之间的竞态。

`TaskResult = Result<(), TaskError>`；`TaskError::Canceled` 不携带脚本原始消息，worker 在任务终态统一写入 `"Task canceled"`。其它错误走 `TaskError::Other(String)`，若 token 已取消仍按取消终态保留原始错误。

### 3.6 下载与媒体

`Kabegame.downloadImage` 的普通 HTTP/HTTPS URL 走浏览器 native download，先登记 `ActiveDownloadInfo { native: true, ... }`，完成后统一交给 `postprocess_downloaded_image`。`data:` / `blob:` / MSE URL 走 `crawl_media_begin` / `crawl_media_chunk` / `crawl_media_end` 上传通道。

下载请求使用 `Task.headers_snapshot()`；页面 Referer 由当前 page stack 顶部 URL 派生。

---

## 4. 约束

- 事件契约不变：任务进度、状态和计数仍走 `tasks-change` / `TaskChanged` camelCase diff；日志仍走 `task-log`。
- WebView 后端仅桌面使用；Android 走 V8 后端。
- `Task` 内部锁使用 std 锁，调用方不得跨 `.await` 持有这些锁。
- `TaskScheduler` 队列只保存 `task_id`，运行参数一律从 `TaskScheduler::get_run(task_id)` 读取。
