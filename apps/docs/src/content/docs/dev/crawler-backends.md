---
title: 爬虫后端选择
description: 了解 Rhai、V8 与 WebView 爬虫后端的差异，以及如何为你的插件做正确选型。
---

Kabegame 的 v3 爬虫插件通过 `package.json` 里的 `kbBackend` 显式声明运行后端。作为插件作者，你需要知道它们各自的能力边界，才能判断目标站点该写哪个脚本、以及是否能在安卓上跑。

## 后端概览

| 后端 | 脚本文件 | 运行环境 | 桌面 | 安卓 |
|---|---|---|---|---|
| Rhai | `crawl.rhai` | 纯 HTTP + HTML 解析，无浏览器 | ✅ | ✅ |
| V8 | `crawl.js` | 嵌入式 JS 引擎 + 宿主 HTTP/下载 API，无 DOM | ✅ | ❌ |
| WebView | `crawl.js` | 真实浏览器上下文（隐藏窗口） | ✅ | ❌ |

脚本放在 `.kgpg` 包内，并由 `package.json` 的 `main` 与 `kbBackend` 指定。详情见[插件格式](/dev/format/)。

:::note
v3 插件是单后端模型：`main` 指向哪个脚本，运行时就只装载该脚本。不要依赖“同时放 `crawl.rhai` 与 `crawl.js` 后自动选择”的旧 v2 行为。
:::

## 何时用 Rhai 后端

Rhai 是默认首选。选它的场景：

- 目标站有清晰的 REST / JSON 接口，直接请求就能拿到数据。
- 列表页是服务端渲染的 HTML，用 CSS 选择器即可抽取。
- 反爬强度低，没有 JS 挑战，不依赖浏览器指纹。
- **你希望插件在安卓上也能工作**。

Rhai 脚本由 Rust 侧的阻塞线程执行，没有界面，启动开销小。API 清单见 [Rhai API 参考](/dev/rhai-api/)。

## 何时用 V8 后端

V8 是当前 JS 插件的默认选择。选它的场景：

- 目标站有 JSON/HTTP 接口，但签名、分页或数据整理逻辑用 JS 更合适。
- 需要自包含的 `crawl.js`，但不需要 DOM、浏览器 Cookie Store 或页面渲染。
- 希望避免把站点专用签名逻辑放进 Kabegame core/Rhai API。

V8 脚本必须导出 `async function crawl(common, custom)`。配置变量通过 `custom` 读取；宿主能力通过全局 `Kabegame.*` 提供，例如 `Kabegame.to(url)`、`Kabegame.downloadImage(url)`、`Kabegame.currentHtml()`、`Kabegame.currentDocument()`。

