# 网页收集来源 PRD

> 状态：需求评审稿（Draft）
>
> 范围：在画廊“开始收集”中新增独立的“网页”来源；本文只定义需求与实现边界，不代表已经开始开发。
>
> 内置任务 ID：`webpage`

## 总体设计思路

“网页”不是“网络”来源里的又一个可安装插件，而是一项随应用发布的通用单页媒体收集能力。
用户从“本地 / 网络 / 网页”三级入口选择“网页”后，进入独立表单；表单把页面 URL、采集后端、
输出位置一次性冻结为任务参数，再创建 `pluginId = "webpage"` 的内置插件任务。
任务沿用现有任务列表、任务详情、取消、失败图片、下载并发、去重、目标目录和目标画册机制，
不另建一套“网页下载记录”。

`webpage` 保持与 `local-import` 相同的 `builtin` 身份，但它有自己的 runner。runner 根据每次任务的
`backend` 参数分流：`host` 由 Rust 请求并解析服务端返回的 HTML；`webview` 由隐藏的浏览器窗口加载、
渲染和滚动页面，再执行内置插件携带的“当前页面资源发现 JS”。这里的 `host` 是“Rust 宿主直接采集”，
**不是**现有插件清单中的 `kbBackend = v8`；`webview` 才复用现有 CEF 爬虫窗口、Cookie/Referer 和任务
心跳能力。插件的 `scriptType` 与 `PluginScript.backend` 仍是 `builtin`，页面发现 JS 只是 builtin 的载荷，
不能因此把 `webpage` 伪装成普通 `js` 插件。

两条后端只负责“如何得到候选 URL”，后面的 URL 规范化、去重、下载入库和画册归属汇合到现有 Rust
下载链路。网页任务本身不再提供格式白名单/黑名单、最小文件大小或最小分辨率，也不在下载前丢弃
这些候选。后续会另立统一需求：媒体先按正常流程下载并写入图库，再由全局下载后规则把满足条件的
图片自动标为隐藏；该机制不属于 `webpage` runner，也不是本 PRD 的前置依赖。

Host 模式允许用户注入 HTTP Header，字段复用现有任务级 `httpHeaders`，并作用于入口页面请求和后续
媒体下载；选择 WebView 时不显示 Header 编辑器，也不向任务提交 Header。WebView 的身份信息完全来自
浏览器会话，避免形成“浏览器 Cookie + 人工 Header”两套互相覆盖的鉴权来源。

页面发现完成后，runner 为本页创建一份共享 metadata 快照：Host 冻结本次响应的 HTML，WebView 冻结
发现资源当时的最终 DOM HTML。该页下载成功的所有媒体共享这份 metadata，其中同时保存用户提交的
初始 URL。内置 `description_template` 把快照渲染为隔离的 H5 预览，并提供跳转到初始 URL 的按钮；
`images.post_url` 也始终写入该初始 URL，而不是重定向后的 URL。

关键决策：

- `webpage` 是一个内置插件 ID，而不是分别暴露 `webpage-host` / `webpage-webview`，因此任务筛选、
  图库来源和用户认知都保持单一；具体后端保存在任务的 `userConfig.backend`。
- “网络”继续表示“选择一个已安装的来源插件”；“网页”表示“不安装插件，直接从一个完整 URL 的
  单个页面收集媒体”。两者不可合并为同一表单。
- WebView 模式的下载传输必须由任务显式标为 `webview`，不能继续通过插件静态 `scriptType` 推断；
  否则 `builtin` 类型会误走 Rust 下载，丢失浏览器 Cookie、登录态和 Referer。
- `webpage` 携带的页面发现 JS 必须是不依赖任务调度器的“扫描当前文档并返回结果”能力。首期由网页
  WebView runner 使用；未来“冲浪”增加“一键爬取当前所有资源”按钮时直接复用同一份脚本，不复制
  DOM 识别规则。该冲浪按钮本身不在本 PRD 的实现范围内。
- `webpage` 与 `local-import` 的内置插件固定字段统一显式赋值。需求中的版本 `1.0` 按仓库当前
  `major.minor.patch` 契约写为字符串 `"1.0.0"`；不为两个内置插件放宽全局版本解析规则。
- 任务抽屉不能只用插件的 `scriptType === "js"` 判断是否显示“打开 WebView”。`TaskDrawer.vue` 必须
  同时识别 `pluginId === "webpage" && userConfig.backend === "webview"`，再把可见性结果传给通用任务
  列表组件；Host 网页任务没有 WebView 窗口，不显示按钮。
- 首期只收集输入 URL 对应的一个页面，不递归跟随普通网页链接、不爬整站、不做分页规则编辑器。

## 1. 产品目标

### 1.1 用户目标

用户无需开发或安装爬虫插件，即可粘贴一个完整网页 URL，从该页面批量收集发现的图片或视频，
并将结果保存到指定目录和/或画册。

### 1.2 成功标准

- 所有画廊“开始收集”入口一致出现“本地 / 网络 / 网页”。
- “网页”始终打开独立表单，不进入 `CrawlerDialog` 的插件选择流程。
- 提交后任务列表出现来源名为“网页收集”、`pluginId = "webpage"` 的内置任务。
- Host 与 WebView 后端使用同一份下载入库链路；后端差异只影响能否发现动态渲染媒体。
- Host 表单可以编辑 HTTP Header，WebView 表单不显示且不提交 HTTP Header。
- 成功入库的媒体正确使用任务目标目录、目标画册、任务 ID、来源插件 ID，并把用户输入的初始 URL
  同时冻结到 metadata 和 `images.post_url`。
- 图片详情通过 `webpage.description_template` 展示采集时页面 HTML，并可跳转到初始 URL。

### 1.3 非目标

