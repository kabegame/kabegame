# JS 爬虫（WebView 后端）加载与运行流程

本文档描述 **crawl.js**（WebView 后端）从任务创建到脚本执行、导航与回退的完整流程及涉及代码文件，便于 AI/开发者快速定位，避免重复探索。

---

## 1. 流程总览

```
用户启动插件任务
    → Scheduler 解析插件、构建 JsTaskContext、register_session(task_id)
    → AppCrawlerWebViewHandler 创建 label=`crawler-<task_id>` 的独立 WebView 窗口并加载 base_url
    → 页面加载 → 每次加载都会执行 initialization_script（media_capture.js → media_download.js → bootstrap.js）
    → bootstrap: crawl_get_context → crawl_page_ready → bindApi → crawl_run_script
    → Rust: 按调用方 window label 找 session → try_dispatch_script → eval(crawl.js 包装)
    → crawl.js 根据 ctx.pageLabel 分支执行（initial / posts / detail / exit）
    → 脚本调用 ctx.to() / ctx.back() → Rust 更新上下文并 navigate → 新页面再次走 bootstrap → 循环
    → 脚本调用 ctx.exit()/ctx.error() 或任务取消 → session completion 唤醒 worker
    → worker 统一更新任务终态、清理 page_stack、销毁 crawler-<task_id> 窗口、remove_session
```

---

## 2. 涉及代码文件一览

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 任务入口 | `src-tauri/kabegame-core/src/crawler/scheduler.rs` | 解析插件、构建 JsTaskContext、注册 session、委托 app 建窗并 await completion |
| 插件脚本读取 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `read_plugin_js_script(zip_path)` 从 .kgpg 内读 `crawl.js` |
| session 状态 | `src-tauri/kabegame-core/src/crawler/webview.rs` | CrawlerSession、session 注册表、JsTaskContext、completion、label 工具、set_page_ready、try_dispatch_script |
| 窗口创建与注入 | `src-tauri/kabegame/src/startup.rs` | create_crawler_window（initialization_script 依次注入 media_capture.js、media_download.js、bootstrap.js）、AppCrawlerWebViewHandler::create_task_window / destroy_task_window |
| 媒体捕获脚本 | `src-tauri/kabegame/resources/media_capture.js` | 每次页面脚本前执行：hook `URL.createObjectURL`、`MediaSource.addSourceBuffer`、`SourceBuffer.appendBuffer`，维护 blob/MSE 注册表 |
| 媒体上传脚本 | `src-tauri/kabegame/resources/media_download.js` | crawler 与 surf 共用：对 data/blob/MSE 做分流、全缓冲驱动、多流上传、DRM 拒绝 |
| Bootstrap 脚本 | `src-tauri/kabegame/resources/bootstrap.js` | 每次页面加载执行：get_context → page_ready → bindApi → run_script；`downloadImage` 对 data/blob 委托共享媒体上传脚本 |
| Tauri 命令 | `src-tauri/kabegame/src/commands/crawler.rs` | 从调用方 `crawler-<task_id>` label 路由到 session；crawl_get_context、crawl_page_ready、crawl_run_script、crawl_to、crawl_back、crawl_task_log 等 |
| 权限 | `src-tauri/kabegame/capabilities/crawler.json` | `crawler-*` 窗口/webview 的 Tauri 权限（remote URLs、events、window） |
| 插件脚本 | `src-crawler-plugins/plugins/<id>/crawl.js` | 业务逻辑，按 ctx.pageLabel 分支（initial/posts/detail/exit） |

---

## 3. 详细流程（按执行顺序）

### 3.1 应用启动：注册 WebView handler

- **文件**：`src-tauri/kabegame/src/lib.rs`、`src-tauri/kabegame/src/startup.rs`
- **时机**：桌面端在 `setup` 中调用 `init_crawler_webview_handler(app_handle)`。
- **逻辑**：
  - 启动时不再创建常驻 crawler 窗口；
  - `kabegame-core` 只持有 `CrawlerWebViewHandler` trait，不依赖 Tauri；
  - worker 取到 JS 任务时委托 app 层创建 `crawler-<task_id>` 窗口，并注入 `bootstrap.js`。
- **说明**：bootstrap 是编译期嵌入的字符串，修改后需重新编译；crawl.js 来自插件包，运行时由 Rust 读入并传给 eval。

### 3.2 任务创建与上下文分配（Rust）

