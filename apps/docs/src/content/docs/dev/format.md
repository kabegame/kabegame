---
title: 插件格式（.kgpg）
description: Kabegame KGPG v3 插件文件结构与 HTTP Range 读取规范。
---

Kabegame 插件以 `.kgpg` 文件分发，本质上是一个 ZIP 压缩包，内部包含元数据、爬取脚本与可选资源。本页说明格式的心智模型与每类条目的用途；字段的完整定义请看 [插件字段表](/reference/plugin-schema/)。

## 文件格式概述

`.kgpg` 只支持 **KGPG v3（固定头部 + ZIP）**：文件前面是只含 meta 与 icon 的固定头部，用于无需解压或通过 HTTP Range 读取 icon；后面是标准 ZIP body（SFX 兼容），插件清单由 ZIP 内 `package.json` 提供。

:::note
官方打包工具固定输出 v3，解析器也只接受容器版本 `3`。使用 [`dev/packaging`](/dev/packaging/) 描述的命令打包即可；固定头部由工具自动生成，通用 ZIP 工具仍可直接打开 ZIP body。
:::

---

## ZIP 内部结构

```
plugin-name.kgpg
    ├── package.json               # v3 自描述清单（必需）
    ├── crawl.rhai / crawl.js      # package.json main 指向的脚本
    ├── icon.png                   # 插件图标源文件（可选；打包后存于固定头部）
    ├── configs/*.json             # 推荐运行配置预设（可选）
    ├── metadata_migrations/
    │   └── v{N}.rhai              # 图片 metadata 迁移脚本（可选）
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
| `package.json` | 是 | v3 自描述清单，包含 name / version / `kbBackend` / `main` / `kbConfig` / `engines.kabegame` 等 |
| `main` 指向的脚本 | 是 | 爬取脚本；`kbBackend` 可为 `rhai`、`v8` 或 `webview`，Android 仅支持 Rhai |
| `icon.png` | 否 | 插件图标源文件；打包时转换为固定头部内的 RGB24 数据 |
| `configs/*.json` | 否 | 一组推荐预设，按文件名排序展示给用户一键应用 |
| `metadata_migrations/v{N}.rhai` | 否 | 历史图片 metadata 迁移脚本；`N` 为从 1 开始的连续自然数版本 |
| `templates/description.ejs` | 否 | 图片详情区 HTML 模板；缺失时降级为原始 metadata 列表 |
| `doc_root/doc.md` · `doc_root/doc.<lang>.md` | 否 | 插件文档，多语言按文件名后缀区分（`default` / `zh` / `en` / `ja` / `ko` …） |
| `doc_root/<image>` | 否 | 文档引用的图片资源 |

:::caution
`doc_root/` 内资源有体积限制：**单文件 ≤ 2 MB、总和 ≤ 10 MB**。超限的文件会在打包或解析阶段被跳过。
:::

### package.json 最小示例

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "private": true,
  "name.zh": "我的插件",
  "description": "插件描述",
  "author": "作者名",
  "kbPackageVersion": 3,
  "engines": {
    "kabegame": ">=4.3.0"
  },
  "main": "crawl.js",
  "kbBackend": "v8",
  "kbBaseUrl": "https://example.com",
  "kbConfig": []
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

## KGPG v3 固定头部规范

固定头部总大小：**49216 bytes**

| 区域 | 大小 | 说明 |
|------|------|------|
| meta | 64 bytes | 偏移 `0..64`；文件魔数、版本、偏移等 |
| icon | 49152 bytes | 偏移 `64..49216`；128×128 RGB24 图像，行优先 |
| ZIP body | 其余字节 | 从偏移 `49216` 开始 |

### meta（64 bytes，小端）

| 字段 | 偏移 | 说明 |
|------|------|------|
| `magic` | `0..4` | 4B，固定 `"KGPG"` |
| `version` | `4..6` | u16，固定 `3` |
| `meta_size` | `6..8` | u16，固定 `64` |
| `icon_w` | `8..10` | u16，固定 `128` |
| `icon_h` | `10..12` | u16，固定 `128` |
| `pixel_format` | `12` | u8，固定 `1`（RGB24） |
| `flags` | `13` | u8，bit0: icon_present |
| 保留 | `14..16` | u16，填 0 |
| `zip_offset` | `16..24` | u64，固定等于 `49216` |
| 其余 | `24..64` | 保留，填 0 |

### HTTP Range 读取

| 用途 | Range |
|------|-------|
| 拉取完整头部（meta + icon） | `bytes=0-49215` |
| 仅拉取 icon | `bytes=64-49215` |

---

## v3 优势

1. **无需解压即可取 icon**：客户端只需读取固定偏移的数据块。
2. **支持 HTTP Range**：商店列表可只拉取头部，不再依赖额外的 `<id>.icon.png` 资产。
3. **保持 ZIP 兼容**：插件清单继续从 ZIP 内 `package.json` 读取，通用 ZIP 工具也能直接打开。

---

## 延伸阅读

- [打包插件](/dev/packaging/) —— 如何把目录打成 `.kgpg`
- [Rhai API 参考](/dev/rhai-api/) —— `crawl.rhai` 可用函数与类型
- [插件字段表](/reference/plugin-schema/) —— `package.json` / `configs/*.json` 完整字段与默认值
- [插件管理（用户视角）](/guide/plugins/) —— 用户如何安装、启用与配置插件