- 不做整站递归、站点地图、翻页规则、CSS/XPath 自定义选择器。
- 不替代现有来源插件；需要站点登录流程、分页、详情页跳转或专用 metadata 的场景仍应开发插件。
- 首期不支持定时运行、保存为运行配置或推荐配置。
- `recommended_configs` 固定为空数组，不为网页收集生成推荐配置。
- 不在网页表单中提供允许/排除文件类型、最小文件大小或最小分辨率；这些条件属于后续统一的
  “下载入库后自动隐藏”需求，不能在网页 runner 中先行实现为丢弃。
- 不增加 Cookie 编辑器或网页专用代理设置；Host 继续使用应用现有代理配置并允许任务级 HTTP Header，
  WebView 只使用浏览器会话。
- 不在本期给“冲浪”增加“一键爬取当前所有资源”按钮；本期只保证页面发现 JS 可被该功能直接复用。
- 不支持 `file:`、`content:`、`data:`、`blob:`、`javascript:` 等作为入口 URL。

## 2. 名词与来源边界

| UI 名称 | 含义 | 任务 ID / 来源 |
| --- | --- | --- |
| 本地 | 从文件、目录或 Android MediaPicker 导入 | `local-import` |
| 网络 | 选择并运行已安装的爬虫插件 | 所选插件 ID |
| 网页 | 从用户给出的单个完整网页 URL 自动发现媒体 | 固定为 `webpage` |

“网页”表单中的后端命名：

| 值 | UI 文案 | 含义 |
| --- | --- | --- |
| `host` | 宿主（Rust，推荐） | Rust 发 HTTP 请求并解析静态 HTML；资源占用低、可后台运行，不执行页面 JavaScript |
| `webview` | WebView（浏览器渲染） | CEF 加载真实页面、执行 JavaScript、保留 Cookie，并从渲染后的 DOM 收集 |

## 3. 用户流程与交互

### 3.1 入口

桌面端工具栏下拉、画廊空状态的来源选择对话框、紧凑布局的 `CollectSourcePicker` 都按以下顺序展示：

1. 本地
2. 网络
3. 网页

点击“网页”后先关闭来源选择层，再打开 `WebpageCollectDialog`。不得先打开网络收集表单再预选某个
伪插件。

### 3.2 表单布局

桌面使用独立对话框；紧凑布局使用与现有收集表单一致的全宽抽屉。两种布局字段和校验完全一致，
Android 返回键必须接入统一模态栈。

建议分为三个区块：

1. **网页**：完整 URL、采集后端。
2. **保存到**：目标文件夹、目标画册。
3. **高级设置**：HTTP Header，仅选择 Host 时渲染。

底部按钮为“取消 / 开始收集”。提交中按钮进入 loading 并禁止重复提交；创建任务成功后关闭表单，
显示“网页收集任务已添加”，失败时保留用户输入并展示错误。

### 3.3 字段定义

| 字段 | 必填 | 默认值 | 规则 |
| --- | --- | --- | --- |
| 完整 URL | 是 | 空 | 去除首尾空白后必须是绝对 `http://` 或 `https://` URL；保留 path/query；拒绝带用户名/密码的 URL |
| 后端 | 是 | `host` | 桌面可选 `host` / `webview`；不支持的平台禁用 `webview` 并给出原因 |
| HTTP Header | 否 | 空 | 仅 `backend = host` 时显示；复用 `HttpHeadersEditor`，Header 名去除首尾空白，拒绝空名、冒号和 CR/LF，值拒绝 CR/LF |
| 目标文件夹 | 否 | 应用默认下载目录 | 桌面复用现有文件夹选择；Android 不展示，因为媒体由现有 MediaStore 路径入库 |
| 目标画册 | 否 | 不指定 | 复用 `AlbumPickerField`，支持选择已有画册或现场创建画册 |

表单不出现媒体过滤区块，也不把任何隐藏规则复制进 `userConfig`。未来的下载后隐藏设置应是全局
能力，对网页、来源插件及其它网络下载统一生效。

URL 与后端不是在 `WebpageCollectDialog` 中各写一套字段定义，而是读取 `webpage.config.vars` 渲染；
目标目录、目标画册和 `httpHeaders` 继续使用任务通用字段，不塞入插件 `userConfig`。切换到 WebView 后，
Header 编辑器立即隐藏；允许对话框在本次未关闭期间保留 Host Header 草稿，便于切回 Host，但提交
WebView 任务时必须强制传空 Header，不能把隐藏字段的旧值带入任务。

### 3.4 HTTP Header 注入语义

- Header 仅用于 `host`：入口 HTML 请求、重定向后的页面请求及该任务后续 Rust 媒体下载均使用同一份
  Header 快照，重试时不得回读已经变化的 UI 状态。
- Header 复用现有 `CrawlTask.httpHeaders` / `addTask(..., httpHeaders, ...)` 契约，不新增
  `userConfig.headers`，也不新增数据库列。
- 不允许覆盖由 HTTP 客户端维护的 hop-by-hop / framing Header（至少包含 `Host`、`Content-Length`、
  `Connection`）；后端必须再次校验 Header 名和值，不能只依赖前端。
- UI 提示该 Header 会用于页面发现及候选媒体下载，候选可能位于第三方域名；用户应避免向不可信页面
  注入长期有效的凭据。跨域重定向时对 `Authorization`、`Cookie` 等敏感 Header 的处理沿用现有 HTTP
  客户端安全策略，不为网页任务降低限制。
- `webview` 任务的 `httpHeaders` 必须是空对象或缺省；运行期间也不提供动态 Header 注入入口。

## 4. 页面发现范围

### 4.1 通用规则

