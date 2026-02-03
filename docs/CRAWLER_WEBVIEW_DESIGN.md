# 基于 WebView + 本地 Rust 透明代理的爬虫架构设计

本文档描述 Kabegame 爬虫后端的统一方案：**JS 爬虫脚本 + 本地 Rust 代理 + WebView**。**仅支持 JS，不再支持 Rhai**。代理 fetch 目标页面后流式返回，父与 iframe 同源可读 DOM；下载优先使用浏览器 + on_download，若不支持则 fallback 到 reqwest。**不实现下载进度**，无 mitmproxy 等外部依赖。

**任务调度**：一次仅允许一个爬虫任务运行，其他任务排队等待。运行中的任务独占全部图片下载并发量。HTTP 代理可据此明确当前请求所属任务，便于按任务配置修改 HTTP 头（如 Origin）。

**代理方式**：iframe 的 `src` 使用代理服务器 URL（如 `http://127.0.0.1:{port}/proxy?url=https://konachan.com/page/1`），由代理 fetch 目标页面后流式返回，父页面与 iframe 同源，可直接读取 DOM。代理根据当前运行任务的 `config.json` 中 `baseUrl` 及用户配置修改请求头（如 Origin，用户配置优先级高于 baseUrl）。

## 1. 背景与动机

原 Rhai 爬虫使用 reqwest + scraper，存在：
- 不执行页面 JavaScript，无法处理 SPA
- 难以复用 WebView 的 cookie
- 插件开发者更熟悉 JavaScript

新方案采用 **纯 Rust 本地透明代理**，实现：
- 所有请求经代理转发，支持自定义 HTTP 头
- 子 iframe 通过代理加载，可与父页面同源，直接读取 DOM
- 不区分 fetch/download，Rust 只做转发，浏览器自行决定展示或下载
- 不实现 Rust 侧下载进度（wry/Tauri 当前不暴露底层进度事件）
- 无 Python/mitmproxy 依赖，跨平台部署简单

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  主应用 WebView（爬虫模式）                                                        │
│  - 加载 http://127.0.0.1:{port}/crawler，内含 iframe 容器 + crawl API              │
│  - iframe src 为 /proxy?url=...，代理 fetch 目标页面后返回，与父同源可读 DOM         │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │ 所有请求均发往本地代理服务器 127.0.0.1:{port}
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  本地透明代理（Rust，应用内启动）                                                  │
│  - 单任务运行：仅一个任务在执行，代理根据当前任务配置修改请求头                       │
│  - Origin：由 config.json 的 baseUrl 决定，单任务用户配置优先级更高                  │
│  - /crawler  → 爬虫运行时页面                                                      │
│  - /proxy?url=xxx：代理 fetch 目标 URL，修改 headers 后流式返回，父与 iframe 同源      │
│  - 使用 reqwest + axum                                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**数据流**：
- 爬虫 `to(url)` → iframe 加载 `http://127.0.0.1:{port}/proxy?url={encodeURIComponent(url)}` → 代理 fetch 目标 URL，按当前任务配置附加/修改 Origin 等 headers 后流式返回 → 父与 iframe 同源，可直接读取 DOM
- 爬虫 `download_image(url)` → 若支持 destination：`<a download>` + 浏览器下载 + Tauri `on_download` 拦截并指定路径；若不支持：Rust reqwest 直接下载

**同源**：iframe `src` 为代理服务器 URL（如 `/proxy?url=...`），代理 fetch 目标页面后返回，父页面与 iframe 均来自同一代理 origin，可直接 `iframe.contentDocument` 读 DOM。

## 3. 核心优势

| 问题 | 透明代理方案下的解决方式 |
|------|---------------------------|
| 跨域 | 父页面与 iframe 均加载自代理服务器，同源 |
| 自定义 HTTP 头 | reqwest 在请求时附加 `headers`，完全可控 |
| 通信复杂 | 同源 iframe，直接 `iframe.contentDocument.querySelector` |
| 依赖 | 无 Python，仅 Rust + axum + reqwest |
| fetch vs download | 不区分，Rust 纯转发；浏览器根据用法（img vs a download）自行决定 |
| 下载进度 | 不实现；用户可见浏览器/系统自带的下载 UI（若有） |

## 4. 技术选型

### 4.1 reqwest

