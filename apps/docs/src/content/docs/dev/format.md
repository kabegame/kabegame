---
title: 插件格式（.kgpg）
description: Kabegame 插件文件格式规范，包括 KGPG v1/v2 文件结构与 HTTP Range 读取。
---

Kabegame 插件以 `.kgpg` 文件分发，本质上是一个 ZIP 压缩包，内部包含元数据、爬取脚本与可选资源。本页说明格式的心智模型与每类条目的用途；字段的完整定义请看 [插件字段表](/reference/plugin-schema/)。

## 文件格式概述

`.kgpg` 目前有两种格式：

- **KGPG v1（纯 ZIP）**：文件内容就是标准 ZIP。
- **KGPG v2（固定头部 + ZIP）**：文件前面加一个固定大小头部（用于无需解压/可 HTTP Range 读取 icon + manifest），后面仍然是标准 ZIP（SFX 兼容）。

:::note
当前官方打包工具默认输出 v2；解析器仍兼容 v1。你不需要在两种格式间做选择——用 [`dev/packaging`](/dev/packaging/) 描述的命令打包即可，v2 头部由工具自动生成。v2 对通用 ZIP 工具透明，`unzip plugin.kgpg` 仍可直接打开。
:::

---

## ZIP 内部结构

```
plugin-name.kgpg
    ├── manifest.json              # 插件元数据（必需）
    ├── crawl.rhai                 # 爬取脚本（Rhai）
    ├── crawl.js                   # 爬取脚本（JS，仅桌面，与 crawl.rhai 二选一）
    ├── icon.png                   # 插件图标（可选；v2 另存于固定头部）
    ├── config.json                # 插件运行时变量与 baseUrl（可选）
    ├── configs/*.json             # 推荐运行配置预设（可选）
    ├── doc_root/                  # 插件文档目录（可选）
    │   ├── doc.md                 # 默认语言文档（GFM Markdown）
    │   ├── doc.<lang>.md          # 其它语言文档，如 doc.zh.md / doc.en.md
    │   └── <image>                # 文档引用的资源（jpg/jpeg/png/gif/webp/bmp）
    └── templates/
        └── description.ejs        # 图片详情页 HTML 模板（可选）
```

插件解析器识别以下条目（其余文件会被忽略）：

| 条目 | 必需 | 作用 |
|------|------|------|
| `manifest.json` | 是 | 插件元数据（name / version / description / author / `minAppVersion` 等） |
| `crawl.rhai` 或 `crawl.js` | 必有其一 | 爬取脚本；Android 仅支持 Rhai |
| `icon.png` | 否 | 插件图标；v2 若头部已有 icon 则优先使用头部数据 |
| `config.json` | 否 | 定义 `baseUrl` 与用户可配置变量（`var[]`） |
| `configs/*.json` | 否 | 一组推荐预设，按文件名排序展示给用户一键应用 |
| `templates/description.ejs` | 否 | 图片详情区 HTML 模板；缺失时降级为原始 metadata 列表 |
| `doc_root/doc.md` · `doc_root/doc.<lang>.md` | 否 | 插件文档，多语言按文件名后缀区分（`default` / `zh` / `en` / `ja` / `ko` …） |
| `doc_root/<image>` | 否 | 文档引用的图片资源 |

:::caution
`doc_root/` 内资源有体积限制：**单文件 ≤ 2 MB、总和 ≤ 10 MB**。超限的文件会在打包或解析阶段被跳过。
:::

### manifest.json 最小示例

```json
{
  "name": "插件名称",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名"
}
```

完整字段（多语言 name/description、`minAppVersion` 等）见 [插件字段表](/reference/plugin-schema/)。

### templates/description.ejs

由 `ImageDetailContent.vue` 用 EJS 将 `metadata` 渲染为 HTML 后写入 iframe `srcdoc`。`metadata` 的来源是爬虫在 `download_image(..., { metadata })` 时写入的 `image_metadata` 行；描述页模板随插件元数据一起被加载到内存，由前端直接消费。

