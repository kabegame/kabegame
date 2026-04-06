# 爬虫后端双选设计：Rhai 与 WebView

本文档描述插件层级的**后端选择**：同一套插件格式下，**脚本无需声明后端**；运行时根据是否提供 JS 脚本与当前平台自动选择 **Rhai 后端**或 **WebView 后端**，并初步总结 WebView 后端的实现要点与平台约束。

## 1. 设计目标

- **无需声明后端**：插件不在元数据或配置中声明 `backend`，由运行时自动选择。
- **桌面端**：若插件提供了 **crawl.js**，则优先使用 **WebView 后端**；否则使用 **Rhai 后端**（crawl.rhai）。
- **安卓**：**仅支持 Rhai 后端**；即使存在 crawl.js，也使用 crawl.rhai，以保证后台/无界面稳定爬取。
- **Rhai 后端**：现有实现，HTTP + Rhai 脚本 + scraper，无界面、可后台跑；适合接口清晰、反爬不重的站点。
- **WebView 后端**：真实浏览器环境，支持 JS 渲染、同源 DOM、Cookie；适合 SPA、强反爬或需登录态的站点；**仅桌面**，可隐藏窗口；安卓上不选用。
## 2. 脚本约定与后端选择

- **脚本约定**：
  - Rhai 后端使用 `crawl.rhai`。
  - WebView 后端使用 `crawl.js`（或与现有 WebView 设计中的命名一致）。
- **后端选择规则**：
  - **安卓**：仅支持 Rhai，始终使用 `crawl.rhai`。
  - **桌面**：若存在 `crawl.js` 则优先使用 WebView 后端（crawl.js）；否则使用 Rhai 后端（crawl.rhai）。插件可同时提供两者以兼容不同平台或降级。

## 3. WebView 后端实现要点（初步总结）

### 3.1 整体思路

- **桌面**：创建（可隐藏的）WebView 窗口，加载目标 URL 或本地代理提供的爬虫页；通过**脚本注入**在页面上下文中执行爬虫逻辑，结果经 **Tauri invoke 或自定义协议** 回传 Rust。
- **安卓**：无“隐藏窗口”等价物，WebView 在应用前台时可用；进入后台后会被暂停，不宜作为长期后台爬虫。WebView 后端在安卓上不支持，只支持rhai后端。

### 3.2 脚本注入

- 可用 Tauri 的 `initialization_script` 在文档早期注入**bootstrap/运行时壳层**；或页面加载完成后用 `window.eval()` 注入业务脚本。
- 建议区分两层：
  - **bootstrap 层**：体积尽量小，负责挂载 `window.crawl`、与 Rust 握手、获取当前任务上下文、决定何时执行插件脚本。
  - **插件脚本层（crawl.js）**：负责当前页面的抓取逻辑，不承担跨页面持久化状态。
- 注入脚本与页面同源，可访问 DOM、Cookie；通过 `invoke()` 或自定义 URL scheme 将结果发回 Rust。

### 3.3 顶层 WebView 导航模式：生命周期与恢复

当目标站点存在 `X-Frame-Options`、CSP `frame-ancestors`、Cloudflare 挑战页等情况时，基于代理的 iframe 模式可能不适用。因此采用**顶层 WebView 直接加载目标页**的模式：

- WebView 顶层直接导航到远程 URL，不再依赖 iframe 嵌入。
- 一旦发生**整页导航**，当前 document 的 JS 上下文会被销毁；此前通过 `window.eval()` 注入的脚本、`window.crawl` 上的临时状态、定时器与闭包都会结束。
- 因此，**不要**把任务连续性寄托在某次注入后的 JS 内存上；跨页面状态必须由 Rust 持久化。

推荐模型：

1. **每个新文档都自动注入 bootstrap**  
   - 使用 `initialization_script` 在每次页面创建时重新挂载最小运行时。
   - bootstrap 只做初始化，不直接持有长期任务状态。

2. **Rust 持久化任务上下文**  
   - Rust 保存任务级状态，而不是让 JS 自行猜测“我从哪里来、下一步去哪”。
   - JS 页面重建后，通过桥接接口向 Rust 请求当前上下文，再恢复执行。

3. **统一一份 crawl.js，多分支执行**  
   - 插件只维护一份 `crawl.js`。
   - 脚本根据 Rust 返回的上下文判断当前应执行的逻辑分支，例如首页、列表页、详情页、下载页等。
   - 当前页面执行完后，结果与下一步意图回传 Rust；若需要导航，由 Rust 记录目标上下文后再发起跳转。