项目已依赖 reqwest，其能力足以胜任：

- **自定义 headers**：`client.get(url).headers(HeaderMap)`
- **Cookie 持久化**：`ClientBuilder::cookie_store(true)`，同一 client 多次请求自动携带 Set-Cookie
- **流式响应**：`response.bytes_stream()`，边收边转发，不缓冲到内存

### 4.2 HTTP 服务器

推荐 **axum**：API 清晰，与 Tauri 的 tokio 运行时兼容，项目 [NETWORK_SYNC_DESIGN](./NETWORK_SYNC_DESIGN.md) 已有提及。

## 5. 代理服务器设计

### 5.1 路由

| 路径/角色 | 用途 |
|----------|------|
| `/crawler` | 爬虫运行时页面，含 iframe 容器与 `crawl` API |
| `/proxy?url=xxx` | 代理 fetch 目标 URL，按当前任务配置修改请求头后流式返回；iframe 加载此 URL，与父页面同源 |
| `/plugin/html?path=xxx` | 无 baseUrl 插件：可选 HTML 项目，被请求时代理从插件包载入并返回；不提供则 404 |

### 5.2 请求头修改逻辑

代理在转发前修改请求头，**Origin** 等来源：

1. **config.json 的 baseUrl**：作为默认 Origin（解析为 `scheme + host`）
2. **单任务用户配置**：用户为该任务配置的 HTTP 头，**优先级高于 baseUrl**

```rust
// 当前仅一个任务在运行，代理从 Rust 状态获取 current_task_id
fn headers_for_current_task(current_task: &TaskContext) -> HeaderMap {
    let mut header_map = HeaderMap::new();
    // 1. Origin：用户配置 > config.json baseUrl
    let origin = current_task
        .user_headers
        .get("Origin")
        .or_else(|| derive_origin_from_base_url(&current_task.plugin_config.base_url))
        .cloned();
    if let Some(v) = origin {
        header_map.insert("Origin", v.parse().unwrap());
    }
    // 2. 其他用户配置的 header
    for (k, v) in &current_task.user_headers {
        if k.eq_ignore_ascii_case("Origin") { continue; } // 已处理
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
            header_map.insert(name, value);
        }
    }
    header_map
}
```

### 5.3 iframe 同源

iframe 的 `src` 使用代理服务器 URL，如 `http://127.0.0.1:{port}/proxy?url={encodeURIComponent(targetUrl)}`。代理 fetch 目标页面，修改 headers 后流式返回；父页面与 iframe 同源，可直接 `iframe.contentDocument` 读取 DOM。页面内相对链接由浏览器按当前文档 URL 解析，点击后仍请求代理，代理再 fetch 目标并返回。

### 5.4 Cookie 与会话

- 单任务运行时，代理为当前任务维护一个 `reqwest::Client`，启用 `cookie_store(true)`
- 同一任务的所有请求复用该 client，自动携带 Set-Cookie

### 5.5 插件初始页面与可选 HTML

**有 baseUrl 的插件**：启动任务时，iframe 会自动先加载 baseUrl 所在页面并显示，爬虫脚本可从该页面开始执行。

**无 baseUrl 的插件**：可提供可选的 **HTML 项目**（如插件包内的 `html/` 目录）。当 iframe 请求 `/plugin/html?path=xxx` 时，代理服务器从当前任务对应的插件包内载入对应 HTML 并返回。此项目为**可选**：若插件不提供 HTML 项目，该路由不生效或返回 404，爬虫脚本需自行调用 `crawl.to(url)` 加载首屏。

## 6. 爬虫 API 与页面栈

### 6.1 crawl API（同源 + jQuery）

iframe 加载代理 URL（`/proxy?url=...`），父与 iframe 同源，可直接读取 DOM。提供 jQuery 接口，作用于当前 iframe 的 `contentDocument`，便于 DOM 操作：

