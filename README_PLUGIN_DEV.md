# 插件开发指南

## 测试插件目录结构

测试插件位于 `test_plugin/` 目录下，每个插件应该是一个独立的文件夹。

### 示例插件结构

```
test_plugin/
└── sample-collector/
    ├── manifest.json    # 必需：插件元数据
    ├── config.json      # 可选：插件配置
    ├── doc.md          # 可选：用户文档
    ├── crawl.rhai      # 可选：爬取脚本（Rhai 脚本格式）
    └── README.md       # 可选：开发文档
```

## 打包插件

### 基本用法

```bash
# 打包指定插件目录
npm run package-plugin test_plugin/sample-collector

# 或指定输出文件
npm run package-plugin test_plugin/sample-collector output.kgpg
```

### 开发模式

在开发模式下，可以自动打包测试插件并启动应用：

```bash
npm run dev:package-plugin
```

这会：
1. 自动打包 `test_plugin/sample-collector` 为 `.kgpg` 文件
2. 启动 Tauri 开发模式

## 插件文件格式

### manifest.json（必需）

```json
{
  "name": "插件名称",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名"
}
```

### config.json（可选）

```json
{
  "baseUrl": "https://example.com",
  "var": [
    {
      "key": "start_page",
      "type": "int",
      "name": "起始页面",
      "descripts": "要拉取的起始页面",
      "default": 1
    },
    {
      "key": "max_pages",
      "type": "int",
      "name": "最大页数",
      "descripts": "最多爬取多少页",
      "default": 10
    },
    {
      "key": "image_quality",
      "type": "options",
      "name": "图片质量",
      "descripts": "选择图片质量",
      "options": ["high", "medium", "low"],
      "default": "high"
    }
  ]
}
```

**变量定义说明：**
- `var` 字段是数组格式，可以保持变量定义的顺序
- 每个变量定义包含：
  - `key`: 变量名（在脚本中使用）
  - `type`: 变量类型（`int`、`float`、`options`、`boolean`、`list`）
  - `name`: 展示给用户的名称
  - `descripts`: 描述（可选）
  - `default`: 默认值（可选）
  - `options`: 选项列表（`options` 和 `list` 类型必需）

**注意**：选择器（如 `imageSelector`、`nextPageSelector`）现在不再在 `config.json` 中配置，而是在 `crawl.rhai` 脚本中由用户自己定义。这样提供了更大的灵活性。

### crawl.rhai（可选）

爬取脚本，使用 Rhai 脚本语言编写。用户可以在脚本中自定义所有变量和爬取逻辑。

**页面栈机制：**
- 系统维护一个页面栈，初始为空
- `to(url)` - 访问一个网页，将当前页面推入栈
- `back()` - 返回上一页，从栈中弹出
- `query(selector)` 和 `get_attr(selector, attr)` 自动在栈顶页面执行

**可用函数：**
- `to(url)` - 访问网页并推入栈
- `back()` - 返回上一页
- `current_url()` - 获取当前栈顶的 URL
- `current_html()` - 获取当前栈顶的 HTML
- `query(selector)` - 在当前页面查询元素文本（支持 CSS 选择器和 XPath）
- `get_attr(selector, attr)` - 在当前页面获取元素属性（支持 CSS 选择器和 XPath）
- `resolve_url(relative)` - 解析相对 URL（基于当前栈顶 URL）
- `is_image_url(url)` - 检查是否是图片 URL
- `download_image(url)` - 下载图片并添加到 gallery，返回 `true` 表示成功，`false` 或错误表示失败
- `add_progress(percentage)` - 增加任务运行进度（单位为%，累加）。进度会自动限制在 0-99.9% 之间，任务成功完成时会自动设置为 100%
- `list_local_files(folder_url, extensions)` - 列出本地文件夹内的文件（非递归）。`folder_url` 应为 `file:///` 开头的 URL，`extensions` 为文件扩展名数组（不包含点号）。返回文件 URL 数组，错误时抛出异常

**重要提示：**
- 脚本**不应该返回值**。如果需要提前退出，使用 `return;` 而不是 `return [];` 或 `return value;`
- 图片应该通过 `download_image()` 函数添加到下载队列，而不是通过返回值

**示例：**

```rhai
// 定义起始 URL
let start_url = "https://example.com";

// 定义图片选择器（可以使用 CSS 选择器或 XPath）
// CSS 选择器：let image_selector = "img";
// XPath：let image_selector = "//img";
let image_selector = "img";

// 访问起始页面
to(start_url);

// 推荐方式：立即下载并添加到 gallery
// 在循环中直接调用 download_image，图片会立即下载并添加到 gallery
let img_srcs = get_attr(image_selector, "src");
for src in img_srcs {
    let full_url = resolve_url(src);
    if is_image_url(full_url) {
        if download_image(full_url) {
            print("下载成功: " + full_url);
        } else {
            print("下载失败: " + full_url);
        }
    }
}

// 注意：脚本不应该返回值，如果需要提前退出，使用 return; 而不是 return [];
// 例如：
// if some_condition {
//     print("错误信息");
//     return;  // 正确：不返回值
// }
```

**选择器格式说明：**
- **CSS 选择器**：标准的 CSS 选择器语法，如 `"img"`、`".class"`、`"#id"`、`"div > img"` 等
- **XPath**：以 `/` 或 `//` 开头的 XPath 表达式，如 `"//img"`、`"/html/body/img"`、`"//img[@class='photo']"` 等
- 系统会自动识别选择器类型（以 `/` 或 `//` 开头，或包含 `[@` 或 `::` 的视为 XPath）

## 在应用中使用

打包后的 `.kgpg` 文件可以通过应用的"导入收集源"功能导入使用。

