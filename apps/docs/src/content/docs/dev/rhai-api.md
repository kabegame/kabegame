---
title: Rhai 脚本指南
description: 教你如何用 Rhai 编写 Kabegame 爬虫插件：脚本生命周期、下载、分页与元数据。
---

本页面向**插件作者**，讲解怎样用 Rhai 编写 `crawl.rhai`：脚本如何被执行、变量如何传入、下载与元数据怎么写、分页怎么实现。全部函数签名（参数、返回类型、错误字符串）请查看 [Rhai 函数字典](/reference/rhai-dictionary/)。

插件包结构与打包请先看 [插件格式](/dev/format/)；爬虫后端的整体架构请看 [爬虫后端](/dev/crawler-backends/)。

---

## 脚本生命周期

`crawl.rhai` **没有 main 函数**，整份文件从上到下执行一次。顶层的 `set_header(...)`、`to(...)`、`for` 循环等都是脚本主体。

- 脚本**不应返回值**；若需提前退出，使用 `return;`（不是 `return [];`）。
- 下载类调用（`download_image` / `download_archive`）是**异步入队**：它们立即返回，真正的下载在后台工作线程进行。脚本无需等待即可继续。
- 函数失败时会返回错误字符串，可用 `?` 操作符向外传播。
- 任务被用户取消后，`add_progress` 与 `download_*` 的下一次调用会抛出 `"Task canceled"`，配合 `?` 可让脚本干净地中止。

```rust
to("https://example.com")?;  // 失败则停止执行并返回错误
```

---

## 日志

### `print(msg)`

输出到任务日志（级别 `print`），便于在任务面板查看脚本输出。

### `warn(msg)`

向任务日志写入 **warn** 级别消息，适合「数量不足」等业务警告。

```rust
if done < num_artworks {
    warn("排行榜实际获取数量少于请求上限");
}
```

---

## 页面导航

### `to(url)`

访问一个网页，将当前页面推入页面栈。

```rust
to("https://example.com");
to("/page2");  // 相对 URL，基于当前栈顶 URL 解析
```

若响应使用 gzip 压缩，底层会自动解压；`current_html()` 得到的是解压后的 HTML。

### `fetch_json(url)`

请求一个 JSON API，解析响应并返回 Rhai 值。**不入页面栈**（调用 `back()` 不会退回到此请求）。

```rust
let data = fetch_json("https://api.example.com/data");
let items = data["items"];
for item in items {
    download_image(item["url"]);
}
```

- JSON 对象 → 直接返回 Map
- JSON 数组/其他类型 → 包装在 `"data"` 键里

### `parse_json(text)`

解析 JSON 字符串并返回 Rhai 值（不发起网络请求，不修改页面栈）。

```rust
let scripts = query("script[type=\"application/ld+json\"]");
for s in scripts {
    let parsed = parse_json(s);
    let arr = parsed["data"];
    if arr != () {
        for item in arr {
            download_image(item["contentUrl"]);
        }
    }
}
```

### `back()`

返回上一页，从页面栈中弹出当前页面。

```rust
to("https://example.com/page1");
to("https://example.com/page2");
back(); // 返回到 page1
```

---

## 页面信息

### `current_url()`

获取当前栈顶页面的 URL（字符串）。

### `current_html()`

获取当前栈顶页面的 HTML 内容（字符串）。

### `current_headers()`

获取当前栈顶页面最后一次成功 HTTP 响应的响应头（Map，键为小写 header 名）。可与 `set_header` 配合解析 cookie。

### `md5(text)`

计算 UTF-8 字符串的 MD5，返回小写十六进制字符串（32 位）。

---

## 元素查询

### `query(selector)`

在当前页面查询元素文本内容，返回字符串数组。支持 CSS 选择器和 XPath（以 `/` 或 `//` 开头）。

```rust
let titles = query("h1.title");
let all_divs = query("//div");
```

### `query_by_text(text)`

通过文本内容查找包含该文本的所有元素，返回包含 `text`、`tag`、`attrs`、`id`、`class` 的 Map 数组。

```rust
let elements = query_by_text("下一页");
for el in elements {
    if el["tag"] == "a" {
        to(el["attrs"]["href"]);
    }
}
```

### `find_by_text(text, tag)`

在指定标签中查找包含指定文本的元素，返回文本内容数组。

```rust
let links = find_by_text("下一页", "a");
```

### `get_attr(selector, attr)`

获取指定元素的属性值，返回字符串数组。

```rust
let image_urls = get_attr("img", "src");
let link_urls = get_attr("a", "href");
```

---

## URL 处理

### `resolve_url(relative)`

将相对 URL 解析为绝对 URL（基于当前栈顶的 URL）。

```rust
to("https://example.com/page1");
let full = resolve_url("/page2");        // "https://example.com/page2"
let full2 = resolve_url("image.jpg");   // "https://example.com/page1/image.jpg"
```

### `is_image_url(url)`

检查 URL 是否是图片 URL（根据扩展名或关键字判断），返回 bool。

