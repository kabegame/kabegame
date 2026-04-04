# Pixiv 插件 metadata 入库策略

## 要点

- **来源**：`src-crawler-plugins/plugins/pixiv/crawl.rhai` 中 `pixiv_trim_illust_body`，在 `download_image` 前从 `/ajax/illust/{id}` 的 `body` 裁剪为 **EJS 白名单字段**（与 `templates/description.ejs` 展示一致）。
- **目的**：避免整份 API `body`（含 `userIllusts`、`zoneConfig`、`extraData` 等）写入 `images.metadata`，减轻画廊/画册列表查询读库与 IPC 体积。
- **存量数据**：启动时 `Storage` 在 `perform_complex_migrations` 中通过 `_kabegame_migrations` 表记录 `pixiv_metadata_trim_v1`，对 `plugin_id = 'pixiv'` 且含 `metadata.body` 的行执行一次性裁剪（实现见 `kabegame_core::storage::images::migrate_pixiv_metadata_trim`）。

## 涉及文件

| 层级 | 文件 |
|------|------|
| 爬取入库 | `src-crawler-plugins/plugins/pixiv/crawl.rhai` |
| 详情模板 | `src-crawler-plugins/plugins/pixiv/templates/description.ejs` |
| 迁移 | `src-tauri/core/src/storage/mod.rs`、`src-tauri/core/src/storage/images.rs` |
