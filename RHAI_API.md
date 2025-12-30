# Rhai 爬虫 API 文档

本文档列出了所有可在 Rhai 脚本中使用的爬虫相关函数。

## 插件变量（来自 `config.json` 的 `var`）

Rhai 脚本里可以直接使用插件在 `config.json` 中声明的变量（由前端表单收集后传入）。

### 变量类型与在脚本中的形态

- `int` / `float`: 数字
- `boolean`: 布尔
- `options`（单选）: **字符串（variable）**
- `list`（字符串列表）: **字符串数组**，例如 `["jpg","png"]`
- `checkbox`（多选）: **对象（bool map）**，key 为 `variable`，value 为 `true/false`

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

## 目录

- [页面导航](#页面导航)
- [页面信息](#页面信息)
- [元素查询](#元素查询)
- [URL 处理](#url-处理)
- [图片处理](#图片处理)

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

---

### `to_json(url)`

访问一个 JSON API，返回 JSON 对象。

**参数：**
- `url` (string): JSON API 的 URL，支持绝对 URL 和相对 URL

**返回值：**
- `Map`: JSON 对象（如果是对象类型）
- `Map`: 包装在 Map 中的其他类型（键为 "data"）

**示例：**
```rhai
// 访问 JSON API
let json_data = to_json("https://api.example.com/data");

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

## 图片处理

### `download_image(url)`

下载图片并添加到下载队列（异步下载）。

**参数：**
- `url` (string): 图片的 URL

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
```

**说明：**
- 图片会被添加到下载队列，由后台线程异步下载
- 下载的图片会自动保存到插件对应的目录
- 下载完成后会自动添加到图库中

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
   - 使用 `to()` 或 `to_json()` 访问页面时，页面会被推入栈
   - 使用 `back()` 可以返回到上一页
   - 页面栈为空时，某些函数会返回错误

2. **URL 解析**：
   - 相对 URL 会基于当前栈顶的 URL 进行解析
   - 使用 `resolve_url()` 可以手动解析相对 URL

3. **选择器支持**：
   - CSS 选择器支持标准语法
   - XPath 支持简单的路径表达式（`//tag`, `/tag`）

4. **异步下载**：
   - `download_image()` 是异步的，图片会在后台下载
   - 不需要等待下载完成即可继续执行脚本

5. **JSON 处理**：
   - `to_json()` 返回的 Map 可以直接访问属性
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

最后更新：2024年