```javascript
// crawler-runtime.js
import { invoke } from '@tauri-apps/api/core';

const crawl = {
  pageStack: [],
  taskId: '',
  pluginId: '',
  proxyBase: '',  // 如 http://127.0.0.1:port

  async to(url) {
    const frame = this.createFrame(url);
    this.pageStack.push(frame);
    this.showTopFrame();
    await frame.ready;
  },

  back() {
    if (this.pageStack.length <= 1) return;
    this.pageStack.pop();
    this.showTopFrame();
  },

  currentUrl() {
    const top = this.pageStack[this.pageStack.length - 1];
    return top?.url ?? '';
  },

  createFrame(url) {
    const proxyUrl = `${this.proxyBase}/proxy?url=${encodeURIComponent(url)}`;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    iframe.src = proxyUrl;  // 加载代理 URL，与父同源
    const frame = { iframe, url, ready: null };
    frame.ready = new Promise((resolve) => {
      frame._resolveReady = resolve;
    });
    iframe.onload = () => frame._resolveReady?.();
    document.getElementById('iframe-container').appendChild(iframe);
    return frame;
  },

  showTopFrame() {
    this.pageStack.forEach((f, i) => {
      f.iframe.style.display = i === this.pageStack.length - 1 ? 'block' : 'none';
    });
  },

  // jQuery 接口：作用于当前 iframe 的 document，需在 crawler 页面 bundle jQuery
  $(selector) {
    const top = this.pageStack[this.pageStack.length - 1];
    if (!top) return window.jQuery?.() ?? [];
    const doc = top.iframe.contentDocument;
    if (!doc) return window.jQuery?.() ?? [];
    return window.jQuery(selector, doc);
  },

  resolve_url(relative) {
    const base = this.currentUrl();
    if (!base) return relative;
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  },

  async add_progress(pct) {
    await invoke('crawl_add_progress', { taskId: this.taskId, pct });
  },

  set_interval(ms) {
    if (ms >= 0) invoke('crawl_set_task_interval', { taskId: this.taskId, ms });
  },

  async download_image(url, filename) {
    const result = await invoke('crawl_prepare_download', {
      taskId: this.taskId,
      pluginId: this.pluginId,
      url,
      filename,
    });
    // result.useBrowser === true：平台支持 destination，执行 <a download> 由 on_download 拦截
    // result.useBrowser === false：Rust 已用 reqwest 下载完成，无需操作
    if (result?.useBrowser) {
      const a = document.createElement('a');
      a.href = `${this.proxyBase}/proxy?url=${encodeURIComponent(url)}`;
      a.download = filename;
      a.click();
    }
  },
};

window.crawl = crawl;
```

### 6.2 单任务独占与下载并发

**任务调度**：一次仅允许一个爬虫任务运行，其他任务排队；运行中的任务独占全部图片下载并发量。

| 控制类型 | 来源 | 说明 |
|----------|------|------|
| **并发上限** | Settings `max_concurrent_downloads` | 当前运行任务独占，限制其最大同时下载数 |
| **下载间隔** | `set_interval(ms)` | 可选，上一下载完成后再过 `ms` 毫秒才能触发下一个，用于防封 |

**实现**：`crawl_prepare_download` 作为门控，Rust 内异步等待直到满足条件；若支持 destination 则登记 `url→path` 并返回 `{useBrowser:true}`，JS 执行 `<a click>`；若不支持则内部用 reqwest 下载完成后返回 `{useBrowser:false}`，JS 无需操作。仅一个任务在跑，代理和门控都只需关心 `current_task_id`。

```
crawl.download_image(url, filename)
    │
    ├─ await invoke('crawl_prepare_download', {...})  ← 阻塞，直到允许
    │      Rust: 检查并发 + 间隔，满足则登记 (url → path)，返回
    │
    └─ 若 useBrowser：<a click> 触发浏览器下载（请求发往代理）→ on_download 拦截并指定 destination
       若不支持：Rust 已在 invoke 内用 reqwest 下载完成
```

**任务取消**：取消时清空该任务等待队列，reject 正在等待的 `prepare_download`。

### 6.3 下载行为

- **若 Tauri/wry 支持设置 download destination**：点击 `<a href="..." download="x">` 后，请求经代理转发，浏览器触发原生下载，Tauri `on_download` 拦截并从映射取出目标路径设置 `destination`
- **若不支持 destination**：`crawl_prepare_download` 返回后，Rust 侧直接用 reqwest 下载到目标路径，JS 无需执行 `<a click>`
- 不实现下载进度；用户可见系统/浏览器自带的下载 UI（若有）

## 7. 启动流程