建议的上下文字段：

- `windowLabel`：Tauri/WebView 实例标识，如 `crawler-{taskId}`；用于定位当前窗口与 capability 绑定，不承担业务语义。
- `pageLabel`：当前页面/步骤语义标识，如 `home`、`list`、`detail`、`download`。
- `pageState`：当前步骤附带参数，如 `{ postId, page, keyword }`。
- `state`：整个任务上下文状态，由脚本通过 `updateState` 持久化，与 `pageState` 类似可立即反映到 JS 内存（`ctx.state` 获取）。
- `currentUrl`：当前实际 URL，用于辅助校验当前所处页面。
- `resumeMode`：恢复原因，如 `initial`、`after_navigation`、`after_redirect`、`retry`。

其中：

- **业务分支判断应优先依赖 `pageLabel + pageState`**；
- `currentUrl` 与页面 DOM 特征仅作为辅助校验，不应作为唯一依据；
- `windowLabel` 只用于实例识别，不应直接表示“当前处于哪个业务页面”。

推荐的导航/恢复流程：

1. 插件脚本调用 `crawl.to(...)`，声明“目标 URL + 下一步页面语义”。
2. Rust 先保存 `pending` 上下文，再让 WebView 导航。
3. 新页面创建后，`initialization_script` 重新注入 bootstrap。
4. bootstrap 调用 Rust 接口，获取当前 `pageLabel/pageState/currentUrl` 等上下文。
5. 统一的 `crawl.js` 根据上下文执行对应逻辑。

接口设计上，建议 `to()` 不只传 URL，而是传完整上下文，例如：

```typescript
await crawl.to({
  url: nextUrl,
  pageLabel: "detail",
  pageState: { postId: "12345" },
});
```

而不只是：

```typescript
await crawl.to(nextUrl, "detail");
```

因为仅有 `label` 往往不足以表达“这是哪一个详情页/第几页/携带什么任务参数”。

### 3.4 桌面：隐藏窗口

- 爬虫任务可在**隐藏**的 WebView 窗口中运行：窗口最小化或隐藏到托盘，进程与 WebView 继续运行，适合后台抓取。
- 实现时需保证：隐藏的窗口仍能完成导航、注入、下载与结果回传。

### 3.5 防止插件绕过 crawl API 使用 Tauri 接口

为避免插件作者在 crawl.js 中直接使用 `invoke()` 等 Tauri 接口、绕过受控的 `window.crawl` 访问敏感能力，可采用以下方式（建议**同时使用**，纵深防护）：

1. **爬虫窗口使用独立 capability（最小权限）**  
   - 为爬虫 WebView 使用**固定或可识别的窗口 label**（如 `crawler`，或与任务绑定的 `crawler-{taskId}`），并**不**将其加入主窗口的 capability（如 `main-capability`）。  
   - 新建**仅用于爬虫窗口**的 capability 文件（如 `capabilities/crawler.json`），在 `windows` 中只匹配该 label（或 `crawler*` 等模式）。  
   - 该 capability 的 `permissions` **仅**包含爬虫相关权限，例如：
     - 仅允许与 crawl 相关的 Tauri 命令：如 `crawl_add_progress`、`crawl_set_task_interval`、`crawl_prepare_download`、`crawl_prepare_download_archive`（若实现）、以及代理/任务上下文所需的 set_header/del_header 对应命令等。  
     - **不**包含 `core:default`、`shell:*`、`fs:*`、`dialog:*` 等主应用权限。  
   - 这样即使插件脚本内调用了 `invoke("open_explorer", ...)` 或其它未授权命令，Tauri 的 capability 检查会直接拒绝，命令不会执行。

2. **爬虫页面不暴露全局 invoke**  
   - 爬虫运行时页面（如从代理 `/crawler` 加载的页面）**不要**在全局作用域暴露 `@tauri-apps/api` 的 `invoke`。  
   - 仅打包并暴露 `window.crawl`，由 crawl 对象**内部**对需要的命令做 `invoke`（或使用封装好的小模块，不挂到 `window`）。  
   - 若爬虫页面与主应用共用同一 bundle，则通过构建或运行时条件，在“爬虫上下文”下不注入 `invoke`，或仅注入一个只允许调用白名单命令的包装函数（例如只接受命令名在白名单内才转发到真实 invoke）。