模板渲染时只有一个变量 `metadata`：

```ejs
<h3><%= metadata.title %></h3>
<p>作者：<a href="<%= metadata.authorUrl %>"><%= metadata.author %></a></p>
```

框架在模板内容**之前**自动注入脚本，提供以下全局能力（无需手写 `postMessage`）：

| API | 说明 |
|---|---|
| `window.__bridge.fetch(url, options)` | 跨域 HTTP GET，走宿主 `proxy_fetch` 绕过浏览器 CORS；`options.headers` 可传 `Referer` 等，`options.json: true` 返回已解析 JSON，否则返回 `{ base64, contentType }`（适合图片字节）。单响应上限约 3 MB。 |
| `window.__bridge.getLocale()` | 返回应用当前语言（`en` / `zh` / `ja` / `ko` / `zhtw`），用于与远端 API 的 `lang` 参数对齐。 |
| `window.__bridge.openUrl(url)` | 在系统浏览器打开；仅支持 `http://` / `https://`。 |
| `<a href="https://...">` / `<a data-url="...">` | 自动桥接为 `openUrl`，点击即在外部浏览器打开，不需要手动绑定事件。 |

:::note
模板内的内联 `<script>` 需要 `nonce="kabegame-ejs-bridge"`（注入脚本已自动带上）以通过 CSP。
:::

若插件未提供 `description.ejs`，或 `metadata` 为空，详情区会回退到原始 k-v 列表显示。

---

## KGPG v2 固定头部规范

固定头部总大小：**53312 bytes**

| 区域 | 大小 | 说明 |
|------|------|------|
| meta | 64 bytes | 文件魔数、版本、偏移等 |
| icon | 49152 bytes | 128×128 RGB24 图像，行优先 |
| manifest | 4096 bytes | UTF-8 JSON，剩余用 `0x00` 填充 |

### meta（64 bytes，小端）

| 字段 | 大小 | 说明 |
|------|------|------|
| `magic` | 4B | 固定 `"KGPG"` |
| `version` | u16 | 固定 `2` |
| `meta_size` | u16 | 固定 `64` |
| `icon_w` | u16 | 固定 `128` |
| `icon_h` | u16 | 固定 `128` |
| `pixel_format` | u8 | 固定 `1`（RGB24） |
| `flags` | u8 | bit0: icon_present，bit1: manifest_present |
| `manifest_len` | u16 | 0–4096 |
| `zip_offset` | u64 | 当前固定等于 53312 |
| 其余 | — | 保留，填 0 |

:::caution
manifest 槽位上限为 4096 字节。多语言 `name` / `description` 过长会导致打包工具报错——建议把长文说明放到 `doc_root/doc.md`。
:::

### HTTP Range 读取

| 用途 | Range |
|------|-------|
| 拉取完整头部（icon + manifest） | `bytes=0-53311` |
| 仅拉取 icon | `bytes=64-49215` |
| 仅拉取 manifest 槽位 | `bytes=49216-53311` |

---

## v2 优势

1. **无需解压即可取 icon/manifest**：客户端只需读取固定偏移的数据块。
2. **支持 HTTP Range**：商店列表可只拉取头部，不再依赖额外的 `<id>.icon.png` 资产。
3. **保持 ZIP 兼容**：旧逻辑仍可当作 ZIP 读取 `manifest.json` / `icon.png` 等条目。

---

## 延伸阅读

- [打包插件](/dev/packaging/) —— 如何把目录打成 `.kgpg`
- [Rhai API 参考](/dev/rhai-api/) —— `crawl.rhai` 可用函数与类型
- [插件字段表](/reference/plugin-schema/) —— `manifest.json` / `config.json` / `configs/*.json` 完整字段与默认值
- [插件管理（用户视角）](/guide/plugins/) —— 用户如何安装、启用与配置插件