- 如果入口 URL 最终响应本身是受支持媒体，直接把它作为唯一候选，不再按 HTML 解析。
- HTML 页以重定向后的最终页面 URL 和 `<base href>` 解析相对地址。
- 本文“初始 URL”均指用户提交时去除首尾空白并通过校验的绝对 URL；它在任何网络重定向发生前冻结。
- 候选 URL 去除 fragment，保留 query；规范化后按完整 URL 去重。
- 只接收最终解析为 `http://` / `https://` 的候选。
- 每个候选入库时：`images.url` 记录媒体 URL，`images.post_url` 记录用户提交的初始 URL，
  `plugin_id = "webpage"`，`task_id` 记录本次任务。

### 4.2 首期识别的 DOM 来源

- `img[src]`、`img[srcset]`
- `picture source[srcset]`
- 常见懒加载属性：`data-src`、`data-original`、`data-lazy-src`、`data-srcset`
- `video[src]`、`video[poster]`、`video source[src]`
- `meta[property="og:image"]`、`meta[property="og:video"]`、Twitter image/video 同类字段
- `a[href]`：仅当 href 的 URL 后缀已能确认是受支持媒体时加入，避免对页面所有链接发探测请求

同一个 `srcset` 选择描述符最大的候选（最大 `w` 或最大 `x`），不把缩略图的全部变体都下载。
首期不解析 CSS `background-image`，不穿透 iframe，不分析脚本字符串中的资源 URL。

### 4.3 Host 行为

- 使用应用现有代理感知、重试、超时与任务取消能力发起请求。
- 将任务创建时冻结的 `httpHeaders` 注入入口页面请求和候选媒体下载请求。
- 不执行页面 JavaScript，只解析响应 HTML。
- HTML 主文档非成功状态、重定向到非 HTTP(S)、正文无法读取时任务失败。
- 页面解析成功但没有候选时任务正常完成，成功数为 0，并写明“未发现媒体”。

### 4.4 WebView 行为

- 仅桌面启用，使用隐藏的现有 CEF 爬虫窗口；运行中可从任务抽屉/任务详情打开窗口。
- 任务抽屉的“打开 WebView”按钮只在任务状态为 `running` / `waiting_downloads`，且满足以下任一条件时显示：
  普通插件的 `scriptType === "js"`；或任务为 `webpage` 且 `userConfig.backend === "webview"`。
  `webpage + host`、缺失/非法 backend、pending 和所有终态都不显示。
- 使用浏览器的页面 Cookie、重定向、Referer 和动态 DOM。
- 页面 `DOMContentLoaded` 后增量滚动；文档高度连续 3 轮不再变化即停止，最多 30 次或 20 秒，
  防止无限瀑布流永不结束。取消任务立即停止滚动与扫描。
- 扫描最终 DOM 后把候选交回 Rust；下载继续使用该任务的 WebView transport，保留登录态。
- 不读取或注入任务 `httpHeaders`；WebView 请求只使用浏览器自身的 Cookie、缓存与网络栈状态。
- 页面挑战、登录或异常渲染时，用户可打开任务 WebView 手动处理；仍受现有 120 秒心跳看门狗约束。

### 4.5 页面发现 JS 的复用契约

- `webpage` 的 `PluginScript.backend` 固定为 `Builtin`，`source` 内含唯一一份页面发现 JS；为
  `PluginScript` 增加只读 `builtin_source()`（或等价内部接口）取得该载荷，不能让 `js_source()` 把
  builtin 冒充 WebView 插件。
- JS 只扫描调用时的当前 `document`，负责自动滚动/稳定检测、DOM 媒体提取和 HTML 快照，不负责创建
  Kabegame 任务、不直接写数据库、不依赖 `taskId`，也不自行下载媒体。
- JS 通过稳定的序列化结果返回 `{ candidates, pageHtml, documentUrl }`。`candidates` 是待规范化 URL；
  `pageHtml` 是扫描完成时的 `document.documentElement.outerHTML`；`documentUrl` 仅供相对地址解析和诊断，
  不能替代用户初始 URL 成为 `post_url`。
- WebView runner 负责向脚本注入取消/超时边界并接收结果，Rust 负责 URL 规范化、去重、metadata 创建、
  下载与入库。这样未来“冲浪”只需在当前浏览器页执行同一脚本，再把结果交给相同的 Rust 接收入口。
- 本期必须为脚本入口与返回 JSON 写契约测试；未来冲浪按钮不得 fork 或复制脚本源码。
- **已落地（先于本 PRD）**：畅游“一键下载”已实现页面发现脚本 `src-tauri/kabegame/src/webview_js/page_discover.js`
  （`discoverMedia({ imageExtensions, videoExtensions }) → { candidates: [{url, kind}], documentUrl }`，
  不挂 window，由 `concat!` 拼进封闭 IIFE）。webpage WebView runner 应以同样方式复用该文件，而不是另写一份；
  畅游的 HTML+CSS 快照（`page_snapshot.js`）也可复用为 WebView 后端的 `pageHtml` 来源。见
  `cocs/downloader-tasks/DOWNLOADER_FLOW.md`「畅游一键下载与页面快照」。

## 5. 下载与入库顺序

每个候选必须按固定顺序处理：

1. URL 规范化和任务内去重。
2. 页面发现完成后创建一次页面 metadata；同页所有候选复用同一个 `metadata_id`，避免为每张图片重复
   存储整份 HTML。
3. 按任务选择的 transport 发起下载：Host 使用现有 Rust HTTP 下载并携带任务 Header，WebView 使用
   浏览器下载通道且不注入任务 Header。
4. 下载参数统一携带共享 `metadata_id`，并把用户初始 URL 作为每个候选的 `post_url`。
5. 交给现有下载后处理完成媒体校验、缩略图/兼容副本生成、`images` 写入和存储去重。
6. 成功入库后按现有逻辑加入目标画册。

网页 runner 不增加允许/排除格式、文件大小或分辨率的提前淘汰。网络错误、HTTP 下载失败、内容损坏、
不受现有媒体管线支持或后处理失败时，完全沿用现有下载任务语义；本 PRD 不重新定义其成功/失败口径。

