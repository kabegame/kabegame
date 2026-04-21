---
title: 插件开发指南
description: 从零开始开发 Kabegame 爬虫插件，包括目录结构、配置文件和爬取脚本。
---

## 插件目录结构

每个插件是一个独立的文件夹，包含以下文件：

```
sample-collector/
├── manifest.json    # 必需：插件元数据
├── icon.png         # 可选：插件图标（仅支持 PNG）
├── config.json      # 可选：插件配置与变量定义
├── crawl.rhai       # 必需：爬取脚本（Rhai 脚本格式）
├── doc_root/        # 可选：文档目录
│   └── doc.md       # 可选：用户文档（Markdown）
└── README.md        # 可选：开发文档
```

---

## manifest.json（必需）

```json
{
  "name": "插件名称",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名"
}
```

---

## config.json（可选）

定义插件的配置变量，这些变量会在收集对话框中以表单形式展示给用户。

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
      "key": "keyword",
      "type": "string",
      "name": "搜索关键词",
      "descripts": "要搜索的关键词"
    }
  ]
}
```

### 变量类型

| type | 说明 | 在脚本中的形态 |
|------|------|----------------|
| `int` | 整数 | 数字 |
| `float` | 浮点数 | 数字 |
| `string` | 单行文本 | 字符串 |
| `date` | 日期选择器 | 字符串（按 `format` 字段格式化，默认 `YYYY-MM-DD`） |
| `boolean` | 开关 | 布尔 |
| `options` | 单选下拉 | 字符串（variable 值） |
| `list` | 可变长字符串列表 | 字符串数组 |
| `checkbox` | 多选复选框 | 对象（bool map） |
| `path` / `file` / `folder` / `file_or_folder` | 路径选择器 | 字符串 |

### options（单选）

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

UI 显示 `name`，实际传入脚本的是 `variable`。

### checkbox（多选）

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

在脚本中通过 `wallpaper_type.desktop`、`wallpaper_type.mobile`（bool）访问。

### when（条件显示）

在 `var` 定义中可添加 `when` 字段，根据其他 options 变量的值控制该字段在表单中的显示：

```json
{
  "key": "artist_id",
  "type": "string",
  "name": "画师 UID",
  "when": { "source": ["user", "bookmark"] }
}
```

当 `source` 变量的当前值为 `"user"` 或 `"bookmark"` 时，该字段才显示。

---

## crawl.rhai（必需）

爬取脚本，使用 Rhai 脚本语言编写。脚本作用域会自动注入 `config.json` 的所有变量（`var` 定义 + 用户输入）。

### 页面栈机制

系统维护一个页面栈：

- `to(url)` — 访问一个网页，将当前页面推入栈
- `back()` — 返回上一页，从栈中弹出
- `query(selector)` 和 `get_attr(selector, attr)` 自动在栈顶页面执行

### 最小示例

```rust
// 访问起始页面
to("https://example.com/gallery");

// 获取所有图片的 src 属性
let image_urls = get_attr("img", "src");

for src in image_urls {
    let full_url = resolve_url(src);
    if is_image_url(full_url) {
        download_image(full_url);
    }
}
```

### 重要规则

- 脚本**不应该返回值**。如果需要提前退出，使用 `return;` 而不是 `return [];`
- 图片应该通过 `download_image()` 函数添加到下载队列，而不是通过返回值

完整 API 参见 [Rhai API](/dev/rhai-api/)。

---

## 打包插件

在 `src-crawler-plugins/` 目录下执行：

```bash
# 打包所有插件
bun package

# 打包指定插件
bun package <插件名称>

# 打包后生成在 packed/<插件名称>.kgpg
```

---

## 在应用中导入插件

打包后的 `.kgpg` 文件可以通过以下方式导入应用：

1. 双击 `.kgpg` 文件
2. 把 `.kgpg` 文件拖到主窗口中
3. 在「源管理」页面点击右上角的「导入源」按钮

详情见 [插件导入方法](/guide/plugins-usage/#插件导入方法)。