3. **（可选）远程/不可信内容与爬虫上下文隔离**  
   - 若 crawl.js 或目标页来自插件包/远程，尽量让**执行 crawl 逻辑**的脚本运行在“仅加载代理/crawler 页”的 WebView 中，且该 WebView 只加载受控的本地或代理 URL（如 `http://127.0.0.1:{port}/crawler`），不直接加载任意远程站点的脚本作为主文档。  
   - 通过 iframe 加载目标站（经代理同源），crawl 脚本在主文档中操作 iframe，这样即使目标站有恶意脚本，也跑在 iframe 内，无法直接拿到主文档上的 `window.crawl` 或 Tauri 绑定（除非同源且我们主动暴露）。

**实现检查清单**：  
- [ ] 新建 `crawler` 用 capability，`windows` 仅匹配爬虫窗口 label；  
- [ ] 该 capability 的 permissions 仅列出 crawl_* 及必要的 set_header/del_header 等命令权限，不包含 shell/fs/dialog 等；  
- [ ] 爬虫页面脚本不向全局暴露 `invoke`，仅暴露 `window.crawl`；  
- [ ] 在 tauri.conf 或构建中确保爬虫窗口应用的是 crawler capability（例如通过 capabilities 数组引用该 capability 文件，且爬虫窗口 label 与文件中 `windows` 匹配）。
- [ ] 若采用顶层 WebView 导航模式，使用 `initialization_script` 在**每个新 document** 注入 bootstrap，而不是只在首次打开窗口时注入一次。
- [ ] Rust 维护任务级 `current/pending` 页面上下文，避免把跨页面状态仅保存在 JS 内存中。

## 4. 平台与后端选型建议

| 能力 / 场景           | Rhai 后端     | WebView 后端（桌面）   |
|----------------------|---------------|------------------------|
| 无界面 / 后台常驻     | ✅ 适用       | ✅ 可隐藏窗口          | 
| SPA / 强 JS 渲染     | ❌ 不适合     | ✅ 适用                |
| 需登录态 / Cookie    | 需自行维护    | ✅ 浏览器环境          |
| 脚本注入             | 无（服务端）  | ✅ 初始/后续注入       | 
| Rust ↔ 脚本通信      | 非注入场景    | invoke 或自定义 scheme | 

## 5. 与现有文档的关系

- **本文档**：定义“不声明后端、提供 JS 则桌面优先用 WebView、安卓仅 Rhai”的规则，并总结 WebView 后端的实现要点与桌面/安卓差异。
- **CRAWLER_WEBVIEW_DESIGN.md**：描述基于 WebView + 本地 Rust 透明代理的**详细架构**（同源 iframe、crawl API、代理路由、下载门控等），可作为 WebView 后端的桌面实现蓝本；其中“仅支持 JS、不再支持 Rhai”在**双后端设计**下应理解为“WebView 后端仅使用 JS 脚本”，与“桌面优先 JS、安卓仅 Rhai”并存。
- **PLUGIN_FORMAT.md**：后续可扩展为支持 `crawl.js` 与 `crawl.rhai` 的并存及上述选择规则，无需 `backend` 字段。

## 6. Rhai API 与对等 JS API

为实现“同一插件可提供 crawl.rhai 与 crawl.js、桌面优先 JS”的脚本可移植性，WebView 后端的 **crawl** 对象需提供与现有 Rhai 爬虫 API 对等的 JS 接口。以下列出当前 Rhai 侧已暴露的 API（参见 `src-tauri/core/src/plugin/rhai.rs` 中 `register_crawler_functions`），以及需要在 WebView 运行时实现的 **对等 JS API**；实现细节与代理/下载门控等见 [CRAWLER_WEBVIEW_DESIGN.md](./CRAWLER_WEBVIEW_DESIGN.md)。

### 6.1 现有 Rhai API 一览