- **文件**：`src-tauri/kabegame-core/src/crawler/scheduler.rs`（`run_task` 内）、`src-tauri/kabegame-core/src/crawler/webview.rs`
- **流程**：
  1. `resolve_plugin_for_task_request` 得到 `(plugin, plugin_file_path)`，`plugin_file` 为 .kgpg 路径（或临时路径）。
  2. `read_plugin_js_script(&plugin_file)` 从插件 ZIP 内读取 **crawl.js** 全文（`src-tauri/kabegame-core/src/plugin/mod.rs` 中实现，读 ZIP 内 `crawl.js` 条目）。
  3. 若 `js_script.is_some()`（桌面）则走 WebView 分支：
     - 构建 **JsTaskContext**（含 task_id、plugin_id、**crawl_js**、merged_config、base_url、**page_label: "initial"**、page_state、state 等）。
     - `register_session(&task_id, context).await`：
       - 把 `CrawlerSession` 放入全局 session 注册表；
       - 返回 `oneshot::Receiver<TaskCompletion>`，worker 用它等待 JS 任务完成。
     - `get_webview_handler().create_task_window(&task_id, &base_url)`：
       - 实现位于 `src-tauri/kabegame/src/startup.rs` 的 `AppCrawlerWebViewHandler`；
       - 创建 label 为 `crawler-<task_id>` 的隐藏窗口，注入 bootstrap 并加载 `base_url`（若为空则 about:blank）；
       - 可选根据设置自动 show/focus 窗口。
  4. worker `await completion_rx`，任务完成/失败/取消后调用 `destroy_task_window(task_id)` 并 `remove_session(task_id)`。

### 3.3 页面加载后：Bootstrap 执行（每页一次）

- **文件**：`src-tauri/kabegame/resources/media_capture.js`、`src-tauri/kabegame/resources/bootstrap.js`
- **触发**：Tauri 的 **initialization_script** 在**每次** crawler WebView 的文档加载时执行（包括首次 about:blank 或 base_url，以及之后每次 `crawl_to` / `crawl_back` 导致的导航）。
- **步骤**：
  1. **媒体捕获预注入**：`media_capture.js` 先于页面脚本与 bootstrap 执行，注册 `window.__kb_media__.resolve(url)`。它维护 Blob / MediaSource 捕获注册表，解析 fMP4 `tfdt` 与 MPEG-TS PTS，对 MSE fragment 排序去重，并检测 DRM/EME。
  2. **媒体上传预注入**：`media_download.js` 注册 `window.__kb_media_download__(url, opts)`，负责 data/blob/MSE 上传、MSE 全缓冲、多 SourceBuffer 上传和桌面合流入口调用。
  3. **防重入**：`if (window.__crawl_starting__) return;`，`window.__crawl_starting__ = true`。
  4. **取上下文**：`ctx = await invoke("crawl_get_context")`。
     - 对应 Rust：`crawler.rs` 中 `crawl_get_context(webview)`，从调用方窗口 label 解析 task_id，再通过 `get_session(task_id)` 取上下文并返回给前端（含 crawl_js、pageLabel、state、pageState 等）。
  5. **校验**：`if (!ctx || !ctx.crawlJs) return;`，`ctx.state` 默认 `{}`。
  6. **通知就绪**：`await invoke("crawl_page_ready")`。
     - Rust：`crawl_page_ready(webview)` 里对该 session `set_page_ready(false)` 再 `set_page_ready(true)`，使等待 `wait_page_ready` 的调用方（如有）继续；同时 **script_dispatched** 在 `set_page_ready(false)` 时被置 false，允许本页再次派发脚本。
  7. **绑定 API**：`bindApiToContext(ctx, createApi(ctx))`，把 log、sleep、to、back、updateState、waitForSelector、clearData 等挂到 `ctx` 上。
  8. **挂到 window**：`window.__crawl_ctx__ = ctx`。
  9. **派发插件脚本**：`await invoke("crawl_run_script")`。
     - Rust：`crawl_run_script(webview)`：
       - `try_dispatch_script()`：若已在本页派发过则直接 return（同一页只执行一次 crawl.js）；
       - 从 session 取当前 `ctx`，用 **ctx.crawl_js** 拼成一段 IIFE，内层 `const ctx = window.__crawl_ctx__`，外层 try/catch 里执行插件脚本，异常时 `ctx.error(detail)`；
       - `webview.eval(wrapped_script)` 在调用方窗口当前页面执行。
  9. 最后 `delete window.__TAURI_INTERNALS__`（按需），`start().catch(...)` 捕获 bootstrap 自身错误。

**重要**：每次 **navigate** 都会产生新文档，因此都会重新执行上述 bootstrap 流程；`page_label` / `page_state` / `state` 由 Rust 在 `crawl_to` / `crawl_back` 中更新并持久化，所以插件脚本通过 `ctx.pageLabel` 等即可恢复“当前步骤”。

