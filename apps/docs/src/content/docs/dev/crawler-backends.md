---
title: 爬虫后端选择
description: 了解 Rhai 与 WebView 两种爬虫后端的差异，以及如何为你的插件做正确选型。
---

Kabegame 的爬虫插件有两种运行后端。作为插件作者，你不需要在 manifest 里声明用哪一种，但需要知道它们各自的能力边界，才能判断目标站点该写哪个脚本、以及是否能在安卓上跑。

## 两种后端概览

| 后端 | 脚本文件 | 运行环境 | 桌面 | 安卓 |
|---|---|---|---|---|
| Rhai | `crawl.rhai` | 纯 HTTP + HTML 解析，无浏览器 | ✅ | ✅ |
| WebView | `crawl.js` | 真实浏览器上下文（隐藏窗口） | ✅ | ❌ |

两种脚本都放在 `.kgpg` 包根目录。详情见[插件格式](/dev/format/)。

:::note
插件包里可以**同时**提供 `crawl.rhai` 与 `crawl.js`。这是让同一个插件在桌面享用 WebView 能力、在安卓退回 Rhai 的唯一方式。
:::

## 何时用 Rhai 后端

Rhai 是默认首选。选它的场景：

- 目标站有清晰的 REST / JSON 接口，直接请求就能拿到数据。
- 列表页是服务端渲染的 HTML，用 CSS 选择器即可抽取。
- 反爬强度低，没有 JS 挑战，不依赖浏览器指纹。
- **你希望插件在安卓上也能工作**。

Rhai 脚本由 Rust 侧的阻塞线程执行，没有界面，启动开销小。API 清单见 [Rhai API 参考](/dev/rhai-api/)。

## 何时用 WebView 后端

把爬取任务交给真实浏览器环境的场景：

- 目标站是 SPA，数据靠 JS 渲染进 DOM，纯 HTTP 拿不到。
- 有 Cloudflare JS 挑战、浏览器指纹检测等反爬机制。
- 需要复用用户在浏览器里登录留下的 Cookie / Session。
- 依赖 `fetch` / `XMLHttpRequest` 在浏览器上下文里的同源优势。

WebView 后端会启动一个隐藏的爬虫窗口执行你的 `crawl.js`。**这是桌面专属能力**。

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

## 自动选择逻辑

运行时按以下规则选后端，**无需插件声明**：

1. **桌面**：如果 `.kgpg` 里存在 `crawl.js`，走 WebView 后端。
2. **桌面**：如果没有 `crawl.js`，退回 `crawl.rhai`。
3. **安卓**：永远只看 `crawl.rhai`，即使插件包里带了 `crawl.js` 也会被忽略。

换句话说：**想让插件全平台可用，必须提供 `crawl.rhai`**。只提供 `crawl.js` 的插件在安卓上无法执行任务，会报「没有提供 crawl.rhai 脚本文件」。

:::caution
前端插件列表里显示的脚本类型在同时存在 `crawl.rhai` 与 `crawl.js` 时会固定标成 `"js"`。不要据此判断「没有 Rhai 回退」—— 以 `.kgpg` 里实际打包了哪些文件为准。
:::

## Android 限制

WebView 后端在安卓构建里**整段被编译剔除**，不是运行时禁用：

- 爬虫窗口的创建代码、WebView handler 的注册代码、scheduler 里加载 `crawl.js` 的分支，都包在 `#[cfg(not(target_os = "android"))]` 条件编译里。
- `crawler-capability` 在生成 `tauri.conf.json` 时也会在安卓构建中被排除。

结果是：安卓版本根本不具备执行 WebView 爬虫的能力，没有任何运行时开关能打开它。插件要想覆盖安卓用户，唯一做法就是写 `crawl.rhai`。

更多安卓侧的使用差异见[Android 指南](/guide/android/)。

## Cookie 与登录态

两种后端处理登录态的方式完全不同：

- **WebView 后端**：使用浏览器原生 Cookie Store。用户在爬虫窗口里登录后，Cookie 持久化，下次任务自动携带。适合需要长期登录态的站点。
- **Rhai 后端**：脚本需要自行通过 `set_header("Cookie", ...)` 等方式维护。没有浏览器 Cookie 容器，也不能复用桌面浏览器的登录态。

如果你的目标站要求登录且验证流程复杂，WebView 几乎是唯一选择。

## 性能与资源

| 维度 | Rhai | WebView |
|---|---|---|
| 启动开销 | 极低（阻塞线程直接跑） | 需创建隐藏窗口、加载目标页 |
| 内存占用 | 小 | 一个完整的 WebView 进程 |
| 渲染 JS | 不渲染 | 完整浏览器渲染 |
| 适合场景 | 高频、轻量接口采集 | 少量、必需浏览器上下文 |

:::tip
爬虫窗口默认隐藏。如果想观察脚本运行（调试用），打开设置「启动爬虫任务时自动显示爬虫窗口」即可。
:::

## 速查：我该选哪个

- 能写成 HTTP 请求 + 选择器 → **Rhai**
- 需要安卓可用 → **必须有 Rhai**
- 强 JS 渲染 / 反爬 / 需登录 Cookie → **WebView（仅桌面）**
- 想同时覆盖桌面高级场景 + 安卓基础场景 → **两个脚本都写**

## 延伸阅读

- [插件开发概览](/dev/overview/)
- [Rhai API 参考](/dev/rhai-api/)
- [插件格式](/dev/format/)
- [Android 指南](/guide/android/)