| Rhai 函数 / 行为 | 签名/说明 |
|------------------|-----------|
| **导航与页面栈** | |
| `to(url)` | 访问 URL（支持相对路径），将 (url, html, 响应头) 入栈；使用当前任务 HTTP 头，带重试。 |
| `fetch_json(url)` | 请求 URL 得到 JSON，返回 Rhai Map（对象）或 `{ data: array }`（数组）；不入页面栈。 |
| `back()` | 栈顶出栈，相当于返回上一页。 |
| `current_url()` | 返回当前栈顶 URL。 |
| `current_html()` | 返回当前栈顶 HTML 字符串。 |
| `current_headers()` | 返回当前栈顶页面对应的最后一次 HTTP 响应头（`Map`，键为小写）。 |
| `md5(text)` | 返回 UTF-8 字符串的 MD5（小写 hex）。 |
| **DOM / 选择器** | |
| `query(selector)` | 在当前页用 CSS 或 XPath（以 `/`、`//` 开头）查询，返回**文本**数组。 |
| `query_by_text(text)` | 查找包含指定文本的元素，返回 `{ text, tag, attrs, id?, class? }` 数组。 |
| `find_by_text(text, tag)` | 在指定标签内查找包含文本的元素，返回文本数组。 |
| `get_attr(selector, attr)` | 按选择器取属性 `attr`，返回属性值数组。 |
| **URL 与工具** | |
| `resolve_url(relative)` | 基于当前栈顶 URL 解析相对路径为绝对 URL。 |
| `is_image_url(url)` | 判断 URL 是否为支持的图片扩展名（与 core/image_type 一致）。 |
| `re_is_match(pattern, text)` | 正则匹配（Rust regex 语法），失败或编译失败返回 false。 |
| `re_replace_all(pattern, replacement, text)` | 全局正则替换，返回新字符串；`pattern` 非法时返回原文 `text`；`replacement` 支持 `$0`/`$1` 等。 |
| **HTTP 头** | |
| `set_header(key, value)` | 为当前任务设置请求头（后续 to/fetch_json/download 等会携带）。 |
| `del_header(key)` | 删除已设置的请求头。 |
| **进度与下载** | |
| `add_progress(percentage)` | 累加任务进度（%，0–99.9），并上报前端。 |
| `download_image(url)` | 下载图片到任务目录并加入画廊（并发/间隔由下载队列与设置控制）。 |
| `download_archive(url, archive_type)` | 下载压缩包并导入（如 zip）；archive_type 为字符串或空。 |
| `get_supported_archive_types()` | 返回支持的压缩类型列表（如 `["zip", "rar"]`）。 |
| **本地文件（桌面）** | |
| `list_local_files(folder_url, extensions, recursive)` | 列出本地目录下指定扩展名的文件；folder_url 为 file://；recursive 是否递归。 |

**Rhai 脚本作用域注入**：插件 `config.json` 的 `baseUrl` 注入为 `base_url`；任务变量（如 `start_page`、`end_page`、`quality` 等）通过 `merged_config` 注入为常量，脚本直接使用变量名。

### 6.2 需要实现的 JS 对等 API（window.crawl）

WebView 运行时（如 `crawler-runtime.js`）应暴露 `window.crawl`，与 Rhai 语义对齐，便于同一逻辑在 Rhai/JS 间迁移。代理、同源 iframe、下载门控等机制见 CRAWLER_WEBVIEW_DESIGN.md。

