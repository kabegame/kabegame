---
title: 插件清单与格式字段
description: kabegame 插件 `manifest.json` / `config.json` 字段速查
---

## .kgpg 目录结构

```text
plugin-name.kgpg
    ├── manifest.json
    ├── crawl.rhai 或 crawl.js
    ├── icon.png
    ├── config.json
    ├── configs/*.json
    ├── metadata_migrations/
    │   └── v{N}.rhai
    ├── doc_root/
    └── templates/description.ejs
```

`metadata_migrations/v{N}.rhai` 是可选的图片 metadata 迁移脚本，`N` 为从 `1` 开始的连续自然数版本。脚本契约见 [Rhai 脚本指南](/dev/rhai-api/#元数据迁移)。

## manifest.json 字段

| 字段 | 类型 | 必填 | 最低版本 | 说明 |
|---|---|---|---|---|
| _TBD_ | | | | |

## config.json 字段

| 字段 | 类型 | 必填 | 最低版本 | 说明 |
|---|---|---|---|---|
| _TBD_ | | | | |

完整字段定义与示例请参考 [插件格式](/dev/format/)，脚本端 API 请参考 [Rhai API](/dev/rhai-api/)。
