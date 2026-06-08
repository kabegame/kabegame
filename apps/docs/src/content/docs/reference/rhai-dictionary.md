---
title: Rhai API 字典
description: kabegame 爬虫插件可调用的 Rhai 函数速查
---

## 函数

| 函数 | 签名 | 说明 |
|---|---|---|
| `download_image` | `download_image(url)` / `download_image(url, opts)` | 将图片或视频加入下载队列。`opts.name` 设置展示名，`opts.metadata` 写入 `image_metadata`，`opts.metadata_version` 设置 metadata 版本（纯自然数，省略为 `0`）。 |
| `create_image_metadata` | `create_image_metadata(map)` / `create_image_metadata(map, #{ version: N })` | 预先写入一行 metadata 并返回 `metadata_id`。`version` 为纯自然数，省略为 `0`；返回值可传给 `download_image(url, #{ metadata_id })` 复用。 |
| `parse_json` | `parse_json(text)` | 解析 JSON 字符串为 Rhai 值。`crawl.rhai` 中非对象根会包装到 `data` 字段；`metadata_migrations/v{N}.rhai` 中直接返回对应 Rhai 值。 |
| `to_json` | `to_json(value)` | 将 Rhai 值序列化为 JSON 字符串。当前用于 `metadata_migrations/v{N}.rhai` 的 `migrate(metadata)` 返回值构造。 |

## Metadata 迁移速查

`metadata_migrations/v{N}.rhai` 脚本必须提供 `fn migrate(metadata)`，入参和返回值都是 JSON 字符串。运行时按连续版本从 `v1.rhai` 开始执行，失败的行会停在已成功版本，并在后续安装、更新或启动时重试。迁移后的行按 `(plugin_id, version, content_hash)` 去重；迁移成功会发出作用域为该插件的 `metadata-migrate` 图片变更事件。

迁移脚本可用纯数据辅助函数：`parse_json(text)`、`to_json(value)`、`re_is_match(pattern, text)`、`re_replace_all(pattern, replacement, text)`、`re_find_all(pattern, text)`。`re_find_all` 返回 capture map 数组，包含 `"0"`、`"1"` 等数字捕获键和命名捕获键。

## 延伸阅读

- [Rhai 脚本](/dev/rhai-api/)
- [开发总览](/dev/overview/)