| Rhai API | JS 对等 API | 说明 |
|----------|-------------|------|
| `to(url)` | `crawl.to(url)` 或 `crawl.to({ url, pageLabel, pageState })` | 顶层 WebView 导航到新的url，建议同时传入下一步页面语义与参数，便于 Rust 在导航后恢复执行。 |
| `fetch_json(url)` | `crawl.fetch_json(url)` | 不返回 |
| `back()` | `crawl.back()` | 页面栈出栈，显示上一帧。 |
| `current_url()` | `crawl.currentUrl()` | 返回当前栈顶 URL 字符串。 |
| `current_html()` | — | JS 下“当前页”的 document；可用 `crawl.$(selector)` 操作。若需原始 HTML，可提供 `crawl.currentHtml()` 返回 `document.documentElement.outerHTML`（当前 iframe）。 |
| `query(selector)` | `crawl.query(selector)` 或 `crawl.$(selector)` | Rhai 的 `query` 返回文本数组；JS 可用 `crawl.$(selector)` 得到 jQuery 对象，再 `.map(() => $(this).text()).get()`。为兼容可额外提供 `crawl.query(selector)` 返回文本数组。 |
| `query_by_text(text)` | `crawl.queryByText(text)` | 返回包含该文本的元素信息数组，元素结构 `{ text, tag, attrs, id?, class? }`（与 Rhai 一致）；实现可用 `crawl.$("*").filter(...)` 或等价 DOM 遍历。 |
| `find_by_text(text, tag)` | `crawl.findByText(text, tag)` | 在指定标签内找包含文本的元素，返回文本数组。 |
| `get_attr(selector, attr)` | `crawl.getAttr(selector, attr)` | 返回属性值数组；实现可用 `crawl.$(selector).map((i, el) => $(el).attr(attr)).get()`。 |
| `resolve_url(relative)` | `crawl.resolve_url(relative)` | 基于 `currentUrl()` 解析相对 URL（如 `new URL(relative, base).href`）。 |
| `is_image_url(url)` | `crawl.is_image_url(url)` | 与后端/前端一致：根据 URL 扩展名判断是否图片；可 invoke 后端或前端实现。 |
| `re_is_match(pattern, text)` | `crawl.re_is_match(pattern, text)` 或脚本内 `new RegExp(pattern).test(text)` | 可选：提供与 Rhai 一致的正则 API，或由脚本自行用 RegExp。 |
| `re_replace_all(pattern, replacement, text)` | `crawl.re_replace_all(...)` 或脚本内 `text.replace(new RegExp(pattern, "g"), replacement)` | 可选：与 Rhai 语义对齐；注意 JS 与 Rust regex 语法差异。 |
| `set_header` / `del_header` | `crawl.set_header(key, value)` / `crawl.del_header(key)` | 设置/删除当前任务的 HTTP 头；代理请求时由 Rust 侧按任务合并这些头（见 CRAWLER_WEBVIEW_DESIGN 5.2）。需通过 invoke 写入任务上下文。 |
| `add_progress(percentage)` | `crawl.add_progress(pct)` | 累加进度并上报；invoke `crawl_add_progress`。 |
| `download_image(url)` | `crawl.download_image(url, filename)` | 门控由 Rust `crawl_prepare_download` 负责；若返回 useBrowser 则用 `<a download>` 经代理触发，否则 Rust 直接下载。见 CRAWLER_WEBVIEW_DESIGN 6.2。 |
| `download_archive(url, type)` | `crawl.download_archive(url, archiveType)` | 需新增 Tauri 命令（如 `crawl_prepare_download_archive`），门控与路径逻辑与 Rhai 侧一致；JS 仅 invoke。 |
| `get_supported_archive_types()` | `crawl.get_supported_archive_types()` | 返回支持的压缩类型数组；可 invoke 后端或使用前端已有列表。 |
| `list_local_files(...)` | `crawl.list_local_files(folder_url, extensions, recursive)` | 桌面专用；WebView 环境通常不访问本地 file://，可选实现或返回空数组并注明仅 Rhai/桌面。 |


除此之外，需要额外提供 exit 方法来结束脚本，否则将会有空转的浏览器页面。在js脚本代码的switch分支中，default 分支默认退出，因为不知道做什么事情了。当然这是最佳实践，不是强制。

**变量注入**：与 Rhai 一致，将 config 的 `baseUrl` 与任务变量注入到 `window.crawl.vars`（或 `window.crawl` 上只读属性），例如 `crawl.vars.base_url`、`crawl.vars.start_page`，供 crawl.js 直接使用。

**页面上下文**：若采用顶层 WebView 导航模式，建议额外提供只读上下文接口，例如：

- `crawl.currentContext()`：返回 `{ windowLabel, pageLabel, pageState, state, currentUrl, resumeMode, vars }`
- `crawl.updateState(patch)`：更新整个任务上下文状态（plain object 合并），同步到 Rust 并立即反映到 `ctx.state`，与 `updatePageState` 同理。
- `crawl.currentPageLabel()`：返回当前步骤语义
- `crawl.currentWindowLabel()`：返回当前 WebView 实例标识

这样统一的 `crawl.js` 可根据上下文选择执行分支，而不必依赖上一页残留的 JS 内存状态。

### 6.3 小结

- **Rhai**：上述 API 已在 `plugin/rhai.rs` 中实现，供 crawl.rhai 使用。
- **JS**：在 WebView 后端实现与 6.2 对应的 `window.crawl`，并配合 CRAWLER_WEBVIEW_DESIGN 中的代理、iframe、下载门控与 Tauri 命令（如 `crawl_add_progress`、`crawl_set_task_interval`、`crawl_prepare_download` 等），即可达到与 Rhai 后端对等的脚本能力，便于同一插件在桌面用 crawl.js、在安卓用 crawl.rhai 时保持语义一致。

## 7. 小结

- **脚本不声明后端**：由运行时按“有 JS 则桌面优先 WebView，安卓仅 Rhai”自动选择。
- WebView 后端：仅桌面，支持隐藏窗口与脚本注入，适合 SPA/反爬；安卓不选用 WebView，仅使用 Rhai。
- Rhai 后端：桌面在无 crawl.js 时使用，安卓始终使用；用于后台、无界面及安卓上的稳定爬取。两种后端可长期并存，由“是否提供 crawl.js + 平台”自动选型。
- **API 对等**：WebView 的 `window.crawl` 需实现 6.2 所列 JS API，与现有 Rhai API（6.1）一一对应，便于脚本双写或迁移。
