---
title: 插件清单与格式字段
description: kabegame 插件 `package.json` 字段速查
---

## .kgpg 目录结构

```text
plugin-name.kgpg
    ├── package.json
    ├── crawl.rhai 或 crawl.js
    ├── icon.png
    ├── configs/*.json
    ├── metadata_migrations/
    │   └── v{N}.rhai
    ├── doc_root/
    └── templates/description.ejs
```

`metadata_migrations/v{N}.rhai` 是可选的图片 metadata 迁移脚本，`N` 为从 `1` 开始的连续自然数版本。脚本契约见 [Rhai 脚本指南](/dev/rhai-api/#元数据迁移)。

## package.json 字段

| 字段 | 类型 | 必填 | 最低版本 | 说明 |
|---|---|---|---|---|
| `name` | string | 是 | 4.3.0 | 插件包名，必须等于插件目录名和输出 `.kgpg` stem。 |
| `version` | string | 是 | 4.3.0 | 插件 semver。 |
| `kbPackageVersion` | number | 是 | 4.3.0 | 当前为 `3`。 |
| `engines.kabegame` | string | 是 | 4.3.0 | 最低 Kabegame 版本，如 `>=4.3.0`。 |
| `main` | string | 是 | 4.3.0 | 插件根相对脚本路径。 |
| `kbBackend` | string | 是 | 4.3.0 | `rhai`、`v8` 或 `webview`。JS 插件默认使用 `v8`。 |
| `kbBaseUrl` | string | 否 | 4.3.0 | 采集入口 URL。 |
| `kbConfig` | array | 否 | 4.3.0 | 采集对话框表单变量。 |

完整字段定义与示例请参考 [插件格式](/dev/format/)，脚本后端选择请参考 [爬虫后端](/dev/crawler-backends/)。
