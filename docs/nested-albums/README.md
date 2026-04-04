# 嵌套画册实现说明（主题索引）

本目录按主题拆分，便于分阶段实现或分工协作。已定稿的产品语义见 [00-product-decisions.md](./00-product-decisions.md)，其它文件实现时需与之对齐。

| 文件 | 主题 |
|------|------|
| [00-product-decisions.md](./00-product-decisions.md) | 已定稿的产品语义（权威） |
| [01-data-model-and-migrations.md](./01-data-model-and-migrations.md) | 数据模型与 SQLite 迁移 |
| [02-storage-api.md](./02-storage-api.md) | Storage 层 API 与业务规则 |
| [03-tauri-ipc-cli.md](./03-tauri-ipc-cli.md) | Tauri 命令、IPC 与 CLI |
| [04-frontend-state-routing.md](./04-frontend-state-routing.md) | 前端 Pinia、路由与 URL |
| [05-gallery-imagequery.md](./05-gallery-imagequery.md) | 画廊查询与 `ImageQuery` / `album_source` |
| [06-virtual-drive.md](./06-virtual-drive.md) | 虚拟盘 Provider 与多级路径 |
| [07-wallpaper-and-consumers.md](./07-wallpaper-and-consumers.md) | 壁纸轮播与其它按画册 id 消费方 |
| [08-i18n-ui.md](./08-i18n-ui.md) | 国际化与界面交互 |

## 代码入口参考（扁平画册现状）

- 存储：`src-tauri/core/src/storage/albums.rs`
- 画册 Provider：`src-tauri/core/src/providers/albums.rs`
- 画廊查询组件：`src-tauri/core/src/storage/gallery.rs`（`album_source` 等）
- 主进程命令：`src-tauri/app-main/src/commands/album.rs`
- 前端画册 Store：`apps/main/src/stores/albums.ts`
- 画册详情路由：`apps/main/src/stores/albumDetailRoute.ts`、`apps/main/src/utils/albumPath.ts`
