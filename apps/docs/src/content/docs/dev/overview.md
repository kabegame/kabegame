---
title: 插件开发指南
description: 从零开始开发 Kabegame 爬虫插件，了解目录骨架、开发循环与发布方式。
---

Kabegame 的抓取能力全部由插件提供。一个插件是一个自包含的文件夹，描述「去哪里取图」以及「怎么把图取回来」。本页面帮你在 10 分钟内跑通一个插件的开发循环：从克隆仓库到在运行中的 Kabegame 看到自己的改动。

若你想了解 `.kgpg` 文件的二进制格式或 `manifest.json` 的完整字段，请看 [插件格式](/dev/format/)；若想查 Rhai 脚本里可用的函数，请看 [Rhai API](/dev/rhai-api/)。

## 什么是插件

一个插件告诉 Kabegame：

- **在哪里取图**：一个站点的入口 URL、可选的登录/筛选参数。
- **怎么取图**：一段脚本，负责遍历列表页、解析详情页、把图片 URL 交回应用。
- **怎么展示自己**：图标、多语言名称与描述、在「采集」对话框里要不要展示什么表单项。

脚本有两种后端可选：**Rhai**（推荐，内嵌脚本引擎，无 WebView）与 **JS**（运行在 WebView 中的 `crawl.js`，用于需要浏览器级登录态的站点）。两者的清单/资源结构相同，差异只在脚本文件。本页聚焦 Rhai，JS 后端详见 [爬虫后端](/dev/crawler-backends/)。

## 插件目录骨架

每个插件是 `src-crawler-plugins/plugins/` 下的一个子目录，目录名就是**插件 ID**（它会出现在 `.kgpg` 文件名、图片记录以及日志里）。

```
my-plugin/
├── manifest.json          # 必需：插件元数据
├── crawl.rhai             # 必需：Rhai 抓取脚本（JS 后端时换成 crawl.js）
├── icon.png               # 推荐：512×512 图标，商店列表按 HTTP Range 拉取
├── config.json            # 可选：采集对话框表单定义
├── configs/               # 可选：预设配置，出现在「预设」下拉里
│   └── <preset>.json
├── doc_root/              # 可选：用户文档，应用内渲染
│   ├── doc.md             #       默认
│   ├── doc.zh.md          #       各语言覆盖
│   └── doc.en.md
├── templates/             # 可选：EJS 模板
│   └── description.ejs    #       在源管理详情面板渲染 metadata
└── README.md              # 可选：开发者自用说明，不会被应用读取
```

### manifest.json（必需）

最小可用字段：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "you",
  "minAppVersion": "3.4.1"
}
```

- `id` 必须与目录名一致。
- `minAppVersion` 声明插件需要的最低 Kabegame 版本；低于该版本的应用会拒绝加载，避免调用不存在的 Rhai API。
- `name` / `description` 支持以点号展平的多语言键，例如 `"name.zh": "我的插件"`、`"description.ja": "..."`。

完整字段与 JSON Schema 见 [插件格式](/dev/format/)。

### config.json（可选）

定义采集对话框里的表单项。脚本运行时，每一个变量都会以同名 Rhai 变量的形式注入到 `crawl.rhai` 的作用域里。

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
      "name": "搜索关键词"
    }
  ]
}
```

#### 变量类型

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

#### options（单选）

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

#### checkbox（多选）

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

脚本中通过 `wallpaper_type.desktop`、`wallpaper_type.mobile`（布尔）访问。

#### when（条件显示）

在 `var` 定义中加 `when`，根据其他 options 变量的当前值决定该字段是否显示：

```json
{
  "key": "artist_id",
  "type": "string",
  "name": "画师 UID",
  "when": { "source": ["user", "bookmark"] }
}
```

当 `source` 变量当前取值为 `"user"` 或 `"bookmark"` 时，`artist_id` 才出现在表单里。

### crawl.rhai（必需）

Rhai 脚本，入口即全局作用域。`config.json` 里定义的每个 `var` 都会作为 Rhai 变量注入到当前脚本。

#### 页面栈机制

系统维护一个页面栈：

- `to(url)` — 访问一个网页，将当前页面推入栈。
- `back()` — 返回上一页，从栈中弹出。
- `query(selector)` 与 `get_attr(selector, attr)` 自动在栈顶页面执行。

#### 最小示例

```rust
to("https://example.com/gallery");

let image_urls = get_attr("img", "src");

for src in image_urls {
    let full_url = resolve_url(src);
    if is_image_url(full_url) {
        download_image(full_url);
    }
}
```

#### 重要规则

