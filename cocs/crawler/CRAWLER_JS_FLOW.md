# JS 爬虫（WebView 后端）加载与运行流程

本文档描述 **crawl.js**（WebView 后端）从任务创建到脚本执行、导航与回退的完整流程及涉及代码文件，便于 AI/开发者快速定位，避免重复探索。

---

## 1. 流程总览

```
用户启动插件任务
    → Scheduler 解析插件、构建 JsTaskContext、assign_task
    → setup_js_task：WebView navigate 到 base_url
    → 页面加载 → 每次加载都会执行 initialization_script（bootstrap.js）
    → bootstrap: crawl_get_context → crawl_page_ready → bindApi → crawl_run_script
    → Rust: try_dispatch_script → eval(crawl.js 包装)
    → crawl.js 根据 ctx.pageLabel 分支执行（initial / posts / detail / exit）
    → 脚本调用 ctx.to() / ctx.back() → Rust 更新上下文并 navigate → 新页面再次走 bootstrap → 循环
```

---

## 2. 涉及代码文件一览

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 任务入口 | `src-tauri/kabegame-core/src/crawler/scheduler.rs` | 解析插件、构建 JsTaskContext、assign_task、调用 setup_js_task |
| 插件脚本读取 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `read_plugin_js_script(zip_path)` 从 .kgpg 内读 `crawl.js` |
| 窗口状态 | `src-tauri/kabegame-core/src/crawler/webview.rs` | CrawlerWindowState、JsTaskContext、assign_task、set_page_ready、try_dispatch_script |
| 窗口创建与注入 | `src-tauri/kabegame/src/startup.rs` | create_crawler_window（initialization_script 注入 bootstrap.js）、AppCrawlerWebViewHandler::setup_js_task（navigate） |
| Bootstrap 脚本 | `src-tauri/kabegame/resources/bootstrap.js` | 每次页面加载执行：get_context → page_ready → bindApi → run_script |
| Tauri 命令 | `src-tauri/kabegame/src/commands/crawler.rs` | crawl_get_context、crawl_page_ready、crawl_run_script、crawl_to、crawl_back、crawl_task_log 等 |
| 权限 | `src-tauri/kabegame/capabilities/crawler.json` | crawler 窗口/webview 的 Tauri 权限（remote URLs、events、window） |
| 插件脚本 | `src-crawler-plugins/plugins/<id>/crawl.js` | 业务逻辑，按 ctx.pageLabel 分支（initial/posts/detail/exit） |

---

## 3. 详细流程（按执行顺序）

### 3.1 应用启动：创建 Crawler 窗口并注入 Bootstrap

- **文件**：`src-tauri/kabegame/src/lib.rs`、`src-tauri/kabegame/src/startup.rs`
- **时机**：桌面端在 `setup` 中调用 `init_crawler_window(app_handle)`。
- **逻辑**：
  - `create_crawler_window`：用 `WebviewWindowBuilder::new(..., "crawler", WebviewUrl::External(about_blank))` 创建窗口；
  - **Bootstrap 注入**：`initialization_script(include_str!("../resources/bootstrap.js"))`，即 **每次该 WebView 加载任意文档（包括 about:blank 与后续 navigate 的页面）都会先执行 bootstrap.js**。
- **说明**：bootstrap 是编译期嵌入的字符串，修改后需重新编译；crawl.js 来自插件包，运行时由 Rust 读入并传给 eval。

### 3.2 任务创建与上下文分配（Rust）

- **文件**：`src-tauri/kabegame-core/src/crawler/scheduler.rs`（`run_task` 内）、`src-tauri/kabegame-core/src/crawler/webview.rs`
- **流程**：
  1. `resolve_plugin_for_task_request` 得到 `(plugin, plugin_file_path)`，`plugin_file` 为 .kgpg 路径（或临时路径）。
  2. `read_plugin_js_script(&plugin_file)` 从插件 ZIP 内读取 **crawl.js** 全文（`src-tauri/kabegame-core/src/plugin/mod.rs` 中实现，读 ZIP 内 `crawl.js` 条目）。
  3. 若 `js_script.is_some()`（桌面）则走 WebView 分支：
     - 构建 **JsTaskContext**（含 task_id、plugin_id、**crawl_js**、merged_config、base_url、**page_label: "initial"**、page_state、state 等）。
     - `crawler_window_state().assign_task(context).await`：
       - 占位 semaphore，将 context 存入 `current_task`；
       - `page_ready_tx.send(false)`，便于后续等待“页面就绪”。
     - `get_webview_handler().setup_js_task(&task_id, &base_url)`：
       - 实现位于 `src-tauri/kabegame/src/startup.rs` 的 `AppCrawlerWebViewHandler`；
       - 获取 crawler 窗口并 **navigate(base_url)**（若为空则 about:blank）；
       - 可选根据设置自动 show/focus 窗口。
  4. 返回 `TaskOutcome::HandledOffToWebView`，任务由 WebView 端接管。

### 3.3 页面加载后：Bootstrap 执行（每页一次）

