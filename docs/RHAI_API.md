# Rhai 爬虫 API 文档

本文档列出了所有可在 Rhai 脚本中使用的爬虫相关函数。

## 插件变量（来自 `config.json` 的 `var`）

Rhai 脚本里可以直接使用插件在 `config.json` 中声明的变量（由前端表单收集后传入）。

### 变量类型与在脚本中的形态

- `int` / `float`: 数字
- `string`: **字符串**，单行文本
- `date`: **字符串**，由应用在启动任务前按插件声明的 **`format`**（[dayjs 格式](https://day.js.org/docs/en/display/format)）规范化后传入 Rhai；省略 `format` 时为 `YYYY-MM-DD`。脚本侧与 `string` 相同，按业务自行解析（例如 Pixiv 排行榜 `date=` 需无分隔符 `YYYYMMDD` 时，在 `config.json` 写 `"format": "YYYYMMDD"` 即可，**无需在 Rhai 里再改格式**）。
- `boolean`: 布尔
- `options`（单选）: **字符串（variable）**
- `list`（字符串列表）: **字符串数组**，例如 `["jpg","png"]`
- `checkbox`（多选）: **对象（bool map）**，key 为 `variable`，value 为 `true/false`

#### `date` 在 `config.json` 中的可选字段

| 字段 | 说明 |
|------|------|
| `format` | dayjs 格式串，决定写入任务变量、交给脚本的字符串形态（如 `YYYYMMDD`、`YYYY-MM-DD`） |
| `dateMin` / `dateMax` | 可选；日历可选范围边界。可为固定 **`YYYY-MM-DD`**，或关键字 **`today`** / **`yesterday`**（不区分大小写，按用户本机本地日历日解析）。含关键字时前端用 VueUse **`useNow`**（约每分钟）推进「当前日」，并在自然日切换后刷新日期面板，避免跨午夜仍按旧「今天」禁用。仅影响日期选择器与校验，与 `format` 无关 |

应用在**开始爬取、保存运行配置**时会对每个 `date` 变量调用与前端相同的规范化逻辑：即使界面里仍是旧版 `YYYY-MM-DD` 或未触发过 `change`，也会按 `format` 转成目标字符串再交给后端与 Rhai。

### `options` / `checkbox` 的 `options` 定义格式

推荐在 `config.json` 中使用：

```json
{
  "key": "quality",
  "type": "options",
  "name": "图片质量",
  "options": [
    { "name": "高清", "variable": "high" },
    { "name": "中等", "variable": "medium" }
  ],
  "default": "high"
}
```

- 前端 UI 显示 `name`
- 实际传入脚本 / 保存到配置的是 `variable`
- 兼容旧格式：`["high","medium"]`（等价于 `name=variable`）

### `list` 的说明（不要引入 name/variable）

`list` 的值是**可变长字符串数组**，例如本地导入的扩展名：

```json
{
  "key": "file_extensions",
  "type": "list",
  "name": "文件扩展名",
  "default": ["jpg", "png"],
  "options": ["jpg", "png", "webp", "gif"]
}
```

- `list.options`（如果提供）应保持为 `string[]`，用于“建议项/可选项”
- 不要把 `list.options` 写成 `{ "name": "...", "variable": "..." }`，否则会误导成固定枚举
- **前端表现**：`list` 会渲染为**可扩展的 tag 列表**。已选中的项以标签形式展示，可点击标签的关闭按钮移除；通过下方下拉框选择建议项或输入自定义值并确认即可新增一项（与「输出画册」里添加画册的交互类似：添加后多一个 tag）。

### `checkbox` 在脚本中的用法示例

如果 `config.json` 中定义：

```json
{
  "key": "wallpaper_type",
  "type": "checkbox",
  "name": "壁纸类型",
  "options": [
    { "name": "桌面壁纸", "variable": "desktop" },
    { "name": "手机壁纸", "variable": "mobile" }
  ],
  "default": ["desktop", "mobile"]
}
```

在 Rhai 脚本中你会收到：
- `wallpaper_type.desktop` / `wallpaper_type.mobile`（bool）

例如：

```rhai
if wallpaper_type.desktop {
  // 下载桌面壁纸
}
if wallpaper_type.mobile {
  // 下载手机壁纸
}
```

### `when` 条件显示

在 `config.json` 的 var 定义中，可添加可选字段 `when`，用于**根据其他 options 变量的当前值**控制该字段在表单中的显示与否。格式为：

```json
{
  "key": "artist_id",
  "type": "string",
  "name": "画师 UID",
  "when": { "source": ["user"] }
}
```

- `when` 的 key 为某个 **options 类型变量**的 key
- `when` 的 value 为**匹配值数组**；当该 options 变量的当前值在数组中时，该字段才显示
- 多个 key 时为 **AND** 关系，即所有条件都满足时才显示

**示例**：仅当 `source` 为 `"user"` 或 `"bookmark"` 时显示 `user_id`：

```json
{
  "key": "user_id",
  "type": "string",
  "name": "用户 UID",
  "when": { "source": ["bookmark", "user"] }
}
```

- `when` 仅影响前端表单 UI；Rust 侧仍会注入所有变量（含隐藏字段的默认值），脚本可正常使用。

## 目录

- [页面导航](#页面导航)
- [页面信息](#页面信息)
- [元素查询](#元素查询)
- [URL 处理](#url-处理)
- [HTTP 头](#http-头)
- [图片处理](#图片处理)
- [WebView 爬虫 API（crawl.js）](#webview-爬虫-apicrawljs)

---

## 页面导航

### `to(url)`

访问一个网页，将当前页面入栈。

**参数：**
- `url` (string): 要访问的 URL，支持绝对 URL 和相对 URL

**返回值：**
- `()`: 成功时返回空值
- `String`: 失败时返回错误信息

**示例：**
```rhai
// 访问绝对 URL
to("https://example.com");

// 访问相对 URL（基于当前页面）
to("/page2");
to("../other-page");
```

**说明：**
- 如果 URL 是相对路径，会基于当前栈顶的 URL 进行解析
- 访问成功后，页面会被推入页面栈
- 若响应使用 **gzip** 压缩（常见 `Content-Encoding: gzip`），底层 HTTP 客户端会自动解压后再写入页面栈；`current_html()` 得到的是解压后的 HTML 文本

---

### `fetch_json(url)`

请求一个 JSON API，解析响应并返回 Rhai 值。**不入页面栈**（与 `to()` 不同，仅拉取数据，不参与 back 导航）。

**参数：**
- `url` (string): JSON API 的 URL，支持绝对 URL 和相对 URL

**返回值：**
- `Map`: JSON 对象（如果是对象类型）
- `Map`: 包装在 Map 中的其他类型（键为 "data"）

**示例：**
```rhai
// 请求 JSON API
let json_data = fetch_json("https://api.example.com/data");

// 如果是对象，直接访问属性
let name = json_data["name"];
let items = json_data["items"];

// 如果是数组或其他类型，通过 "data" 键访问
let array_data = json_data["data"];

// 遍历数组
for item in array_data {
    let url = item["url"];
    download_image(url);
}
```

**说明：**
- 如果 JSON 响应是对象，直接返回对应的 Map
- 如果 JSON 响应是数组、字符串、数字等，会被包装在一个 Map 中，键为 "data"
- 支持嵌套对象和数组
- 不入页面栈，调用 `back()` 不会“退回”到 fetch_json 的请求

---

### `parse_json(text)`

解析 JSON 字符串并返回 Rhai 值。适合处理页面里内嵌的 JSON（例如 `script[type="application/ld+json"]`）。

**参数：**
- `text` (string): JSON 文本

**返回值：**
- `Map`: JSON 对象（如果是对象类型）
- `Map`: 包装在 Map 中的其他类型（键为 "data"）

**示例：**
```rhai
to("https://wallspic.com/tag/cyberpunk_2077");
let scripts = query("script[type=\"application/ld+json\"]");

for s in scripts {
    let parsed = parse_json(s);

    // 顶层数组会包装在 data 字段
    let arr = parsed["data"];
    if arr != () {
        for item in arr {
            let url = item["contentUrl"];
            if url != () {
                download_image(url);
            }
        }
    }
}
```

**说明：**
- 转换规则与 `fetch_json()` 一致：对象直接返回 Map，数组/字符串/数字/布尔/空值包装在 `"data"` 键里
- `parse_json()` 仅做字符串解析，不会发起网络请求，也不会修改页面栈

---

### `back()`

返回上一页，从页面栈中弹出当前页面。

**参数：**
- 无

**返回值：**
- `()`: 成功时返回空值
- `String`: 失败时返回错误信息（页面栈为空）

**示例：**
```rhai
to("https://example.com/page1");
to("https://example.com/page2");
back(); // 返回到 page1
```

---

## 页面信息

### `current_url()`

获取当前栈顶页面的 URL。

**参数：**
- 无

**返回值：**
- `String`: 当前页面的 URL
- `String`: 错误信息（页面栈为空）

**示例：**
```rhai
to("https://example.com");
let url = current_url(); // "https://example.com"
```

---

### `current_html()`

获取当前栈顶页面的 HTML 内容。

**参数：**
- 无

**返回值：**
- `String`: 当前页面的 HTML 内容
- `String`: 错误信息（页面栈为空）

**示例：**
```rhai
to("https://example.com");
let html = current_html();
```

---

## 元素查询

### `query(selector)`

在当前页面查询元素文本内容。支持 CSS 选择器和简单的 XPath。

**参数：**
- `selector` (string): CSS 选择器或 XPath 表达式

**返回值：**
- `Array`: 匹配元素的文本内容数组

**支持的选择器类型：**

1. **CSS 选择器**（默认）：
   - `"img"` - 所有图片元素
   - `".class-name"` - 指定 class 的元素
   - `"#id-name"` - 指定 id 的元素
   - `"div > a"` - 子元素选择器
   - `"a[href]"` - 属性选择器

2. **XPath**（以 `/` 或 `//` 开头）：
   - `"//tag"` - 查找所有 tag 元素
   - `"/tag"` - 从根节点查找 tag 元素

**示例：**
```rhai
// CSS 选择器
let titles = query("h1.title");
let links = query("a");

// XPath
let all_divs = query("//div");
let root_html = query("/html");

// 遍历结果
for title in titles {
    print(title);
}
```

---

### `query_by_text(text)`

通过文本内容查找包含该文本的所有元素，返回元素的详细信息。

**参数：**
- `text` (string): 要查找的文本内容

**返回值：**
- `Array`: 匹配元素的信息数组，每个元素是一个 Map，包含：
  - `text` (string): 元素的文本内容
  - `tag` (string): 元素的标签名
  - `attrs` (Map): 元素的所有属性
  - `id` (string, 可选): 元素的 ID（如果存在）
  - `class` (string, 可选): 元素的 class（如果存在）

**示例：**
```rhai
// 查找所有包含 "下一页" 文本的元素
let elements = query_by_text("下一页");

for element in elements {
    let tag = element["tag"];      // 标签名，如 "a", "button"
    let text = element["text"];     // 文本内容
    let id = element["id"];        // ID（如果存在）
    let class = element["class"];   // class（如果存在）
    let attrs = element["attrs"];   // 所有属性
    
    // 如果是链接，获取 href
    if tag == "a" {
        let href = attrs["href"];
        to(href);
    }
}
```

---

### `find_by_text(text, tag)`

在指定标签中查找包含指定文本的元素。

**参数：**
- `text` (string): 要查找的文本内容
- `tag` (string): 标签名（如 "a", "button", "div"）

**返回值：**
- `Array`: 匹配元素的文本内容数组

**示例：**
```rhai
// 在 <a> 标签中查找包含 "下一页" 的链接
let links = find_by_text("下一页", "a");

// 在 <button> 标签中查找包含 "加载更多" 的按钮
let buttons = find_by_text("加载更多", "button");
```

---

### `get_attr(selector, attr)`

获取指定元素的属性值。

**参数：**
- `selector` (string): CSS 选择器或 XPath 表达式
- `attr` (string): 属性名（如 "href", "src", "class"）

**返回值：**
- `Array`: 匹配元素的属性值数组

**示例：**
```rhai
// 获取所有图片的 src 属性
let image_urls = get_attr("img", "src");

// 获取所有链接的 href 属性
let link_urls = get_attr("a", "href");

// 遍历图片 URL
for url in image_urls {
    let full_url = resolve_url(url);
    if is_image_url(full_url) {
        download_image(full_url);
    }
}
```

**说明：**
- 支持 CSS 选择器和 XPath（与 `query` 函数相同）
- 如果元素没有指定属性，该元素会被跳过

---

## URL 处理

### `url_encode(s)`

对字符串进行 URL 百分号编码，用于 query 或 path 中需要编码的片段。

**参数：**
- `s` (string): 要编码的字符串

**返回值：**
- `String`: 编码后的字符串

**示例：**
```rhai
let kw = url_encode("关键词 测试");
let url = "https://example.com/search?q=" + kw;
```

---

### `resolve_url(relative)`

将相对 URL 解析为绝对 URL（基于当前栈顶的 URL）。

**参数：**
- `relative` (string): 相对 URL

**返回值：**
- `String`: 解析后的绝对 URL
- `String`: 错误信息（页面栈为空或 URL 解析失败）

**示例：**
```rhai
to("https://example.com/page1");

// 解析相对 URL
let full_url1 = resolve_url("/page2");        // "https://example.com/page2"
let full_url2 = resolve_url("../other");     // "https://example.com/other"
let full_url3 = resolve_url("image.jpg");    // "https://example.com/page1/image.jpg"
```

---

### `is_image_url(url)`

检查 URL 是否是图片 URL。

**参数：**
- `url` (string): 要检查的 URL

**返回值：**
- `bool`: 如果是图片 URL 返回 `true`，否则返回 `false`

**判断规则：**
- URL 以 `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` 结尾
- URL 中包含 "image" 或 "img" 关键字

**示例：**
```rhai
let url1 = "https://example.com/image.jpg";
let url2 = "https://example.com/api/image/123";
let url3 = "https://example.com/page.html";

print(is_image_url(url1));  // true
print(is_image_url(url2));  // true
print(is_image_url(url3));  // false
```

---

### `re_is_match(pattern, text)`

使用正则表达式判断 `text` 是否匹配 `pattern`。

**参数：**
- `pattern` (string): 正则表达式（使用 Rust `regex` 语法）
- `text` (string): 要匹配的文本

**返回值：**
- `bool`: 匹配返回 `true`，否则返回 `false`

**注意：**
- 如果 `pattern` 不是合法正则表达式，会返回 `false`（不会抛异常）

**示例：**
```rhai
let url = "https://example.com/ranking-daily-imgpc/1";
print(re_is_match("imgpc", url));           // true
print(re_is_match("^https://", url));      // true
print(re_is_match("imgsp", url));          // false
print(re_is_match("(", url));              // false（非法正则，返回 false）
```

---

### `re_replace_all(pattern, replacement, text)`

对 `text` 做**全局**正则替换：将 `pattern` 匹配到的所有子串替换为 `replacement`，返回新字符串（**不修改**传入的 `text` 变量）。

**参数：**
- `pattern` (string): 正则表达式（Rust [`regex`](https://docs.rs/regex) 语法）
- `replacement` (string): 替换内容；支持正则替换占位符，例如 `$0`（整段匹配）、`$1`（第一个捕获组）等，规则与 Rust `regex::Regex::replace_all` 一致
- `text` (string): 待处理的字符串

**返回值：**
- `String`: 替换后的字符串
- 若 `pattern` **不是合法正则**，返回**原始的 `text`**（不抛异常，与 `re_is_match` 对非法 pattern 的处理思路一致）

**示例：**
```rhai
// 将缩略图 URL 中任意 _宽x高 尺寸段改为目标分辨率（如站点使用 _300x168、_400x225 等均可）
let thumb = "https://cdn.example.com/img/foo_300x168.jpg";
let full = re_replace_all("_\\d+x\\d+", "_1920x1080", thumb);

// 使用捕获组：把 "id=123" 换成 "id=456"
let s = re_replace_all("id=(\\d+)", "id=456", "https://x.com/view?id=123");
```

**说明：**
- 与 Rhai 内置字符串方法 `replace` / `trim` 等不同：内置的 `str.replace(...)` 多为**原地修改**且返回 `()`，链式调用容易出错；需要**按模式替换并拿到新字符串**时请优先使用本函数
- 仅替换**所有**匹配项；若将来需要“只替换第一处”等能力，可再扩展 API

---

## HTTP 头

### `set_header(key, value)`

设置一个 HTTP Header（覆盖同名值）。

**参数：**
- `key` (string): Header 名（如 `Authorization`、`User-Agent`）
- `value` (string): Header 值

**返回值：**
- `()`

**说明：**
- 仅影响当前任务中由 Rhai 发起的 HTTP 请求（如 `to()`、`fetch_json()`、`download_image()`、`download_archive()`）
- `key` / `value` 会做合法性校验；不合法会被忽略，并在任务日志中提示

**示例：**
```rhai
set_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
set_header("Authorization", "Bearer " + token);

to("https://example.com/protected");
```

---

### `del_header(key)`

删除一个 HTTP Header。

**参数：**
- `key` (string): Header 名

**返回值：**
- `()`

**示例：**
```rhai
del_header("Authorization");
```

---

## 图片处理

### `download_image(url)`

下载图片或文件并添加到下载队列（异步下载）。

**参数：**
- `url` (string): 资源 URL（图片或视频等）

**返回值：**
- `bool`: 成功加入队列返回 `true`
- `String`: 失败时返回错误信息

**示例：**
```rhai
// 获取所有图片 URL
let image_urls = get_attr("img", "src");

for url in image_urls {
    let full_url = resolve_url(url);
    if is_image_url(full_url) {
        download_image(full_url);
    }
}

// 也可下载视频
download_image("https://example.com/video.mp4");
```

**说明：**
- 支持下载**图片**与**视频**：按 URL 扩展名保存到插件对应目录，图片与视频会加入图库。
- 资源会被添加到下载队列，由后台线程异步下载。
- 下载的图片与视频会自动保存到插件目录并加入图库。

---

## WebView 爬虫 API（crawl.js）

当插件提供 **crawl.js** 且在**桌面端**运行时，会使用 WebView 后端；脚本运行在浏览器环境中，通过注入的 **`ctx`**（即 `window.__crawl_ctx__`）访问与 Rhai 对等的 API。以下为当前实现的 WebView 爬虫 API，与 [CRAWLER_BACKENDS.md](./CRAWLER_BACKENDS.md) 第 6.2 节对应。

**变量与上下文**

- **`ctx.vars`**：只读，来自 `config.json` 的 `baseUrl` 及任务变量（如 `start_page`、`quality` 等），与 Rhai 注入一致。
- **`ctx.currentContext()`**：返回当前上下文对象（含 `pageLabel`、`pageState`、`state`、`currentUrl`、`resumeMode` 等），用于根据当前步骤分支逻辑。

### 导航与页面

| 方法 | 说明 |
|------|------|
| `ctx.to(payload, opts?)` | 导航到新 URL。`payload` 可为字符串 URL，或对象 `{ url, pageLabel?, pageState? }`；导航后新页面会重新注入脚本，需依赖 `pageLabel`/`pageState` 恢复分支。 |
| `ctx.back(count?)` | 返回上一页，`count` 默认为 1。 |
| `ctx.updatePageState(patch)` | 合并更新当前页状态到 Rust 与本地 `ctx.pageState`，需传 plain object。 |
| `ctx.updateState(patch)` | 合并更新整个任务状态到 Rust 与本地 `ctx.state`，需传 plain object。 |

### DOM 与工具

| 方法 | 说明 |
|------|------|
| `ctx.$(selector)` | 返回 `document.querySelector(selector)` 的单个元素。 |
| `ctx.$$(selector)` | 返回 `document.querySelectorAll(selector)` 的数组。 |
| `ctx.waitForDom()` | 返回 Promise，在 `DOMContentLoaded` 后 resolve，用于等待 DOM 就绪。 |

### 进度与下载

| 方法 | 说明 |
|------|------|
| `ctx.addProgress(percentage)` | 累加任务进度（0–99.9），并上报前端。 |
| `ctx.downloadImage(url, opts?)` | 将 URL 加入下载队列。`opts` 可选：`{ cookie: true }` 表示使用浏览器 Cookie（经代理/门控由 Rust 处理）；`{ headers: { "Key": "Value" } }` 可附加请求头。支持图片与视频，行为与 Rhai 的 `download_image` 一致。 |

### 日志与生命周期

| 方法 | 说明 |
|------|------|
| `ctx.log(message, level?)` | 向任务日志输出一条记录，`level` 可选。 |
| `ctx.sleep(ms)` | 返回 Promise，延迟指定毫秒。 |
| `ctx.exit()` | 结束当前爬虫任务，避免空转。应在逻辑完成或未知分支时调用。 |
| `ctx.error(message)` | 以错误信息结束任务。 |
| `ctx.requestShowWebview()` | 请求显示爬虫 WebView 窗口（例如在验证码页让用户手动通过）。 |

### 使用约定

- 脚本入口由 Rust 在每次文档加载后注入并执行，**不要**依赖跨页面的 JS 内存状态；跨页状态用 `ctx.updatePageState` / `ctx.updateState` 持久化，下一页通过 `ctx.currentContext()` 恢复。
- 在 `switch (ctx.currentContext().pageLabel)` 等分支中，**default** 分支建议调用 `ctx.exit()`，表示无法识别当前页面时结束任务。
- 更多实现细节与 Rhai/JS 对等表见 [CRAWLER_BACKENDS.md](./CRAWLER_BACKENDS.md)。

---

## 完整示例

```rhai
// 定义起始 URL
let start_url = "https://example.com/gallery";

// 访问起始页面
to(start_url);

// 查找所有图片
let image_urls = get_attr("img", "src");
let image_list = [];

for url in image_urls {
    let full_url = resolve_url(url);
    if is_image_url(full_url) {
        image_list.push(full_url);
    }
}

// 下载所有图片
for url in image_list {
    download_image(url);
}

// 查找并访问下一页
let next_links = query_by_text("下一页");
for link in next_links {
    if link["tag"] == "a" {
        let href = link["attrs"]["href"];
        let next_url = resolve_url(href);
        to(next_url);
        
        // 继续处理下一页的图片...
        break;
    }
}

// 返回图片列表
image_list
```

---

## 注意事项

1. **页面栈管理**：
   - 使用 `to()` 访问页面时，页面会被推入栈；`fetch_json()` 仅拉取 JSON 数据，不入栈
   - 使用 `back()` 可以返回到上一页（仅对 `to()` 打开的页面有效）
   - 页面栈为空时，某些函数会返回错误

2. **URL 解析**：
   - 相对 URL 会基于当前栈顶的 URL 进行解析
   - 使用 `resolve_url()` 可以手动解析相对 URL

3. **选择器支持**：
   - CSS 选择器支持标准语法
   - XPath 支持简单的路径表达式（`//tag`, `/tag`）

4. **异步下载**：
   - `download_image()` 是异步的，图片或视频会在后台下载
   - 不需要等待下载完成即可继续执行脚本

### `download_archive(url, type)`

导入压缩包（异步处理）。支持 `zip` 和 `rar` 等。

**参数：**
- `url` (string): 压缩包 URL 或本地路径
- `type` (string | ()): 压缩包类型，支持 `"zip"`, `"rar"` 等。如果不确定类型，可以传入 `"none"` 或 `()`，系统会自动根据文件后缀名判断。

**说明：**
- 本地压缩包会解压到临时目录并递归导入其中的图片
- `http(s)` 的压缩包会先下载到临时目录再解压导入
- 解压产生的图片会作为“独立下载请求”逐个入队，受全局并发下载限制
- 支持自动检测类型：传入 `"none"` 或 `()` 时，系统会根据 URL 后缀（如 `.zip`, `.rar`）自动选择合适的处理器

**示例：**
```rhai
// 导入本地 zip（Windows 路径 / file URL 均可）
download_archive("D:\\Downloads\\pack.zip", "zip");

// 导入远程 zip
download_archive("https://example.com/pack.zip", "zip");

// 自动检测类型（推荐）
download_archive("D:\\Downloads\\pack.zip", ());
// 或者
download_archive("D:\\Downloads\\pack.rar", "none");
```

### `get_supported_archive_types()`

获取当前系统支持的压缩包类型列表。

**参数：**
- 无

**返回值：**
- `Array<String>`: 支持的类型列表，例如 `["rar", "zip"]`。

**示例：**
```rhai
let types = get_supported_archive_types();
print(types); // ["rar", "zip"]

// 检查是否支持 zip
if types.contains("zip") {
    download_archive("pack.zip", "zip");
}
```

5. **JSON 处理**：
   - `fetch_json()` 返回的 Map 可以直接访问属性
   - `parse_json()` 可将页面内嵌 JSON 字符串直接转换为 Map/Array（数组在 `"data"` 中）
   - 嵌套对象和数组都被正确转换

---

## 错误处理

所有函数在失败时都会返回错误信息（String 类型）。在 Rhai 脚本中，可以使用 `?` 操作符来处理错误：

```rhai
// 如果 to() 失败，脚本会停止执行并返回错误
to("https://example.com")?;

// 或者手动处理错误
let result = to("https://example.com");
if type_of(result) == "string" {
    // 处理错误
    print(result);
}
```

---

最后更新：2026年3月25日