未来的统一隐藏功能发生在成功写入 `images` 之后：符合全局规则的图片仍是已下载、已入库的图片，
只是自动设置为隐藏。网页任务不保存该规则快照，也不负责计算或覆盖隐藏状态。

页面 metadata 的固定结构：

```ts
type WebpageMetadata = {
  schemaVersion: 1;
  sourceUrl: string;   // 用户提交的初始 URL；跳转按钮和 post_url 的唯一来源
  documentUrl: string; // 实际完成发现时的页面 URL，仅用于还原相对地址和诊断重定向
  pageHtml: string;    // Host 响应 HTML 或 WebView 最终 DOM outerHTML
  capturedAt: number;  // Unix 毫秒时间戳
  backend: "host" | "webview";
};
```

冻结的是 HTML 文本，不承诺把页面引用的 CSS、字体、脚本、图片等子资源一并离线归档。入口本身为媒体
而非 HTML 时，runner 生成一个只包含该媒体和来源信息的最小 H5 文档作为 `pageHtml`，保证模板仍有
稳定输入。

任务日志至少给出：发现候选数、URL 去重数、提交下载数、成功数、下载失败数和存储去重数。
任务参数面板通过内置插件的 `config.vars` 元数据展示本次输入，不在前端为 `webpage` 写名称特判。

## 6. 任务数据契约

前端提交形状：

```ts
await enqueueTask({
  pluginId: "webpage",
  outputDir: form.outputDir || undefined,
  outputAlbumId: selectedOutputAlbumId || undefined,
  userConfig: {
    url: form.url.trim(),
    backend: form.backend, // "host" | "webview"
  },
  httpHeaders: form.backend === "host" ? normalizedHttpHeaders : {},
  triggerSource: "manual",
});
```

后端必须再次校验全部字段，不能信任前端已经规范化。任务记录仍使用现有 `tasks.output_dir`、
`tasks.output_album_id` 和 `tasks.user_config`，不新增网页专用数据库表或列。

### 6.1 两个 builtin 的固定字段

`webpage` 与 `local-import` 都必须显式写死以下字段，不从安装包、远端清单或运行配置推导：

```rust
version: "1.0.0".to_string(), // 需求版本 1.0；当前 pack_plugin_version 强制 a.b.c
base_url: String::new(),
size_bytes: 0,
script_type: "builtin".to_string(),
min_app_version: None,
labels: vec![],
min_app_incompatible: false,
file_path: None,
doc: None,
changelog: None,
icon_png_base64: Some(BASE64_STANDARD.encode(BUILTIN_PLUGIN_ICON_PNG)),
recommended_configs: Vec::new(),
```

图标字节与当前 `local-import` 完全相同。实现时建议把 `LOCAL_IMPORT_ICON_PNG` 重命名为共享的
`BUILTIN_PLUGIN_ICON_PNG`，两个 builtin 引用同一常量，而不是复制第二份 PNG。`local-import` 当前版本
是 `0.0.0`，本需求会同步改为 `1.0.0`；这属于明确的数据变化，需要补序列化和版本 packed 回归。

### 6.2 `webpage` 的差异字段

内置插件元数据目标形状：

```rust
Plugin {
    id: "webpage".to_string(),                 // 新增：保留 ID
    name: json!({ "default": "Webpage", "zh": "网页收集", /* ... */ }),
    description: json!({ /* 从单个网页收集媒体 */ }),
    version: "1.0.0".to_string(),
    base_url: String::new(),
    size_bytes: 0,
    config: HashMap::from([("vars".to_string(), json!([
        {
            "key": "url",
            "type": "string",
            "name": { "default": "Full URL", "zh": "完整 URL", /* ... */ },
            // 无 default：必填；前后端另做绝对 HTTP(S) URL 校验
        },
        {
            "key": "backend",
            "type": "options",
            "default": "host",
            "name": { "default": "Backend", "zh": "后端", /* ... */ },
            "options": [
                { "name": { "default": "Host", "zh": "宿主（Rust）", /* ... */ }, "variable": "host" },
                { "name": { "default": "WebView", "zh": "WebView", /* ... */ }, "variable": "webview" }
            ]
        }
    ]))]), // 前端据此渲染表单及任务参数，不硬编码字段文案
    script_type: "builtin".to_string(),
    min_app_version: None,
    labels: vec![],
    min_app_incompatible: false,
    file_path: None,
    doc: None,
    changelog: None,
    icon_png_base64: Some(BASE64_STANDARD.encode(BUILTIN_PLUGIN_ICON_PNG)),
    description_template: Some(include_str!("webpage_description.ejs").to_string()),
    recommended_configs: Vec::new(),
    script: PluginScript::new(
        PluginBackend::Builtin,
        include_str!("webpage_discover.js").to_string(), // builtin 载荷：当前页面资源发现 JS
    ),
    /* var_defs/assets/providers/metadata_migration/version_packed 按内置插件约定显式赋值 */
}
```

`config.vars` 是网页表单字段与任务参数展示的唯一事实来源。首期包含 `url` 和 `backend`；目标目录、
目标画册、HTTP Header 是现有任务通用设置，不重复声明为插件变量。`recommended_configs` 始终为空。

`description_template` 是随 builtin 编译进应用的 EJS 字符串，不从 `.kgpg` 读取。模板只消费上述
`WebpageMetadata`：使用嵌套、受限的 `iframe srcdoc` 展示 `pageHtml`，并通过既有
`__bridge.openUrl(metadata.sourceUrl)`（或被全局链接桥接接管的 `<a data-url>`）提供“打开原网页”按钮。
捕获页面属于不可信输入，禁止把 `pageHtml` 直接插入拥有 `__bridge` 的外层模板 DOM；嵌套 iframe 不授予
脚本、表单、弹窗或顶层导航权限。HTML 值必须经安全序列化后赋给 `srcdoc`，避免 `</script>` / EJS
闭合逃逸。嵌套页面 CSP 允许图片、媒体、样式和字体资源以 `http(s)` / `data` 加载，以提升原页面还原度；
禁止脚本、`connect-src`、子 frame、object、表单与顶层导航，并设置 `referrerpolicy = no-referrer`。