```rust
if is_image_url(full_url) {
    download_image(full_url);
}
```

### `url_encode(s)`

对字符串进行 URL 百分号编码。

```rust
let kw = url_encode("关键词 测试");
let url = "https://example.com/search?q=" + kw;
```

### `re_is_match(pattern, text)`

使用正则表达式判断 `text` 是否匹配 `pattern`（Rust regex 语法），返回 bool。不合法的 pattern 返回 `false`。

```rust
print(re_is_match("^https://", "https://example.com"));  // true
```

### `re_replace_all(pattern, replacement, text)`

对 `text` 做全局正则替换，返回新字符串。支持捕获组占位符（`$1` 等）。不合法的 pattern 返回原始 `text`。

```rust
let full = re_replace_all("_\\d+x\\d+", "_1920x1080", thumb_url);
```

---

## HTTP 头

### `set_header(key, value)`

设置一个 HTTP Header（覆盖同名值），影响当前任务中由 Rhai 发起的所有 HTTP 请求。

```rust
set_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
set_header("Authorization", "Bearer " + token);
```

### `del_header(key)`

删除一个 HTTP Header。

---

## 图片处理

### `download_image(url)` / `download_image(url, opts)`

下载图片或视频并添加到下载队列。

| 参数 | 说明 |
|------|------|
| `url` (string) | 资源 URL |
| `opts.name` (string, 可选) | 图库中的展示名称，省略时使用文件名 |
| `opts.metadata` (map, 可选) | 可序列化的元数据，由插件详情模板渲染 |

```rust
// 仅 URL
download_image("https://example.com/a.jpg");

// 带名称
download_image("https://example.com/a.jpg", #{ name: "角色名 - 场景标题" });

// 带 metadata
download_image("https://example.com/a.jpg", #{
    name: "标题",
    metadata: #{ source: "某站", score: 95 }
});

// 也可下载视频
download_image("https://example.com/video.mp4");
```

### `download_archive(url, type)`

导入压缩包（异步处理）。

```rust
// 自动检测类型（推荐）
download_archive("https://example.com/pack.zip", ());

// 指定类型
download_archive("D:\\Downloads\\pack.rar", "rar");
```

### `get_supported_archive_types()`

获取当前系统支持的压缩包类型列表，返回字符串数组（如 `["rar", "zip"]`）。

---

## 元数据白名单

`metadata` 会被序列化后写入 `images.metadata`，并在插件详情面板由 `templates/description.ejs` 渲染。

:::caution
**只有你显式列出的字段会入库，请不要把上游 API 的整个 `body` 原样塞进去。**
:::

庞大的 `metadata` 会显著拖慢图库列表查询。正确做法是：在脚本里定义一个修剪函数，只保留 `description.ejs` 真正会用到的字段。

```rust
fn trim_body(raw) {
    #{
        id: raw["id"],
        title: raw["title"],
        userName: raw["userName"],
        tags: raw["tags"],
    }
}

download_image(url, #{
    name: raw["title"],
    metadata: trim_body(raw),
});
```

可参考 `src-crawler-plugins/plugins/pixiv/crawl.rhai` 中的 `trim_body` 作为实作范本。

:::note
对 Pixiv 插件的历史数据，运行时会执行一次 `pixiv_metadata_trim_v1` 迁移自动收敛；但**新插件必须在写入时就完成裁剪**，不要依赖迁移。
:::

---

## 分页：`next` 游标模式

基于 JSON API 的列表接口通常用**接口自身的 `next` 字段**来驱动翻页，而不是靠"item 数量为 0 就停"来猜。

典型循环形如：

```rust
let p = 1;
let done = 0;
loop {
    let json = fetch_json(`https://api.example.com/list?p=${p}`);
    let items = json["items"];
    for item in items {
        if done >= num_artworks { break; }
        download_image(item["url"], #{ metadata: trim_body(item) });
        done += 1;
        add_progress(99.0 / num_artworks);
    }
    let next = json["next"];
    if done >= num_artworks || type_of(next) == "bool" {
        break;
    }
    p = next;
}