- 脚本**不要返回值**。提前退出用 `return;`，不要写 `return [];`。
- 图片通过 `download_image(url)` 加入下载队列，不要通过返回值传回。

完整函数清单见 [Rhai API](/dev/rhai-api/)。

## 开发循环

推荐在 Kabegame 主仓库内开发，这样可以直接享受自动打包与实时加载。

### 1. 克隆并把插件放进仓库

将你的插件目录放到 `src-crawler-plugins/plugins/<your-plugin-id>/`。可以从现有插件复制一份作为起点（见下文「从哪个插件开始读」）。

### 2. 启动开发服务

```bash
bun dev -c kabegame
```

这条命令本身就会触发插件打包：构建系统在每次 `bun dev -c kabegame` 启动时自动运行 `nx run crawler-plugins:package-to-dev-data`，把 `src-crawler-plugins/plugins/` 下的**每一个**插件打成 `.kgpg`，输出到 `<repo>/data/plugins-directory/`。应用启动时从该目录加载，你的插件会立刻出现在源列表里。

:::note
`--mode local` 是另一回事：它是 Rust 侧的构建开关，用于把所有插件**内嵌进发行版的二进制**，与开发循环无关。不加 `--mode local` 照样会打包插件到 `data/plugins-directory/`。
:::

### 3. 修改 → 重启

改完脚本或配置后**重启 `bun dev`**，仓库目录中的最新版本会被重新打包并加载。

:::caution
开发数据目录模式由 `--data` 控制，默认是 `dev`（使用仓库内 `data/`）。如果你传 `--data prod`（系统数据目录）测试已安装版本，请确认插件也放到了对应的系统目录下，否则它们不会出现。
:::

## 打包与发布

当你要把插件交付出去时，进入 `src-crawler-plugins/` 目录执行：

```bash
bun package                    # 打包全部插件到 packed/<id>.kgpg
bun package <插件名>           # 只打一个
bun package --only <a> <b>     # 打指定子集
bun package --out-dir <path>   # 改变输出目录
```

打包依赖编译好的 `kabegame-cli`（由主仓库的 `bun dev -c kabegame` 或 `bun b` 自动构建）。若你自建插件商店，还需要生成索引：

```bash
bun generate-index             # 读取 packed/*.kgpg，写出 packed/index.json
bun release                    # 等价于 bun package && bun generate-index
```

单独发布一个插件时可以跳过索引，直接分发 `.kgpg` 文件；用户在「源管理」页面拖入或「导入源」即可安装。详细格式与发布约定见 [插件格式](/dev/format/)。

## 从哪个插件开始读

仓库内置了 12 个插件作为参考实现，位于 `src-crawler-plugins/plugins/`：

`anihonet-wallpaper`、`anime-pictures`、`bilibili`、`heybox`、`konachan`、`miyoushe`、`pixai`、`pixiv`、`twodwallpapers`、`wallpapers-craft`、`wallspic`、`ziworld`。

推荐阅读顺序：

1. **`konachan`** — 纯 Rhai、无登录、无 WebView，同时覆盖 `configs/`、多语言 `doc_root/`、`templates/description.ejs`，与本页描述的骨架几乎一一对应。
2. **`anihonet-wallpaper`** — 仍是纯 Rhai，但有更多表单变量，适合学习 `options` / `checkbox` / `when` 的组合。
3. **`pixiv`** — 功能强大，但需要登录 cookie 与 R18 判定，作为第一份参考代码过于复杂；等你熟悉基本流程后再看。

若你的目标站点需要浏览器级登录态（例如必须执行站点的 JS 才能拿到真实地址），那它适合 JS 后端：可以参考 `bilibili`、`heybox`、`miyoushe` 等带 `crawl.js` 的插件，细节见 [爬虫后端](/dev/crawler-backends/)。

## 在应用中导入插件

打包好的 `.kgpg` 文件可以：

1. 双击 `.kgpg` 文件（仅桌面）。
2. 把 `.kgpg` 拖到主窗口中（仅桌面）。
3. 在「源管理」页点击右上角「导入源」按钮（全平台）。

详情见 [插件导入方法](/guide/plugins-usage/#插件导入方法)。

## 延伸阅读

- [插件格式](/dev/format/) — `.kgpg` 二进制结构、`manifest.json` 完整字段。
- [Rhai API](/dev/rhai-api/) — `crawl.rhai` 里可用的全部函数。
- [爬虫后端](/dev/crawler-backends/) — Rhai 与 JS 两种后端的选择与差异。
- [插件导入方法](/guide/plugins-usage/#插件导入方法) — 用户侧安装流程。