1. 用户配置 HTTP 头 → 存入任务上下文
2. 启动 axum 代理服务器，绑定 `127.0.0.1:0` 获取随机端口
3. WebView 加载 `http://127.0.0.1:{port}/crawler`（爬虫模式）
4. 启动任务时：若无任务运行则立即执行，否则加入排队；当前任务独占代理与下载并发
5. 初始页面：有 baseUrl 的插件，iframe 自动先加载 baseUrl 页面；无 baseUrl 的插件，可提供可选 HTML 项目由代理按需载入，或不提供而由脚本自行 `crawl.to(url)`
6. 爬虫脚本调用 `crawl.to()`、`crawl.$()`（jQuery）、`crawl.download_image()` 等

## 8. 调试与请求日志（可选）

- 代理侧用 `tracing` 记录每次转发的 URL、状态码
- 提供 `/debug/requests` 接口返回近期请求列表（开发模式）

## 9. 示例爬虫脚本（JS）

爬虫脚本使用 jQuery 操作 DOM，`crawl.$()` 作用于当前 iframe 的 document：

```javascript
// crawl.js - konachan 等价实现（使用 jQuery）
(async function () {
  if (end_page >= start_page + 100) throw new Error('在一次之内不允许爬取超过100页');
  if (end_page < start_page) throw new Error('结束页面需要比开始页面大');

  // 可选：限制下载间隔，防止被封
  // crawl.set_interval(2000);

  const totalPages = () => end_page - start_page + 1;

  const processDetailPage = async (href) => {
    const fullUrl = crawl.resolve_url(href);
    await crawl.to(fullUrl);

    let images = [];
    let q = quality;
    if (q === 'high') {
      const href = crawl.$('#resized_notice > a.highres-show').attr('href');
      if (href) images = [href];
      else q = 'medium';
    }
    if (q === 'medium') {
      const src = crawl.$('#image').attr('src');
      if (src) images = [src];
    }
    if (images?.length > 0) {
      const ext = images[0].split('.').pop()?.split('?')[0] || 'jpg';
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      await crawl.download_image(images[0], filename);
    }
    crawl.back();
  };

  const pageProgressIncrement = 90.0 / totalPages();

  for (let pg = start_page; pg <= end_page; pg++) {
    await crawl.to(`${base_url}/post/?page=${pg}`);
    const hrefs = crawl.$('#post-list-posts > li > div > a')
      .map((i, el) => $(el).attr('href'))
      .get()
      .filter(Boolean);
    for (let i = 0; i < (hrefs?.length ?? 0); i++) {
      await processDetailPage(hrefs[i]);
      await crawl.add_progress(pageProgressIncrement / (hrefs?.length ?? 1));
    }
    crawl.back();
  }
})();
```

注意：`crawl.$()` 返回 jQuery 对象，DOM 操作同源下为同步，无需 `await`。

## 10. Android 适配

- **主应用内加载**：爬虫作为主应用的路由/全屏视图，不新建窗口
- **代理**：纯 Rust 实现，随应用启动，无需 Python 或额外运行时
- **同源**：父页面与 iframe 均来自代理，逻辑与桌面一致

## 11. CLI

- CLI 本质不运行插件，仅请求 main 程序执行任务，不涉及爬虫架构，无需单独考虑

## 12. 迁移步骤

从当前 Rhai + reqwest + scraper 架构迁移到 JS + WebView + 代理，可按以下步骤执行。

### 12.1 Rust 后端：代理服务器

| 步骤 | 内容 |
|------|------|
| 1.1 | 在 `Cargo.toml` 中添加 `axum` 依赖 |
| 1.2 | 新建 `src-tauri/core/src/crawler/proxy.rs`（或等价模块），实现 axum 代理服务器 |
| 1.3 | 代理启动时 `axum::serve` 绑定 `127.0.0.1:0`，获取随机端口 |
| 1.4 | 实现 `headers_for_current_task()`：从当前任务的 user_headers + config.json baseUrl 合成请求头 |
| 1.5 | 实现 `/proxy?url=xxx`：用 reqwest 流式 fetch 目标 URL，附加 headers 后流式返回 |
| 1.6 | 实现 `/crawler`：返回爬虫运行时页面（iframe 容器 + crawl API + jQuery） |
| 1.7 | 实现 `/plugin/html?path=xxx`：无 baseUrl 的插件可选 HTML，从插件包内载入并返回；无则 404 |
| 1.8 | 为每个任务维护独立 `reqwest::Client`，启用 `cookie_store(true)` |

