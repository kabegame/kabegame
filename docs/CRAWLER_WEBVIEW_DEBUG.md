# WebView 爬虫调试总结

本文档总结 anime-pictures WebView 爬虫从「运行即报错」到「有进行中的下载但迟迟不完成」的修复过程，以及**当前待排查问题**，供下一轮调试使用。

---

## 1. 已修复问题汇总

### 1.1 脚本启动即报错（TDZ）

- **现象**：`@https://anime-pictures.net/:11:18`，`run` 内报错。
- **原因**：`crawl.js` 中 `const ctx = ctx.currentContext();` 产生 Temporal Dead Zone（局部 `ctx` 遮蔽外层，右侧访问未初始化的 `ctx`）。
- **修复**：删除该行，直接使用外层注入的 `ctx`（`pageLabel` 等从 `ctx` 读取即可）。

### 1.2 event.listen 与 IPC 被拒绝（capability）

- **现象**：控制台 `event.listen not allowed on window "crawler"`, `ipc://localhost/... blocked`。
- **原因**：`tauri.conf.json` 的 `security.capabilities` 只包含 `main-capability`，未包含 `crawler-capability`；且 crawler 窗口需对**远程 URL** 有权限。
- **修复**：
  - 在 `tauri.conf.json` 的 `security.capabilities` 中加入 `"crawler-capability"`。
  - 在 `capabilities/crawler.json` 中：`windows` + `webviews` 均为 `["crawler"]`，`remote.urls` 使用 `["https://*.*", "http://*.*"]`，显式权限 `core:event:allow-listen` 等（参考 Pake 写法）。

### 1.3 无限导航循环（to API 与 pageLabel 未传递）

- **现象**：日志中每 2–3 秒重复 `crawl_get_context` → `crawl_run_script` → `crawl_to`，`page_label` 始终为 `"initial"`，`payload_page_label` 为 `null`。
- **原因**：`crawl.js` 调用 `ctx.to(url, { pageLabel, pageState })`，但 bootstrap 的 `to()` 只接受一个参数，第二个参数被丢弃，Rust 端收不到 `pageLabel`/`pageState`，无法更新上下文。
- **修复**：`bootstrap.js` 中 `to(payload, opts)` 支持第二参数，合并进 payload 后调用 `invoke("crawl_to", { payload })`。

### 1.4 列表页报错 "Page stack has no previous page"

- **现象**：进入 posts 后执行 `ctx.back()` 时报错。
- **原因**：首次 `crawl_to` 时页面栈为空，只 push 了目标页（1 个条目），`crawl_back` 要求至少 2 个条目。
- **修复**：在 `crawl_to` 中若 `stack.is_empty()`，先 push 当前页（`current_url`/`page_label`/`page_state`）再 push 目标页。

### 1.5 DOM 未就绪导致选择器为空

- **现象**：initialization_script 在 document 早期执行，列表页 DOM 尚无 `.img-block`，`document.querySelector` 返回 null，误走 `ctx.back()`。
- **修复**：bootstrap 增加 `waitForDom()`（基于 `DOMContentLoaded`）和 `$()`/`$$()`；`crawl.js` 的 `handlePosts`/`handleDetail` 开头 `await ctx.waitForDom()` 后再用 `ctx.$()` 查元素。

---

## 2. 当前状态（日志证据）

最近一次运行日志（` .cursor/debug-26b85d.log`）表明流程已跑通：

- `page_label` 正确：`initial` → `posts` → `detail`，且 `crawl_to` 的 `payload_page_label`/`payload_page_state` 正确传递。
- 多次进入 detail（如 911578, 911580, 911579, 911582, 911585），说明列表解析与翻页/回退逻辑正常。
- **前端可见「进行中的下载」**，但**下载迟迟不完成**。

---

## 3. 待排查问题：浏览器下载不完成

### 3.1 流程简述

1. **Rust 端**（`src-tauri/core/src/crawler/downloader/mod.rs`）  
   - Worker 在 `browser_download: true` 时：生成 `download_id`，在 `BrowserDownloadState` 中 `register(download_id, destination, task_id, completion_tx)`，然后 `GlobalEmitter::global().emit("crawl-browser-download", { url, downloadId })`，并 `emit_download_state(..., "downloading", ...)`（前端据此显示「进行中」）。  
   - Worker 通过 `completion_rx` 等待完成，超时 300 秒。

2. **事件转发**（`src-tauri/app-main/src/startup.rs`）  
   - `start_local_event_loop` 里对 `DaemonEvent::Generic { event, payload }` 调用 `app.emit(event, payload)`，Tauri 的 `app.emit` 会发往**所有窗口**，包括 crawler。

3. **Crawler 窗口**（`src-tauri/app-main/resources/bootstrap.js`）  
   - 通过 `plugin:event|listen` 监听 `"crawl-browser-download"`（依赖 crawler-capability）。  
   - 收到后：`fetch(payload.url)` → `blob` → `URL.createObjectURL(blob)` → `invoke("crawl_register_blob_download", { downloadId, blobUrl })` → 创建 `<a href=blobUrl download>` 并 `click()`。