- **文件**：`src-tauri/kabegame/resources/bootstrap.js`
- **触发**：Tauri 的 **initialization_script** 在**每次** crawler WebView 的文档加载时执行（包括首次 about:blank 或 base_url，以及之后每次 `crawl_to` / `crawl_back` 导致的导航）。
- **步骤**：
  1. **防重入**：`if (window.__crawl_starting__) return;`，`window.__crawl_starting__ = true`。
  2. **取上下文**：`ctx = await invoke("crawl_get_context")`。
     - 对应 Rust：`crawler.rs` 中 `crawl_get_context()`，从 `crawler_window_state().get_context().await` 取当前任务上下文并返回给前端（含 crawl_js、pageLabel、state、pageState 等）。
  3. **校验**：`if (!ctx || !ctx.crawlJs) return;`，`ctx.state` 默认 `{}`。
  4. **通知就绪**：`await invoke("crawl_page_ready")`。
     - Rust：`crawl_page_ready()` 里 `state.set_page_ready(false)` 再 `set_page_ready(true)`，使等待 `wait_page_ready` 的调用方（如有）继续；同时 **script_dispatched** 在 `set_page_ready(false)` 时被置 false，允许本页再次派发脚本。
  5. **绑定 API**：`bindApiToContext(ctx, createApi(ctx))`，把 log、sleep、to、back、updateState、waitForSelector、clearData 等挂到 `ctx` 上。
  6. **挂到 window**：`window.__crawl_ctx__ = ctx`。
  7. **派发插件脚本**：`await invoke("crawl_run_script")`。
     - Rust：`crawl_run_script(app)`：
       - `try_dispatch_script()`：若已在本页派发过则直接 return（同一页只执行一次 crawl.js）；
       - 从 state 取当前 `ctx`，用 **ctx.crawl_js** 拼成一段 IIFE，内层 `const ctx = window.__crawl_ctx__`，外层 try/catch 里执行插件脚本，异常时 `ctx.error(detail)`；
       - `crawler_window.eval(wrapped_script)` 在当前页面执行。
  8. 最后 `delete window.__TAURI_INTERNALS__`（按需），`start().catch(...)` 捕获 bootstrap 自身错误。

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
  - `state.set_page_ready(false)`；
  - `crawler_window.navigate(parsed_url)`；
  - 新页面加载 → 再次执行 bootstrap → get_context 拿到更新后的 page_label/page_state → run_script 执行 crawl.js 对应分支。
- **ctx.back(count)**：
  - 从 page_stacks 弹出 count 个条目，取新的栈顶的 url、page_label、page_state；
  - patch 回 context，`set_page_ready(false)`，`navigate(previous_url)`；
  - 同样会触发新文档加载与 bootstrap → 脚本按恢复的 page_label 继续执行。

### 3.6 任务结束与释放

- **文件**：`src-tauri/kabegame/src/commands/crawler.rs`（`crawl_exit`、`crawl_error`）、`src-tauri/kabegame-core/src/crawler/webview.rs`（`release_task`）。
- 脚本调用 `ctx.exit()` 或 `ctx.error(msg)`：
  - 更新任务状态、发送事件、移除 page_stack、**release_task** 释放 current_task 与 semaphore，并 `page_ready_tx.send(false)`。
- 之后 crawler 窗口可能仍打开，但无任务占用；下次新任务会再次 assign_task 并 navigate。

---

## 4. 关键状态与约束

- **单任务占窗**：同一时刻 crawler 窗口只服务一个任务（semaphore + current_task）；assign_task 时若拿不到 permit 会失败。
- **每页只派发一次脚本**：`script_dispatched` 在 set_page_ready(false) 时清零，在 crawl_run_script 中通过 try_dispatch_script 置 true，保证同一文档内只 eval 一次 crawl.js。
- **Bootstrap 每页必跑**：每次 navigate 都会重新执行 initialization_script(bootstrap.js)，因此不要依赖“上一页的 JS 变量或定时器”；所有跨页状态用 ctx.state / page_state 和 Rust 侧 context 维护。
- **crawl.js 来源**：由 Rust 从**插件 .kgpg 文件**内读取（ZIP 条目 `crawl.js`）。任务请求可带 `plugin_file_path`（临时 .kgpg 路径）或仅 `plugin_id`（从已安装缓存找对应 .kgpg）。开发时修改 `src-crawler-plugins/plugins/<id>/crawl.js` 后，需重新打包或通过能提供该 .kgpg 的流程启动任务，脚本内容才会更新。

---

## 5. Tauri 命令与 Capability

- **crawler 相关命令**（在 `lib.rs` 的 invoke_handler 中注册）：  
  `crawl_get_context`、`crawl_page_ready`、`crawl_run_script`、`crawl_to`、`crawl_back`、`crawl_task_log`、`crawl_add_progress`、`crawl_download_image`、`crawl_update_state`、`crawl_update_page_state`、`crawl_exit`、`crawl_error`、`crawl_clear_site_data`、`show_crawler_window` 等。
- **crawler 窗口** 使用 capability：`src-tauri/kabegame/capabilities/crawler.json`，允许的 remote urls 为 `https://*.*`、`http://*.*`，权限包括 core:event、core:window:allow-hide 等；确保加载目标站时 invoke 可被允许。

---

## 6. 与 Rhai 后端的区别

- **Rhai**：无 WebView，脚本在 Rust 侧 Rhai 引擎执行，通过 HTTP 请求 + 字符串解析抓取；适合接口清晰、无强反爬的站点。
- **JS（本文档）**：真实浏览器环境，crawl.js 在 crawler WebView 内执行，可操作 DOM、Cookie、localStorage；状态与导航由 Rust 与 bootstrap 协同，适合 SPA、需登录或强反爬的站点。  
后端选择规则见 `docs/CRAWLER_BACKENDS.md`（有 crawl.js 且桌面端则用 WebView）。

---

以上即 JS 爬虫从任务创建、窗口注入、bootstrap、脚本派发到导航与结束的完整流程及对应代码文件；修改行为或排查问题时可按上述路径直接定位到具体模块与函数。