### 3.4 插件脚本执行（crawl.js）

- **文件**：插件目录下的 `crawl.js`，例如 `src-crawler-plugins/plugins/haowallpaper/crawl.js`；内容来自插件 .kgpg 内的 `crawl.js`，由 Rust 在任务创建时读入并放入 **JsTaskContext.crawl_js**。
- **执行方式**：由 `crawl_run_script` 用 `window.eval(wrapped_script)` 执行，脚本内可访问 `ctx = window.__crawl_ctx__`（已由 bootstrap 绑定好 API）。
- **典型结构**：根据 `ctx.pageLabel` 分支，例如：
  - `initial`：首次进入，可能 clearData、计算起始页，再 `ctx.to(url, { pageLabel: "posts", ... })`；
  - `posts`：列表页，解析条目，对某一项 `ctx.to(detailUrl, { pageLabel: "detail" })` 或翻页；
  - `detail`：详情页，执行下载逻辑，最后 `ctx.back()` 或 `ctx.to(...)`；
  - `exit`：`ctx.exit()` 结束任务。
- **状态持久化**：`ctx.updateState(patch)` / `ctx.updatePageState(patch)` 会通过 Tauri 命令写回 Rust 的 context，下次任意页面加载后 `crawl_get_context` 返回的即是更新后的 state/pageState。

### 3.5 导航：ctx.to() 与 ctx.back()

- **文件**：`src-tauri/kabegame/src/commands/crawler.rs`（`crawl_to`、`crawl_back`）、`src-tauri/kabegame-core/src/crawler/scheduler.rs`（page_stacks）、`src-tauri/kabegame-core/src/crawler/webview.rs`（patch_context_for_task）。
- **ctx.to(payload)**：
  - 解析 URL，解析 page_label / page_state；
  - 在 **page_stacks** 中：先更新栈顶的 page_label/page_state，再 push 新条目（target_url, new_page_label, new_page_state）；
  - `patch_context_for_task`：更新 current_url、page_label、page_state、resume_mode: "after_navigation"；
  - `session.set_page_ready(false)`；
  - 调用方 `webview.navigate(parsed_url)`；
  - 新页面加载 → 再次执行 bootstrap → get_context 拿到更新后的 page_label/page_state → run_script 执行 crawl.js 对应分支。
- **ctx.back(count)**：
  - 从 page_stacks 弹出 count 个条目，取新的栈顶的 url、page_label、page_state；
  - patch 回 context，`set_page_ready(false)`，`navigate(previous_url)`；
  - 同样会触发新文档加载与 bootstrap → 脚本按恢复的 page_label 继续执行。

### 3.6 任务结束与释放

- **文件**：`src-tauri/kabegame/src/commands/crawler.rs`（`crawl_exit`、`crawl_error`）、`src-tauri/kabegame-core/src/crawler/webview.rs`（`CrawlerSession::complete`）、`src-tauri/kabegame-core/src/crawler/task_scheduler.rs`（worker 统一收尾）。
- 脚本调用 `ctx.exit()` 或 `ctx.error(msg)`：
  - 命令按调用方 label 找 session；
  - `crawl_exit` 发送 `TaskCompletion { status: Completed }`；
  - `crawl_error` 根据错误内容发送 `Failed` 或 `Canceled`；
  - worker 被 completion 唤醒后统一 transition、发送事件、移除 page_stack、销毁 `crawler-<task_id>` 窗口并移除 session。
- 取消任务时，`TaskScheduler::cancel_task` 会取消下载并对对应 session 发送 `Canceled` completion，worker 按取消路径收尾。

---

## 4. 关键状态与约束

- **每任务独立窗口**：每个 JS 任务创建一个 `crawler-<task_id>` WebView 窗口；窗口句柄不存入 core，core 只保存 session 状态。
- **并发模型**：JS 任务全程占用一个 task worker 槽，与 Rhai 任务一致；并发由 `max_concurrent_tasks` 控制，不再有 crawler WebView 专用 `Semaphore(1)`。
- **命令路由**：crawler IPC 命令通过 Tauri 注入的调用方 `WebviewWindow` 解析 label，再从 session 注册表取上下文；native 操作直接作用于该 `webview`。
- **每页只派发一次脚本**：`script_dispatched` 在 set_page_ready(false) 时清零，在 crawl_run_script 中通过 try_dispatch_script 置 true，保证同一文档内只 eval 一次 crawl.js。
- **Bootstrap 每页必跑**：每次 navigate 都会重新执行 initialization_script(bootstrap.js)，因此不要依赖“上一页的 JS 变量或定时器”；所有跨页状态用 ctx.state / page_state 和 Rust 侧 context 维护。
- **crawl.js 来源**：由 Rust 从**插件 .kgpg 文件**内读取（ZIP 条目 `crawl.js`）。任务请求可带 `plugin_file_path`（临时 .kgpg 路径）或仅 `plugin_id`（从已安装缓存找对应 .kgpg）。开发时修改 `src-crawler-plugins/plugins/<id>/crawl.js` 后，需重新打包或通过能提供该 .kgpg 的流程启动任务，脚本内容才会更新。