if done < num_artworks {
    warn(`实际获取 ${done} 张，少于请求的 ${num_artworks}`);
}
```

要点：

- `next` 通常是**下一页的页码**（整数）或 `false`（到底了）。遇到 `false`/非数字就停。
- 达不到用户请求数量时，用 `warn(...)` 明确告知，不要静默中止。
- `add_progress(99.0 / total)` 让进度条匹配实际工作量。

完整示例见 `src-crawler-plugins/plugins/pixiv/crawl.rhai`（Pixiv 排行榜 / 用户画作）与 `src-crawler-plugins/plugins/konachan/crawl.rhai`（标签搜索）。

---

## 实用函数速览

以下函数同样注册在 Rhai 引擎中，完整签名请查 [Rhai 函数字典](/reference/rhai-dictionary/)。

| 函数 | 用途 |
|------|------|
| `sleep(secs)` | **阻塞**当前任务线程若干秒，上限 300s。用于限速等简单场景 |
| `rand_f64(min, max)` | 返回区间内的随机浮点数，常配合 `sleep` 做抖动 |
| `unix_time_ms()` | 当前 Unix 毫秒时间戳，适合生成签名、nonce |
| `xhh_nonce(t)` / `xhh_hkey(path, t, nonce)` | 小红书 X-s / X-t 签名算法（插件自用） |
| `is_video_url(url)` / `is_media_url(url)` | `is_image_url` 的同族判断，用于区分视频或通用媒体 |
| `create_image_metadata(map)` | 预先往 `images_metadata` 表插入一行并返回 `i64`；可作为 `download_image(url, #{ metadata_id })` 的高级用法，适合一份 metadata 被多张图片共享的场景 |

:::note
`download_image` 能接受视频 URL——函数名仅为历史遗留。不要用 `is_image_url` 过滤视频资源。
:::

---

## 进度与控制

### `add_progress(percentage)`

累加任务运行进度（单位为 %），进度自动限制在 0–99.9%，任务成功完成时自动设置为 100%。

```rust
add_progress(10);  // 增加 10%
```

### `list_local_files(folder_url, extensions, recursive)`

列出本地文件夹内的文件。`folder_url` 应为 `file:///` 开头的 URL，`extensions` 为文件扩展名数组（不含点号），`recursive` 为 bool，控制是否递归进入子目录。返回文件 URL 数组，错误时抛出异常。

```rust
let files = list_local_files("file:///D:/images", ["jpg", "png"], true);
```

---

## WebView 爬虫 API（crawl.js）

当插件提供 `crawl.js` 且在桌面端运行时，会使用 WebView 后端（Tauri WebView）。脚本运行在浏览器环境中，通过注入的 `ctx`（即 `window.__crawl_ctx__`）访问与 Rhai 对等的 API。

### 导航与页面

| 方法 | 说明 |
|------|------|
| `ctx.to(payload, opts?)` | 导航到新 URL，`payload` 可为字符串或 `{ url, pageLabel?, pageState? }` |
| `ctx.back(count?)` | 返回上一页，`count` 默认为 1 |
| `ctx.updatePageState(patch)` | 合并更新当前页状态 |
| `ctx.updateState(patch)` | 合并更新整个任务状态 |

### DOM 与工具

| 方法 | 说明 |
|------|------|
| `ctx.$(selector)` | `document.querySelector` |
| `ctx.$$(selector)` | `document.querySelectorAll` 的数组 |
| `ctx.waitForDom()` | 等待 `DOMContentLoaded` 的 Promise |

### 进度与下载

| 方法 | 说明 |
|------|------|
| `ctx.addProgress(percentage)` | 累加任务进度 |
| `ctx.downloadImage(url, opts?)` | 加入下载队列，`opts` 支持 `cookie`、`headers`、`name`、`metadata` |

### 日志与生命周期

| 方法 | 说明 |
|------|------|
| `ctx.log(message, level?)` | 输出任务日志 |
| `ctx.sleep(ms)` | 延迟指定毫秒的 Promise |
| `ctx.exit()` | 结束爬虫任务（逻辑完成或未知分支时调用） |
| `ctx.error(message)` | 以错误信息结束任务 |
| `ctx.requestShowWebview()` | 请求显示爬虫 WebView 窗口（如验证码场景） |

---

## 完整示例

```rust
// crawl.rhai 最小示例
let start_url = "https://example.com/gallery";
to(start_url);

let image_urls = get_attr("img", "src");
for src in image_urls {
    let full_url = resolve_url(src);
    if is_image_url(full_url) {
        download_image(full_url);
    }
}

// 翻页
let next_links = query_by_text("下一页");
for link in next_links {
    if link["tag"] == "a" {
        let next_url = resolve_url(link["attrs"]["href"]);
        to(next_url);
        break;
    }
}
```

---

## 注意事项

1. `to()` 入栈，`fetch_json()` / `parse_json()` 不入栈，`back()` 仅对 `to()` 打开的页面有效。
2. `fetch_json` 与 `parse_json` 对**非对象**的 JSON 根会自动包一层 `"data"` 键；抓数组接口时记得用 `json["data"]` 取值。
3. `set_header` 会**静默丢弃**非法的 header 名/值——只在任务日志写一条 warn，脚本无法编程判断。
4. `sleep(secs)` 是阻塞调用且被强制裁剪到 300s，仅适合简单限速，不是通用的异步延迟。
5. 任务取消后 `add_progress` / `download_*` 会抛 `"Task canceled"`，用 `?` 传播即可让脚本干净退出。

---

## 延伸阅读

- [插件格式](/dev/format/) — `.kgpg` 布局与 `crawl.rhai` 的位置
- [爬虫后端](/dev/crawler-backends/) — Rhai 与 WebView 两种后端的选型
- [Rhai 函数字典](/reference/rhai-dictionary/) — 全部函数的签名、返回类型与错误字符串