`local-import` 保持自己的 `config`、`description_template: None` 和空脚本载荷，但同步采用 6.1 的固定
公共字段；`webpage` 则使用上面的配置、模板和页面发现 JS。

`webpage` 与 `local-import` 一样：由 `get_plugins` 追加给任务展示使用，但在来源管理、插件选择器和
商店中隐藏；同名 `.kgpg` 必须被保留 ID 校验拒绝。

## 7. 平台范围

| 平台 | Host | WebView | 目标文件夹 | 目标画册 |
| --- | --- | --- | --- | --- |
| Windows / macOS / Linux | 支持 | 支持（CEF） | 支持 | 支持 |
| Android | 支持 | 不支持，选项禁用并说明 | 不展示，沿用 MediaStore | 支持 |
| Web 发布版 | **待评审，建议首期隐藏入口** | 不支持 | 由服务端决定 | 支持 |

Web 发布版若直接开放 Host，会把“任意 URL”变成服务端 SSRF 能力，可能访问部署机器的回环地址、
内网服务或云 metadata。建议首期 `IS_WEB` 隐藏“网页”；若必须开放，需要先补 DNS 解析后私网/回环/
链路本地地址拦截、每次重定向复检、DNS rebinding 防护、响应体上限和速率限制。这不是纯前端开关。

本项目不支持 iOS，不设计 iOS 行为。

## 8. 状态、进度与失败语义

- `pending`：任务已创建、等待并发槽位。
- `running`：获取页面、渲染/滚动、发现候选和提交下载。
- `waiting_downloads`：候选已发现完，仍有媒体正在下载或后处理。
- `completed`：页面处理结束，允许成功数为 0；进度为 100%。
- `failed`：入口页面无法获取/解析、配置非法、WebView 无响应等任务级错误。
- `canceled`：用户取消；停止主页面请求、WebView、候选下载和后处理，不再创建新入库记录。

建议进度：页面阶段 0–10%，候选处理按完成数占 10–99.9%，全部下载排空后置 100%。WebView runner
与 Host runner 都必须经过现有 `wait_task_downloads_drained` 收尾。`local-import` 的媒体处理本身是同步
完成的，所以可以从内置分支直接 `return`；网页任务会向异步下载队列提交候选，不能照搬该结构，
否则会在下载尚未完成时提前变成 `completed`。

## 9. 隐私、分析与可观测性

- 埋点新增 `gallery_import_entry { entry: "webpage" }` 与
  `gallery_import_start { source: "webpage", backend, has_output_dir, output_album, ... }`。
- 埋点不得包含 URL、域名、允许/排除类型的具体值或页面内容；只允许布尔值和数量。
- 完整 URL 会保存在本地任务参数中用于复现；禁止把它写入远程分析事件。
- HTTP Header 值按凭据处理：只保存在现有本地任务记录中，不写任务日志、错误正文、分析事件或 issue
  反馈正文；分析最多上报 `has_http_headers` 与 `http_header_count`。
- 冻结 HTML 可能含页面正文或用户登录后的私有内容，只允许写入本地 metadata，不上传分析服务。
- 日志不得输出 URL 中的用户名/密码（入口已拒绝）；下载日志沿用现有 URL 记录规则。

## 10. 现状锚点

### a. 画廊目前只有本地和网络两个来源

