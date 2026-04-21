---
title: 插件格式（.kgpg）
description: Kabegame 插件文件格式规范，包括 KGPG v1/v2 文件结构与 HTTP Range 读取。
---

## 文件格式概述

插件文件扩展名为 `.kgpg`，目前支持两种格式：

- **KGPG v1（纯 ZIP）**：文件内容就是标准 ZIP。
- **KGPG v2（固定头部 + ZIP）**：文件前面加一个固定大小头部（用于无需解压/可 HTTP Range 读取 icon + manifest），后面仍然是标准 ZIP（SFX 兼容）。

---

## ZIP 内部结构

```
plugin-name.kgpg
    ├── manifest.json          # 插件元数据（必需）
    ├── crawl.rhai             # 爬取脚本（必需）
    ├── icon.png               # 插件图标（可选；v1 放在 ZIP 内，v2 放在固定头部）
    ├── config.json            # 插件配置（可选）
    ├── doc_root/              # 文档目录（可选）
    │   └── doc.md             # 插件文档，Markdown/GFM，路径仅允许 doc_root 内
    ├── configs/               # 推荐配置（可选）
    └── templates/             # 插件模板（可选）
        └── description.ejs    # 图片详情页 HTML 模板
```

### manifest.json 格式

```json
{
  "name": "插件名称",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名"
}
```

### templates/description.ejs

由 `ImageDetailContent.vue` 用 EJS 将 `metadata` 渲染为 HTML 后写入 iframe `srcdoc`。

框架在模板内容**之前**自动注入脚本，提供 `window.__bridge.fetch(url, options)`（如 `headers`、`json: true` 解析 JSON）：通过 `postMessage` 由主窗口调用 Tauri 命令 `proxy_fetch` 发起 HTTP GET，绕过浏览器 CORS；插件模板内可直接调用，无需手写 postMessage。

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

### HTTP Range 读取

| 用途 | Range |
|------|-------|
| 拉取完整头部（icon + manifest） | `bytes=0-53311` |
| 仅拉取 icon | `bytes=64-49215` |
| 仅拉取 manifest 槽位 | `bytes=49216-53311` |

---

## v2 优势

1. **无需解压即可取 icon/manifest**：客户端只需读取固定偏移的数据块
2. **支持 HTTP Range**：商店列表可只拉取头部，不再依赖额外的 `<id>.icon.png` 资产
3. **保持 ZIP 兼容**：旧逻辑仍可当作 ZIP 读取 `manifest.json/icon.png` 等条目