V8 运行时同时提供常用 Web 平台全局：`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`atob` / `btoa`、`crypto.subtle`、`fetch` / `Request` / `Response` / `Headers`、timer API，以及 `DOMParser`。旧的 `@kabegame/plugin-sdk/host` 与 `fetchJson` 已移除；请求 JSON 请使用：

```ts
const data = await (await fetch(url)).json();
```

`fetch` 会合并当前任务通过 `Kabegame.setHeader()` 设置的请求头，但不会像旧 `fetchJson` 那样按当前页面自动解析相对 URL。需要相对路径时请显式写 `new URL(relative, await Kabegame.currentUrl())`。

## 何时用 WebView 后端

把爬取任务交给真实浏览器环境的场景：

- 目标站是 SPA，数据靠 JS 渲染进 DOM，纯 HTTP 拿不到。
- 有 Cloudflare JS 挑战、浏览器指纹检测等反爬机制。
- 需要复用用户在浏览器里登录留下的 Cookie / Session。
- 依赖 `fetch` / `XMLHttpRequest` 在浏览器上下文里的同源优势。

WebView 后端会启动一个隐藏的爬虫窗口执行你的 `crawl.js`。**这是桌面专属能力**，且只在确实需要浏览器环境时使用。

### 跨页面状态管理

WebView 采用**顶层导航**模式：每次 `crawl.navigate(url)` 都会让整个爬虫窗口跳到新页面，原 JS 上下文随之销毁。所以：

- 不要依赖 `window.*` 上的全局变量跨页面保留状态。
- 用 `crawl.updateState(...)` 把需要保留的数据写回 Rust 侧。
- 下一个页面的 `crawl.js` 再次 handshake 时，会拿回这份状态。

### 安全边界

爬虫窗口的 capability 被刻意收得很紧，只开放 `core:event:*` 与 `core:window:allow-hide`。这意味着：

- 不要在 `crawl.js` 里尝试调用 `shell:open`、文件读写等 Tauri 命令 — 权限不在白名单内。
- 只使用 `window.crawl.*` 提供的桥接 API。
- 受限权限是系统级保护，不是遗漏，请勿通过 capability 改动绕过。

## 后端声明

v3 插件通过 `package.json` 显式声明后端：

```json
{
  "main": "crawl.js",
  "kbBackend": "v8"
}
```

可选值包括 `rhai`、`v8`、`webview`。JS 插件默认写 `v8`；只有需要浏览器窗口/DOM/Cookie 容器时才写 `webview`。**想让插件覆盖安卓，必须使用 Rhai 后端**。

:::caution
legacy v2 插件仍有旧的脚本探测兼容逻辑；新插件不要依赖它。
:::

## Android 限制

V8 与 WebView 后端在安卓构建里不可用；WebView 相关代码会被条件编译剔除：

- 爬虫窗口的创建代码、WebView handler 的注册代码、scheduler 里加载 `crawl.js` 的分支，都包在 `#[cfg(not(target_os = "android"))]` 条件编译里。
- `crawler-capability` 在生成 `tauri.conf.json` 时也会在安卓构建中被排除。

结果是：安卓版本根本不具备执行 JS 爬虫的能力，没有任何运行时开关能打开它。插件要想覆盖安卓用户，唯一做法就是写 `crawl.rhai`。

更多安卓侧的使用差异见[Android 指南](/guide/android/)。

## Cookie 与登录态

三种后端处理登录态的方式不同：

- **WebView 后端**：使用浏览器原生 Cookie Store。用户在爬虫窗口里登录后，Cookie 持久化，下次任务自动携带。适合需要长期登录态的站点。
- **V8 后端**：没有浏览器 Cookie 容器；脚本需要自行设置请求头。
- **Rhai 后端**：脚本需要自行通过 `set_header("Cookie", ...)` 等方式维护。没有浏览器 Cookie 容器，也不能复用桌面浏览器的登录态。

如果你的目标站要求登录且验证流程复杂，WebView 几乎是唯一选择。

## 性能与资源

| 维度 | Rhai | V8 | WebView |
|---|---|---|---|
| 启动开销 | 极低（阻塞线程直接跑） | 低 | 需创建隐藏窗口、加载目标页 |
| 内存占用 | 小 | 中 | 一个完整的 WebView 进程 |
| 渲染 JS | 不渲染 | 执行脚本但无 DOM | 完整浏览器渲染 |
| 适合场景 | 高频、轻量接口采集 | JS 签名/API 采集 | 少量、必需浏览器上下文 |

:::tip
爬虫窗口默认隐藏。如果想观察脚本运行（调试用），打开设置「启动爬虫任务时自动显示爬虫窗口」即可。
:::

## 速查：我该选哪个

- 能写成 HTTP 请求 + 选择器 → **Rhai**
- 需要安卓可用 → **必须有 Rhai**
- 需要 JS 签名/数据整理，但不需要浏览器 → **V8**
- 强 JS 渲染 / 反爬 / 需登录 Cookie → **WebView（仅桌面）**

## 延伸阅读

- [插件开发概览](/dev/overview/)
- [Rhai API 参考](/dev/rhai-api/)
- [插件格式](/dev/format/)
- [Android 指南](/guide/android/)
