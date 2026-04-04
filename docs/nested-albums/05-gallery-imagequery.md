# 画廊查询与 `ImageQuery` / `album_source`

## 文档参考

`cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` 描述了 `ImageQuery` 与组件化 SQL 片段。

## 与产品语义的关系

[00-product-decisions.md](./00-product-decisions.md) 约定：**打开画册**时只展示**本层直接关联的图片**（外加子画册入口），**不做子树图片聚合**。因此用于「当前画册网格/列表」的查询，仍以**单个 `album_id` + 仅本层 `album_images`** 为主，与现有 `album_source(album_id)` 思路一致。

## 代码位置

- 核心：`src-tauri/core/src/storage/gallery.rs`（`album_source(album_id)` 等）。
- 画册 Provider：`src-tauri/core/src/providers/albums.rs`（与虚拟盘列表相关）。

## 与其它能力的区分

以下能力**不是**「打开画册」的同一件事，需单独实现，避免混进默认 `album_source`：

| 能力 | 语义 |
|------|------|
| 画册预览缩略图 | 浅层优先，不足 3 张时向子画册预览借图并均匀分配（见 00 §3） |
| 壁纸轮播 | 可选包含子画册，默认包含；递归后 **去重**（见 00 §4） |
| 可选：全树图片数 | 若 UI 需要展示「含子树的总张数」，用单独计数查询，勿与列表混用 |

若未来存在「仅统计本层张数」与「含子树张数」两种展示，SQL 与缓存键需区分。
