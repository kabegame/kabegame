# Pixiv 插件 metadata 入库策略

## 要点

- **来源**：`src-crawler-plugins/plugins/pixiv/crawl.rhai` 中 `pixiv_trim_illust_body`，在 `download_image` 前从 `/ajax/illust/{id}` 的 `body` 裁剪为 **EJS 白名单字段**（与 `templates/description.ejs` 展示一致）。
- **目的**：避免整份 API `body`（含 `userIllusts`、`zoneConfig`、`extraData` 等）进入详情 metadata，减轻详情渲染与缓存体积。
- **入库路径**：`download_image` 入口会把插件传入的 raw JSON 写入 `image_metadata` 并转为 `metadata_id`；`images` 与 `task_failed_images` 只保存该 id。
- **存量数据**：v011 迁移会把旧 `images.metadata` 折叠进 `image_metadata`，按 `content_hash` 复用相同 JSON，然后删除旧列。
- **清理**：删除图片或放弃失败图片后，storage 会检查 `images` / `task_failed_images` 是否仍引用该 `metadata_id`；无引用时删除对应 `image_metadata` 行。

## 涉及文件

| 层级 | 文件 |
|------|------|
| 爬取入库 | `src-crawler-plugins/plugins/pixiv/crawl.rhai` |
| 详情模板 | `src-crawler-plugins/plugins/pixiv/templates/description.ejs` |
| 迁移 | `src-tauri/kabegame-core/src/storage/migrations/v011_consolidate_image_metadata_and_failed_display_name.rs` |