### 12.2 Rust 后端：任务调度

| 步骤 | 内容 |
|------|------|
| 2.1 | 将任务调度从「多 worker 并发」改为「单任务独占」：同一时刻只允许一个爬虫任务运行 |
| 2.2 | 实现 `crawl_prepare_download` 命令：按 Settings `max_concurrent_downloads`、`set_interval` 做门控；支持 destination 则登记 `url→path` 返回 `{useBrowser:true}`，不支持则用 reqwest 下载后返回 `{useBrowser:false}` |
| 2.3 | 实现 `crawl_add_progress`、`crawl_set_task_interval` 等 Tauri 命令 |
| 2.4 | 任务取消时：清空等待队列，reject 正在等待的 `prepare_download` |
| 2.5 | 移除 `set_concurrency` 相关逻辑 |

### 12.3 Tauri：WebView 与下载

| 步骤 | 内容 |
|------|------|
| 3.1 | 爬虫模式使用 WebView 加载 `http://127.0.0.1:{port}/crawler`，无需系统代理 |
| 3.2 | 若平台支持：配置 `download_started_handler`，根据 `url→path` 映射设置 `destination` |
| 3.3 | 若平台不支持 destination：`crawl_prepare_download` 内部用 reqwest 下载，JS 不执行 `<a click>` |

### 12.4 前端：爬虫运行时页面

| 步骤 | 内容 |
|------|------|
| 4.1 | 新建 `/crawler` 页面（或路由），包含 iframe 容器 + crawl 对象 + jQuery |
| 4.2 | 实现 `crawler-runtime.js`：`crawl.to`、`crawl.back`、`crawl.currentUrl`、`crawl.$`、`crawl.resolve_url`、`crawl.download_image`、`crawl.add_progress`、`crawl.set_interval` |
| 4.3 | 启动任务时加载 `http://127.0.0.1:{port}/crawler`，注入 `taskId`、`pluginId`、`proxyBase` |
| 4.4 | 有 baseUrl 的插件：iframe 初始加载 baseUrl 页面；无 baseUrl 的插件：可选 HTML 或由脚本自行 `crawl.to(url)` |

### 12.5 插件格式

| 步骤 | 内容 |
|------|------|
| 5.1 | 爬虫脚本由 `crawl.rhai` 改为 `crawl.js`，仅支持 JS，不再支持 Rhai |
| 5.2 | 扩展 KGPG/PLUGIN_FORMAT：支持 `crawl.js`；无 baseUrl 的插件可选 `html/` 目录 |
| 5.3 | 将现有 `crawl.rhai`（如 konachan）改写为 JS 示例 |
| 5.4 | 实现插件变量注入：config.json 的 `var` 以 `window.crawl.vars` 或等效方式供 JS 使用 |
| 5.5 | 更新 PLUGIN_FORMAT.md、README_PLUGIN_DEV.md |

### 12.6 启动与生命周期

| 步骤 | 内容 |
|------|------|
| 6.1 | 爬虫任务开始时：启动代理服务器（若未启动），加载 crawler 页面 |
| 6.2 | 任务结束/取消时：恢复状态，可关闭或复用代理服务器 |
| 6.3 | CLI：不运行插件，仅请求 main 程序执行，无需适配爬虫架构 |

### 12.7 潜在问题与验证

| 项目 | 说明 |
|------|------|
| proxy_url 平台支持 | 桌面端直接加载 `http://127.0.0.1:{port}`，无需 WebView 代理；Android 需验证 |
| 下载 destination | 需实测 wry `download_started_handler` 能否设置 destination |
| 相对链接 | 代理返回的 HTML 若含相对链接，可注入 `<base href="目标origin">` 保证解析正确 |
| 依赖清理 | 移除 Rhai 相关依赖与 `plugin/rhai.rs` 等，GUI 爬虫完全走 JS 路径 |

## 13. 相关文档

- [PLUGIN_FORMAT.md](./PLUGIN_FORMAT.md) - 插件格式（爬虫脚本为 `crawl.js`，仅支持 JS）
- [README_PLUGIN_DEV.md](./README_PLUGIN_DEV.md) - 插件开发指南