[`apps/kabegame/src/views/Gallery.vue:46`](../../../apps/kabegame/src/views/Gallery.vue#L46)

```vue
<CrawlerDialog v-if="!isCompact" ... />
<LocalImportDialog v-if="!isCompact && !IS_WEB" ... />

<!-- 现状：空状态的桌面对话框只有 local / network -->
<div v-if="!IS_WEB" class="collect-menu-option" @click="onDesktopCollectLocal">...</div>
<div class="collect-menu-option" @click="onDesktopCollectNetwork">...</div>
```

[`apps/kabegame/src/components/CollectSourcePicker.vue:30`](../../../apps/kabegame/src/components/CollectSourcePicker.vue#L30)

```ts
const emit = defineEmits<{
  (e: "select", source: "local" | "remote"): void;
}>();
// 现状：紧凑模式同样只有 local / remote。
```

### b. `local-import` 已提供所需的内置插件先例

[`src-tauri/kabegame-core/src/plugin/builtin.rs:11`](../../../src-tauri/kabegame-core/src/plugin/builtin.rs#L11)

```rust
/// 内建插件静态表。当前仅 local-import，且不进入已安装插件列表。
pub fn builtin_plugins() -> &'static HashMap<String, Arc<Plugin>> {
    // 现状：静态表只返回 LOCAL_FOLDER_PLUGIN_ID。
}
```

### c. 内置任务目前在 scheduler 中按 ID 直接分发

[`src-tauri/kabegame-core/src/crawler/task_scheduler/mod.rs:728`](../../../src-tauri/kabegame-core/src/crawler/task_scheduler/mod.rs#L728)

```rust
if plugin.script.is_builtin() {
    return match plugin.id.as_str() {
        LOCAL_FOLDER_PLUGIN_ID => {
            crate::crawler::local_import::run_builtin_local_import(Arc::clone(&run))
                .await
                .map_err(TaskError::Other)
        }
        other => Err(TaskError::Other(format!("未知内建插件: {other}"))),
    };
}
```

### d. 通用任务契约已经承载目录、画册与参数

[`packages/kabegame-core/src/stores/crawler.ts:529`](../../../packages/kabegame-core/src/stores/crawler.ts#L529)

```ts
async function addTask(
  pluginId: string,
  outputDir?: string,
  userConfig?: Record<string, any>,
  outputAlbumId?: string,
  httpHeaders?: Record<string, string>,
  runConfigId?: string,
  triggerSource: CrawlTask["triggerSource"] = "manual",
): Promise<boolean>
```

现有契约足够表达网页任务，无需数据库迁移。

### e. 任务抽屉当前只按插件静态脚本类型显示 WebView 按钮

[`packages/kabegame-core/src/components/task/TaskDrawerContent.vue:526`](../../../packages/kabegame-core/src/components/task/TaskDrawerContent.vue#L526)

```ts
const isJsTask = (pluginId: string) =>
  pluginStore.plugins.find((plugin) => plugin.id === pluginId)?.scriptType === "js";

const shouldShowTaskWebviewButton = (task: ScriptTask) =>
  (task.status === "running" || task.status === "waiting_downloads") &&
  isJsTask(task.pluginId);
// 现状：webpage 的 scriptType 固定为 builtin，因此选择 WebView 后仍不会出现按钮。
```

`TaskDrawer.vue` 目前只把 `tasks/plugins/active` 传给 `TaskDrawerContent`，没有提供任务级 WebView
能力判断。本需求要求该判断由应用层 `TaskDrawer.vue` 完成，因为 `webpage` 的执行后端是每次任务的
参数，不是插件静态属性。

### f. `local-import` 的固定字段尚未满足本次统一约定

[`src-tauri/kabegame-core/src/plugin/builtin.rs:15`](../../../src-tauri/kabegame-core/src/plugin/builtin.rs#L15)

```rust
let version = "0.0.0".to_string(); // 现状：不是本需求约定的 1.0（落地为 1.0.0）
// ...
description_template: None,
recommended_configs: Vec::new(),
var_defs: Vec::new(),
script: PluginScript::new(PluginBackend::Builtin, String::new()),
```

### g. `PluginScript` 可以保存 builtin source，但目前没有读取接口

[`src-tauri/kabegame-core/src/plugin/mod.rs:100`](../../../src-tauri/kabegame-core/src/plugin/mod.rs#L100)

```rust
pub struct PluginScript {
    backend: Option<PluginBackend>,
    source: String,
}

pub fn js_source(&self) -> Option<&str> {
    matches!(self.backend, Some(PluginBackend::Webview)).then(|| self.source.as_str())
}

pub fn is_builtin(&self) -> bool {
    matches!(self.backend, Some(PluginBackend::Builtin))
}
// 现状：builtin 可以携带 source，但没有 builtin_source() 读取它。
```

### h. 图片详情模板已经支持 metadata 与外部跳转桥

[`packages/kabegame-core/src/components/common/ImagePluginDescriptionPanel.vue:57`](../../../packages/kabegame-core/src/components/common/ImagePluginDescriptionPanel.vue#L57)

```ts
// 现状：业务数据通过 metadata 输入模板，另有缓存失效用的 plugin_version。
const effectiveMetadata = computed(() => { /* ... */ });

// 现状：iframe 发来的 openUrl 只允许 http / https，再交给宿主打开。
if (action === "openUrl") {
  const url = typeof d.url === "string" ? d.url : "";
  if (!isAllowedOpenUrl(url)) { /* ... */ }
  void openExternalLink(url);
}
```

因此 `webpage.description_template` 所需的快照和初始 URL 都必须冻结进 metadata；模板不应依赖
`ImageInfo.postUrl` 作为额外渲染参数。

## 11. 实施方案（评审通过后）

### 点 1 — 三来源入口与独立表单（前端）

- **新增**
  - `apps/kabegame/src/components/WebpageCollectDialog.vue`：桌面 dialog + 紧凑 drawer，共用一份表单状态与校验。
  - 网页表单的 URL、后端、Host Header 与输出目标校验测试。
- **修改**
  - `CollectAction.vue`、`CollectSourcePicker.vue`、`GalleryToolbar.vue`、`Gallery.vue` 增加 `webpage` 分支。
  - `WebpageCollectDialog` 从 `webpage.config.vars` 取得 URL/后端定义并复用 `PluginVarsForm`；复用
    `HttpHeadersEditor`，仅 Host 显示，WebView 提交时强制清空 `httpHeaders`。
  - 使用 `Link` 或 `ChromeFilled` 等现有图标；新样式优先 UnoCSS，不新增业务侧 `.el-*` 覆盖。
  - 目标画册创建流程复用现有 `AlbumPickerField`；目标目录复用现有选择逻辑，不自行计算路径。
  - Android 弹层接入统一返回栈。
- **删除**
  - 无。

目标入口类型：

```ts
type CollectSource = "local" | "remote" | "webpage"; // 修改：新增 webpage
```

### 点 2 — `webpage` 内置插件与冻结参数（Rust）

- **新增**
  - Rust `WEBPAGE_PLUGIN_ID` 与前端 `WEBPAGE_PLUGIN_ID = "webpage"` 常量、内置插件多语言元数据、
    共享图标和完整 `config.vars`；前端常量与已有 `LOCAL_IMPORT_PLUGIN_ID` 放在同一来源。
  - 编译期内嵌的 `webpage_discover.js` 与 `webpage_description.ejs`。
  - `crawler/webpage/` 模块，包含配置反序列化、二次校验、runner 分发与汇总日志。
- **修改**
  - `builtin_plugins()` 同时注册 `local-import` 与 `webpage`。
  - `webpage` 和 `local-import` 统一采用 6.1 的固定字段；共享当前 local-import 图标；两者版本固定为
    `1.0.0`，`recommended_configs` 固定为空。
  - `PluginScript` 增加只读 builtin source 访问能力；`webpage` 的 Builtin source 是页面发现 JS，
    `local-import` 的 Builtin source 仍为空。
  - scheduler 的 builtin 分发增加 `WEBPAGE_PLUGIN_ID`，并让网页 runner 走下载排空收尾。
  - 插件安装/刷新时自动把 `webpage` 视为保留 ID（沿用静态内置表判断，不再写一份字符串黑名单）。
- **删除**
  - 无。

目标分发形状：

```rust
match plugin.id.as_str() {
    LOCAL_FOLDER_PLUGIN_ID => run_builtin_local_import(run).await,
    WEBPAGE_PLUGIN_ID => run_builtin_webpage(download_queue, run).await, // 新增
    other => Err(format!("未知内建插件: {other}")),
}
```

### 点 3 — Host / WebView 页面发现器

- **新增**
  - `HostPageDiscoverer`：代理感知 HTTP 请求、HTML 解析、DOM 来源提取、URL 解析与候选去重。
  - WebView 内置采集脚本：页面稳定检测、有限自动滚动、DOM 提取、HTML 快照与结构化结果返回。
  - 两端共享的 fixture 期望数据，锁定同一份静态 HTML 得到相同候选集合。
- **修改**
  - 把现有 WebView 创建/心跳/销毁流程抽成可由普通 WebView 插件和 `webpage` builtin 共用的会话函数；
    允许 runner 显式传入 URL 与 `plugin.script.builtin_source()`，而不是只能从
    `plugin.script.js_source()` 读取。
  - 将脚本结果接收与 Rust 下载提交做成独立入口，使未来“冲浪”当前页面按钮能直接复用；本期不增加
    冲浪 UI，也不复制脚本到 Surf 模块。
  - `TaskDrawer.vue` 新增任务级 `canOpenTaskWebview(task)` 判断，并通过 prop/callback 传给
    `TaskDrawerContent.vue`；通用 core 组件只消费判断结果，不硬编码 `webpage`。
  - 任务详情页采用相同规则：`pluginId = webpage && userConfig.backend = webview` 且任务运行中时显示
    “打开 WebView”，Host 任务不显示。
- **删除**
  - 删除 `TaskDrawerContent.vue` 中“只按静态 `scriptType === "js"` 即可决定按钮”的封闭假设；普通
    JS 插件行为由 `TaskDrawer.vue` 的新判断原样保留。

目标前端判断：

```ts
function canOpenTaskWebview(task: CrawlTask): boolean {
  if (task.status !== "running" && task.status !== "waiting_downloads") return false;
  if (task.pluginId === WEBPAGE_PLUGIN_ID) {
    return task.userConfig?.backend === "webview"; // 新增：任务级动态后端
  }
  return pluginStore.plugins.find((plugin) => plugin.id === task.pluginId)?.scriptType === "js";
}
```

### 点 4 — 下载 transport 与现有入库链路

- **新增**
  - request/task 级下载 transport（`host` / `webview`），网页任务显式传递。
  - 页面级 `WebpageMetadata` 创建与共享：同一次页面发现只插入一条 metadata，所有候选复用其 ID。
- **修改**
  - WebView 网页任务使用浏览器下载通道且忽略任务 Header；Host 将任务 `httpHeaders` 同时用于入口页面
    与候选媒体请求，并沿用现有 Header 安全策略。
  - 所有候选的 `post_url` 固定写用户输入的初始 URL；最终页面 URL 只写入 metadata 的 `documentUrl`。
  - 候选媒体直接进入现有下载后处理，不在 `webpage` 分支增加尺寸、大小或类型过滤。
  - 确保下载排空、临时文件清理、取消和失败图片语义正确。
- **删除**
  - 删除“只按插件静态 script type 推断所有下载 transport”的单一假设；普通插件的兼容默认值保留。

### 点 5 — 冻结 HTML 的详情模板

- **新增**
  - `webpage_description.ejs`：渲染隔离的页面快照，并提供“打开原网页”按钮。
  - Host 原始 HTML、WebView 最终 DOM、恶意 `</script>`、外部脚本/表单/导航阻断和初始 URL 跳转测试。
- **修改**
  - 网页 runner 创建一次 metadata 并把同一个 ID 传给所有下载；沿用现有引用计数式 metadata GC，
    只有最后一个图片/失败项引用删除后才回收快照。
  - 确保 builtin 随 `get_plugins` 序列化下发的 `descriptionTemplate` 能被现有 `pluginStore` 直接读取；
    不为内置模板另建 `.kgpg` 或第二套模板加载命令。
- **删除**
  - 无。

目标模板边界：

```html
<!-- 外层是可信 builtin EJS，拥有现有 __bridge；捕获 HTML 只能进入无脚本的内层 srcdoc。 -->
<a href="#" data-url="<%= metadata.sourceUrl %>" role="button">打开原网页</a>
<iframe sandbox="" referrerpolicy="no-referrer" data-page-snapshot></iframe>
```

### 点 6 — 文案、文档、分析与回归

- **新增**
  - `gallery` / `tasks` 的中、英、日、韩、繁中文案。
  - Host 提取、Header 注入与校验、URL 规范化、任务内去重、共享 metadata、取消、WebView session mock
    和页面发现 JS 返回契约测试。
  - 实现落地时在 `versions/latest/regression.md` 增加本 PRD 的真实操作回归项。
- **修改**
  - `cocs/crawler/CRAWLER_JS_FLOW.md`：内置插件不再只有 `local-import`，补充 `webpage` 双 runner 与 transport。
  - `cocs/README.md` 索引同步更新。
  - 分析事件增加网页来源和 Header 数量布尔/计数，但不上传 URL、Header 名值、HTML 或页面发现结果。
- **删除**
  - 无。

## 12. 验收标准

### 12.1 UI 与任务

- [ ] 工具栏下拉、空状态对话框、紧凑来源选择器均以“本地 / 网络 / 网页”顺序展示。
- [ ] 点击网页只打开网页表单；取消后不创建任务，再次打开不残留上次未提交数据。
- [ ] 非法 URL、非 HTTP(S) 或带用户名/密码时无法提交，并在 URL 字段显示原因。
- [ ] URL 与后端字段由 `webpage.config.vars` 渲染；目标目录、目标画册和 Header 使用任务通用字段。
- [ ] Host 显示 HTTP Header 编辑器并提交规范化后的 Header；切换到 WebView 后编辑器隐藏，任务中的
  `httpHeaders` 为空，即使此前填过 Host Header 也不能泄漏进去。
- [ ] 提交成功后任务列表显示内置来源“网页收集”，任务 ID 对应记录的 `pluginId` 为 `webpage`。
- [ ] 任务参数面板显示本地化字段名；来源管理和普通插件选择器不出现 `webpage`。
- [ ] `TaskDrawer.vue` 对运行中的 `webpage + webview` 显示“打开 WebView”，点击后调用现有
  `show_crawler_window`；`webpage + host` 不显示。
- [ ] 普通 JS 插件仍按原规则显示按钮；`pending/completed/failed/canceled` 的网页任务均不显示。

### 12.2 发现与下载

- [ ] Host 能从静态 fixture 提取 `src/srcset/lazy/video/meta/direct-link`，正确处理 `<base>`、相对 URL、
  重定向 URL、query、fragment 和重复项。
- [ ] WebView 能收集 JavaScript 动态插入及滚动后出现的媒体，并在上限内结束。
- [ ] `webpage.scriptType` 与 `PluginScript.backend` 都保持 builtin，但 `PluginScript.source` 内含可执行的
  当前页面资源发现 JS；其结果符合 `{ candidates, pageHtml, documentUrl }` 契约。
- [ ] 页面发现 JS 不依赖任务 ID、任务 Store 或下载 API，可在模拟“冲浪当前 document”的测试环境中
  独立执行；本期界面中不出现冲浪按钮。
- [ ] Host 的入口页面与媒体下载请求都收到相同任务 Header；WebView 请求未注入这些 Header；非法 Header
  在前端与后端均被拒绝，Header 值不出现在日志或埋点。
- [ ] 网页表单和任务 `userConfig` 均不包含允许/排除格式、最小文件大小或最小分辨率字段。
- [ ] 所有去重后的候选直接进入现有下载链路，不因本 PRD 中已移除的条件被提前丢弃。
- [ ] 后续全局隐藏规则即使命中，也是在媒体成功入库后设置隐藏，不把它回算为网页下载失败。
- [ ] 同一页面成功下载的媒体共享一份 metadata 快照；Host 保存响应 HTML，WebView 保存发现时最终 DOM；
  `sourceUrl` 是用户初始 URL，`documentUrl` 可记录重定向后的实际页面 URL。
- [ ] 每张媒体的 `images.post_url` 都等于用户初始 URL，不因页面或媒体重定向而改变。
- [ ] 图片详情能在受限 iframe 中渲染冻结 H5，并通过“打开原网页”跳转初始 URL；捕获 HTML 中的脚本、
  表单、弹窗、子 frame 与导航无法执行或逃逸到宿主。

### 12.3 输出、生命周期与平台

- [ ] 未指定目录时落到现有默认下载目录；指定目录时只写入该目录，不自行拼接新路径规则。
- [ ] 指定画册后只把成功入库媒体加入该画册；现场创建画册失败时不创建任务。
- [ ] WebView 模式在需要登录态的测试页能携带 Cookie 下载媒体，Host 不冒充浏览器会话。
- [ ] 取消 Host 请求、WebView 扫描和 waiting downloads 均能进入 `canceled`，无后续偷偷入库。
- [ ] Android 只允许 Host，WebView 选项有明确禁用原因；目标画册有效，目标文件夹不展示。
- [ ] Web 发布版按本次评审结论隐藏，或在 SSRF 防护验收后仅开放 Host。
- [ ] `webpage` 与 `local-import` 的公共固定字段符合 6.1：版本均为 `1.0.0`、共享图标、
  `recommended_configs = []`、`scriptType = builtin`；网页有模板和发现 JS，本地导入仍无模板且脚本为空。

### 12.4 验证方式

- 前端与 Rust 按仓库规则分别使用 `check-kabegame`，不以 build 代替检查。
- Rust 定向测试使用 `test-kabegame`，不直接运行裸 `cargo test`。
- 桌面真实 WebView、Cookie、滚动、取消和任务窗口使用 `kabegame-chromium` 做运行验证。
- 只有明确验收开发 Web 发布版时才用 `agent-browser` 检查该版本。

## 13. 待评审问题

1. **Web 发布版是否需要首期开放？** 推荐首期隐藏；若要开放，必须把 SSRF 防护列为前置需求。
2. **Android 是否接受只支持 Host？** 当前爬虫 WebView 后端明确只支持桌面；Android WebView 会把本需求
   扩大为新的运行时能力，不建议并入首期。
3. **DOM 发现范围是否足够？** 本稿包含常见媒体标签、懒加载、OG/Twitter 和直链，不包含 CSS 背景、
   iframe、脚本字符串；若这些是核心场景，应在实现前确定优先级。
4. **WebView 自动滚动是否默认开启？** 本稿建议固定开启并设置 20 秒/30 次硬上限；若担心页面副作用，
   可改为表单开关，默认关闭。
5. **单页 HTML 快照上限是多少？** 快照会进入本地数据库且被同页图片共享。实现前需要确定 Host 响应
   与 WebView `outerHTML` 的字节上限，以及超限时是任务失败还是保存明确标记的截断快照；推荐“超限
   任务失败”，避免详情页悄悄展示不完整 HTML。