---

## 5. Tauri 命令与 Capability

- **crawler 相关命令**（在 `lib.rs` 的 invoke_handler 中注册）：  
  `crawl_get_context`、`crawl_page_ready`、`crawl_run_script`、`crawl_to`、`crawl_back`、`crawl_task_log`、`crawl_add_progress`、`crawl_download_image`、`crawl_update_state`、`crawl_update_page_state`、`crawl_exit`、`crawl_error`、`crawl_clear_site_data`、`show_crawler_window` 等。
- **crawler 窗口** 使用 capability：`src-tauri/kabegame/capabilities/crawler.json`，窗口/webview 匹配 `crawler-*`，允许的 remote urls 为 `https://*.*`、`http://*.*`，权限包括 core:event、core:window:allow-hide 等；确保加载目标站时 invoke 可被允许。

### 5.1 `ctx.downloadImage` 与原生下载

WebView 后端的 `ctx.downloadImage(url, opts)` 对普通网络 URL 不再由 APP 侧 HTTP downloader 主动请求目标 URL。命令入口会先解析相对 URL、写入 metadata（得到 `metadata_id`）、合并任务 header 快照，并把这些入库参数登记到 `DownloadQueue.active_downloads` 的 `ActiveDownloadInfo { native: true, ... }`；随后直接调用调用方 crawler WebView 的原生下载能力（Linux CEF 为 `start_download(webview.label(), url)`），避免连续下载时多次导航互相打断。请求由浏览器原生下载栈发起，自动沿用浏览器 Cookie、站点会话与 Referer 语义。下载 URL 可能发生 30x 跳转，native download 的匹配 identity 使用 CEF `DownloadItem::original_url()`，避免最终 CDN URL 与脚本传入 URL 不一致时丢失 metadata/name/header。

浏览器下载完成后，crawler 窗口的 `on_download` 回调按 URL 从 `active_downloads` 取回对应 native 项，将落盘文件、header 快照、展示名、`metadata_id` 和输出画册一起交给下载器统一后处理入库。这样后续去重、缩略图、画册写入、任务计数和事件广播仍复用下载器主流程，`get_active_downloads` 也能从同一列表返回池下载与 native 下载。

`data:` 与 `blob:` URL 走 JS 层流式上传，不触发 WebView 原生下载：

- `data:` 在页面内 `fetch` 成 Blob 后分块上传。
- 普通 Blob URL 由 `media_capture.js` 的 `URL.createObjectURL` 注册表解析，未命中时兜底 `fetch(blobUrl)`。
- MSE Blob URL 由 `SourceBuffer.appendBuffer` 捕获的数据还原；下载前会尝试驱动对应 `<video>` 全缓冲。fMP4 与 MPEG-TS fragment 在捕获层按解码时间排序去重；多 SourceBuffer 会按多流上传，桌面由 Rust/rsmpeg 合流，Android 优雅报错。超过捕获上限、直播无法全缓冲或 DRM/EME 内容会向插件抛出明确错误。

上传命令为 `crawl_media_begin` / `crawl_media_chunk` / `crawl_media_end`。它们按调用方 label 解析上下文：`crawler-<task_id>` 走 crawler session；`surf-{host}` 走畅游记录上下文。crawler 路径仍把会话登记进同一个 `DownloadQueue.active_downloads`，所以任务抽屉状态、进度、取消清理和后处理事件与 native 下载一致。

---

## 6. 与 Rhai 后端的区别

- **Rhai**：无 WebView，脚本在 Rust 侧 Rhai 引擎执行，通过 HTTP 请求 + 字符串解析抓取；适合接口清晰、无强反爬的站点。
- **JS（本文档）**：真实浏览器环境，crawl.js 在 crawler WebView 内执行，可操作 DOM、Cookie、localStorage；状态与导航由 Rust 与 bootstrap 协同，适合 SPA、需登录或强反爬的站点。  
后端选择规则见 `docs/CRAWLER_BACKENDS.md`（有 crawl.js 且桌面端则用 WebView）。

---

以上即 JS 爬虫从任务创建、窗口注入、bootstrap、脚本派发到导航与结束的完整流程及对应代码文件；修改行为或排查问题时可按上述路径直接定位到具体模块与函数。
