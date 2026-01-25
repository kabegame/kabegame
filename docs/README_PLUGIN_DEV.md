# 插件开发指南

## 插件目录结构

插件位于 `crawler-plugins/plugins/` 目录下，每个插件应该是一个独立的文件夹。

### 示例插件结构

```
crawler-plugins/plugins/
└── sample-collector/
    ├── manifest.json    # 必需：插件元数据
    ├── icon.png         # 可选：插件图标（仅支持 PNG）
    ├── config.json      # 可选：插件配置
    ├── crawl.rhai       # 必需：爬取脚本（Rhai 脚本格式）
    ├── doc_root/        # 可选：文档目录
    │   └── doc.md       # 可选：用户文档
    └── README.md        # 可选：开发文档
```

## 打包插件

### 在主项目中打包

在主项目根目录执行：

```powershell
# 打包所有插件
pnpm run package-plugin

# 或使用 Nx 命令
nx run crawler-plugins:package

# 打包本地插件（仅打包 local-import）
pnpm run package-plugin:local
# 或
nx run crawler-plugins:package-local
```

### 在插件仓库中打包

在 `crawler-plugins/` 目录下执行：

```powershell
# 打包所有插件
node package-plugin.js
# 或
pnpm run package

# 打包指定插件
node package-plugin.js <插件名称>
# 例如：
node package-plugin.js anihonet-wallpaper

# 只打包指定插件（会清理 packed 目录下的其它 .kgpg）
node package-plugin.js --only <插件名1> <插件名2>
# 或使用逗号分隔
node package-plugin.js --only local-import

# 指定输出目录
node package-plugin.js --outDir ../data/plugins-directory
```

打包后的文件将生成在 `crawler-plugins/packed/<插件名称>.kgpg`。
（KGPG v2 下 `crawler-plugins/packed/` 可直接提交到仓库，用于 GitHub 发布时直接上传/引用。）

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
      "key": "start",
      "type": "int",
      "name": "起始页面",
      "descripts": "要拉取的起始页面",
      "default": 1,
      "min": 1,
      "max": 5
    },
    {
      "key": "ens",
      "type": "int",
      "name": "最大页数",
      "descripts": "爬取的结束页面",
      "default": 5,
      "min": 1,
      "max": 5
    }
  ]
}
```

**变量定义说明：**
- `var` 字段是数组格式，可以保持变量定义的顺序
- 每个变量定义包含：
  - `key`: 变量名（在脚本中使用）
  - `type`: 变量类型（`int`、`float`、`options`、`boolean`、`list`、`checkbox`）
  - `name`: 展示给用户的名称
  - `descripts`: 描述（可选）
  - `default`: 默认值（可选）
  - `options`: 选项列表（不同类型规则不同，见下）
  - `min`: 最小值（可选，仅用于 `int` 和 `float` 类型）
  - `max`: 最大值（可选，仅用于 `int` 和 `float` 类型）

**options（单选）说明：**
- `options` 推荐使用：`[{ "name": "...", "variable": "..." }]`
- UI 显示 `name`，实际传入脚本 / 保存配置的是 `variable`
- 兼容旧格式：`["high","low"]`（等价于 name=variable）

**list（字符串列表）说明：**
- `list` 的值是一个**可变长的字符串数组**，例如：`["jpg","png"]`
- `options`（可选）用于提供“可选项/建议项”，应保持为 `string[]`，例如：`["jpg","png","webp"]`
- 不要把 `list.options` 改成 `{name, variable}`，否则会误导成“固定枚举”

**checkbox（多选）说明：**
- 前端 UI 会渲染为复选框组（多选）
- 保存到后端 / 脚本的值是一个“对象（bool map）”，例如：
  - 定义（推荐）：`{ "key": "foo", "type": "checkbox", "options": [ { "name": "A", "variable": "a" }, { "name": "B", "variable": "b" } ] }`
  - 兼容旧格式：`{ "key": "foo", "type": "checkbox", "options": ["a","b"] }`（等价于 name=variable）
  - 传入脚本：`foo.a`、`foo.b` 都是布尔值
  - 保存/传参示例：`{ "foo": { "a": true, "b": false } }`
- `default` 支持两种写法：
  - 数组：`["a","b"]`（表示默认勾选的项）
  - 对象：`{ "a": true, "b": false }`

**注意**：选择器（如 `imageSelector`、`nextPageSelector`）现在不再在 `config.json` 中配置，而是在 `crawl.rhai` 脚本中由用户自己定义。这样提供了更大的灵活性。

### crawl.rhai（必需）

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
- `set_concurrency(limit)` - 设置当前任务的最大并发下载数量（`limit` 必须大于 0）
- `set_interval(ms)` - 设置当前任务下载请求之间的最小间隔时间（毫秒）
- `add_progress(percentage)` - 增加任务运行进度（单位为%，累加）。进度会自动限制在 0-99.9% 之间，任务成功完成时会自动设置为 100%
- `list_local_files(folder_url, extensions)` - 列出本地文件夹内的文件（非递归）。`folder_url` 应为 `file:///` 开头的 URL，`extensions` 为文件扩展名数组（不包含点号）。返回文件 URL 数组，错误时抛出异常

**重要提示：**
- 脚本作用域会自动注入 `config.json` 的变量（`var` 定义 + 用户输入）。
- 如果 `config.json` 中存在 `baseUrl`，后端还会额外注入常量变量 `base_url`（字符串）。若用户配置/变量系统已提供同名 `base_url`，则不会被插件的 `baseUrl` 覆盖。
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