4. **Rust 端**（`crawl_register_blob_download`）  
   - 校验 `download_id` 在 `BrowserDownloadState` 的 pending 中，然后 `register_blob_url(download_id, blob_url)`，建立 `blob_url ↔ download_id` 映射。

5. **WebView 的 on_download**（`src-tauri/app-main/src/startup.rs`，`create_crawler_window`）  
   - 在 `DownloadEvent::Requested` 中：若 `BrowserDownloadState::global().resolve_destination_by_blob_url(url)` 返回 `Some(dest)`，则设置 `*destination = dest` 并返回 `true`，否则 `false`。  
   - 在 `DownloadEvent::Finished` 中：`signal_completion_by_blob_url(url, path, success)`，从而向 worker 的 `completion_tx` 发送结果，下载在 Rust 侧标记为完成。

### 3.2 可能断点（建议优先排查）

| 环节 | 可能原因 | 建议排查 |
|------|----------|----------|
| Crawler 未收到事件 | capability 仍不生效或仅 main 收到 | 在 bootstrap 的 listen callback 里打 log / 用调试日志确认 crawler 窗口是否收到 `crawl-browser-download`。 |
| fetch 失败 | 目标站 CORS、网络错误、URL 错误 | 在 bootstrap 的 fetch 后看 `res.ok`、catch 里是否调用了 `crawl_browser_download_failed`；控制台是否有 CORS/network 错误。 |
| crawl_register_blob_download 失败 | download_id 不匹配、pending 中无此项 | 看 Rust 端该命令是否返回 Err；确认 worker 里 `register` 与 emit 的 `downloadId` 一致。 |
| on_download 未识别 blob | blob URL 字符串不一致（编码、尾斜杠等） | 对比 `register_blob_url` 写入的 key 与 `on_download` 里收到的 `url.as_str()`；必要时在 `resolve_destination_by_blob_url` 打 log。 |
| on_download 未触发 | 程序化 `<a download>` 在某些平台/WebView 不触发下载事件 | 查 Tauri 文档/issue，看是否需改用其他方式触发下载；或在 crawler 窗口用 DevTools 确认是否有下载请求。 |
| 超时 300s | 以上任一环节卡住，completion 从未被 signal | 确认 300 秒后是否出现 "Browser download timed out" 或类似错误，并反推是哪一步未执行。 |

### 3.3 关键文件索引

- **Rust**  
  - 下载 worker 与 browser 流程：`src-tauri/core/src/crawler/downloader/mod.rs`（约 1029–1090 行：emit、等待 completion_rx、超时）。  
  - Blob 状态与完成信号：`src-tauri/core/src/crawler/downloader/browser_download.rs`（`register`、`register_blob_url`、`resolve_destination_by_blob_url`、`signal_completion_by_blob_url`）。  
  - Crawler 窗口创建与 on_download：`src-tauri/app-main/src/startup.rs`（`create_crawler_window`，约 354–399 行）。  
  - 注册 blob 命令：`src-tauri/app-main/src/commands/crawler.rs`（`crawl_register_blob_download`、`crawl_browser_download_failed`）。
- **前端 / 脚本**  
  - Bootstrap（监听、fetch、注册 blob、触发下载）：`src-tauri/app-main/resources/bootstrap.js`（`ensureBrowserDownloadListener`、callback 内 fetch + invoke + `<a>.click()`）。  
  - 插件脚本：`src-crawler-plugins/plugins/anime-pictures/crawl.js`。

---

## 4. 调试用日志与清理说明

- **Rust 调试日志**：当前在 `crawler.rs` 的 `crawl_get_context`、`crawl_run_script`、`crawl_error`、`crawl_to` 等处写入了 `debug_log(...)`，输出到 **`.cursor/debug-26b85d.log`**（NDJSON，按行解析）。  
- 若下一轮不再需要这些日志，可在确认问题后删除 `crawler.rs` 中的 `debug_log` 调用及 `debug_log` 函数本身；亦可保留用于复现「下载不完成」时的调用顺序。
- **JS 调试**：远程页面（如 anime-pictures.net）上对 `http://127.0.0.1:7584/ingest/...` 的 fetch 可能被混合内容策略拦截，若需在 crawler 窗口内打 log，可优先用 `console.log` 或 Tauri 的 `crawl_task_log` 等不依赖外网的方式。

---

## 5. 小结

- **已解决**：脚本 TDZ、capability、to API 传参、页面栈初始化、DOM 等待与选择器 API；流程上已能从 initial → posts → detail 多次循环，且前端能看到「进行中的下载」。  
- **待解决**：浏览器下载路径上某一步未完成（事件未达 / fetch 失败 / blob 未注册或未匹配 / on_download 未触发或未 signal），导致 worker 一直等待 completion，表现为「下载迟迟不完成」。建议按 3.2 表格从「crawler 是否收到事件」和「blob 是否注册并匹配」两条线加 log 或断点排查。
