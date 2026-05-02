# 画廊分页与 SimplePage 图片加载数据流

本文档说明**主应用内**通过 `provider` 路径浏览图片列表时的分页、每页条数设置与前后端调用链，便于排查「翻页不对」「改每页条数不刷新」「列表为空」等问题。  
虚拟盘（VD）Greedy 目录树仍使用后端固定的 `LEAF_SIZE`（与 SimplePage 可配置页大小无关），详见下文「与 VD 的区别」。

## 与 `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 的关系

- `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 描述 **ImageQuery 如何组合**（JOIN / WHERE / ORDER）以及 Provider 解析与缓存。
- **本文档**描述：**路径 + 页码 + 每页条数** 如何落到 **一次浏览请求**（`browse_gallery_provider`）与前端 `offset` / 分页器对齐。

两者互补：查询语义见前者，分页与加载条数见本文。

## 核心概念

| 概念 | 说明 |
|------|------|
| **provider 路径** | 路由 `query.path`（如 `all/1`、`album/<uuid>/1`、`task/<id>/1`），末尾数字段为**逻辑页码**（第几页）。 |
| **SimplePage** | Provider 解析结果为「叶子」：`ProviderDescriptor::SimplePage { query, page }`。后端按 `ImageQuery` 计数 + **offset/limit** 取一页。 |
| **Greedy / 非 SimplePage** | 目录树、range 分解等；后端 `browse.rs` 内仍用固定 `LEAF_SIZE = 100` 做贪心分段，**不使用**用户配置的每页条数。 |
| **每页条数 `galleryPageSize`** | 用户设置 `100 / 500 / 1000`，持久化在 Rust `Settings`（JSON 键 `galleryPageSize`），仅影响 **SimplePage** 的 `limit` 与 offset 计算。 |

## 后端

### 命令：`browse_gallery_provider`

- **位置**：[`src-tauri/kabegame/src/commands/image.rs`](/src-tauri/kabegame/src/commands/image.rs)（Tauri 命令，参数 `page_size`）。
- **前端 invoke**：必须使用 **camelCase** 参数名 **`pageSize`**（与 Tauri 对前端参数名的约定一致），否则会出现缺少参数错误。
- **实现**：[`src-tauri/kabegame-core/src/gallery/browse.rs`](/src-tauri/kabegame-core/src/gallery/browse.rs) 的 `browse_gallery_provider(storage, provider_rt, path, page_size)`。

### SimplePage 分支（可配置页大小）

- 对 `page_size` 做白名单归一：`100 | 500 | 1000`，否则按 `100`。
- `offset = (page - 1) * page_size`，`get_images_info_range_by_query(query, offset, page_size)`。
- 返回 `GalleryBrowseResult`：`total`、`base_offset`、`range_total`、`entries`（当前页图片列表）。

### Metadata 懒加载（列表不带插件 JSON）

为减少翻页时读取/传输/解析整页 `images.metadata`（插件写入的 JSON），**浏览列表**路径统一不返回 metadata：

- **`get_images_info_range_by_query`**（[`storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)）：SELECT 中对 `metadata` 使用 `NULL`，构造的 `ImageInfo.metadata` 恒为 `None`。
- **`fs_entries_to_gallery_browse`**（[`gallery/browse.rs`](/src-tauri/kabegame-core/src/gallery/browse.rs)）：`find_image_by_id` 后把 `image.metadata` 置为 `None`，与 SimplePage 行为一致。

详情区（EJS / 原始键值）按需加载：

- **命令**：`get_image_metadata`（[`kabegame/src/commands/image.rs`](/src-tauri/kabegame/src/commands/image.rs)），参数 **`imageId`**（与前端 camelCase 一致）。
- **实现**：[`Storage::get_image_metadata`](/src-tauri/kabegame-core/src/storage/images.rs) 仅 `SELECT metadata FROM images WHERE id = ?`。

### 与 VD / Greedy 的区别

- **SimplePage**：一页行数 = 用户设置的 `galleryPageSize`（经上述 clamp）。
- **Greedy 等路径**：`browse.rs` 仍使用文件内 `LEAF_SIZE = 100` 做目录拆分，**不**读 `galleryPageSize`。

### 设置持久化

- **Rust**：`SettingKey::GalleryPageSize`、getter/setter（与 `gallery_grid_columns` 同类模式）。
- **CLI IPC**：[`src-tauri/kabegame/src/ipc/handlers/gallery.rs`](/src-tauri/kabegame/src/ipc/handlers/gallery.rs) 对 `browse_gallery_provider` 传固定 `100`（CLI 不需要可配页大小）。

## 前端

### 设置层

- **Store**：[`packages/core/src/stores/settings.ts`](/packages/core/src/stores/settings.ts)  
  - `AppSettings.galleryPageSize`  
  - `buildSettingKeyMap` 中 `get_gallery_page_size` / `set_gallery_page_size`，参数名 `size`（全平台通用键）。

### 路由与页码

- **Composable**：[`apps/kabegame/src/composables/useProviderPathRoute.ts`](/apps/kabegame/src/composables/useProviderPathRoute.ts)  
  - 仅维护 `currentPath / providerRootPath / currentPage`，不再额外暴露 `currentOffset`。  
  - 大页分页器直接使用 `currentPage`，`pageSize` 只用于后端查询条数与翻页重载。

### 拉取当前页图片

- **Composable**：[`apps/kabegame/src/composables/useGalleryImages.ts`](/apps/kabegame/src/composables/useGalleryImages.ts)  
  - `invoke("browse_gallery_provider", { path, pageSize: unref(pageSize) })`  
  - `jumpToBigPage` 等内部与 `pageSize` 对齐。
  - 可选第 4 个参数 `onBeforeFetch`：在每次 `browse_gallery_provider` 请求前调用；画廊页传入 **`useProvideImageMetadataCache` 的 `clearCache`**，换页时清空 per-page metadata 缓存。

### Metadata 详情与前端缓存

- **Composable**：[`packages/core/src/composables/useImageMetadataCache.ts`](/packages/core/src/composables/useImageMetadataCache.ts) — `useProvideImageMetadataCache()` 向子组件树 `provide` 懒加载解析器（内部 `Map` 缓存 + `invoke("get_image_metadata", { imageId })`）。
- **详情 UI**：[`packages/core/src/components/common/ImageDetailContent.vue`](/packages/core/src/components/common/ImageDetailContent.vue) — `inject` 解析器；若列表项已有可渲染 `metadata` 则直接用，否则异步拉取并合并为 `effectiveMetadata`。
- **接入视图**（在拉取当前 leaf 前 `clearCache`）：[`Gallery.vue`](/apps/kabegame/src/views/Gallery.vue)（经 `useGalleryImages` 的 `onBeforeFetch`）、[`AlbumDetail.vue`](/apps/kabegame/src/views/AlbumDetail.vue)、[`TaskDetail.vue`](/apps/kabegame/src/views/TaskDetail.vue)、[`SurfImages.vue`](/apps/kabegame/src/views/SurfImages.vue)。

### 使用 SimplePage 列表的视图（需统一）

以下视图从设置读取 `galleryPageSize`，传入 `useProviderPathRoute` 与 `useGalleryImages`，并在 **`pageSize` 变化时回到第 1 页并刷新**（`watch` 内 `navigateToPage(1)` 等）：

- [`apps/kabegame/src/views/Gallery.vue`](/apps/kabegame/src/views/Gallery.vue)
- [`apps/kabegame/src/views/AlbumDetail.vue`](/apps/kabegame/src/views/AlbumDetail.vue)
- [`apps/kabegame/src/views/TaskDetail.vue`](/apps/kabegame/src/views/TaskDetail.vue)
- [`apps/kabegame/src/views/SurfImages.vue`](/apps/kabegame/src/views/SurfImages.vue)

部分视图还会直接 `invoke("browse_gallery_provider", { path, pageSize })` 做「仅取 total」或「月份列表」等辅助请求，**同样需要传 `pageSize`**。

### UI：每页条数入口

- **画廊**：[`GalleryToolbar.vue`](/apps/kabegame/src/components/GalleryToolbar.vue)（桌面下拉；Android：header fold + `van-picker`）。
- **画册详情**：[`AlbumDetailBrowseToolbar.vue`](/apps/kabegame/src/components/AlbumDetailBrowseToolbar.vue) + [`GalleryPageSizeControl.vue`](/apps/kabegame/src/components/GalleryPageSizeControl.vue)；Android 在 [`AlbumDetailPageHeader.vue`](/apps/kabegame/src/components/header/AlbumDetailPageHeader.vue) fold 中增加与画廊相同的 `HeaderFeatureId.GalleryPageSize`。
- **任务 / 畅游**：分页器上方工具行内嵌 `GalleryPageSizeControl`（`android-ui="inline"`）。
- **设置**：[`GalleryPageSizeSetting.vue`](/apps/kabegame/src/components/settings/items/GalleryPageSizeSetting.vue)，[`Settings.vue`](/apps/kabegame/src/views/Settings.vue) 应用设置区。

### i18n

- `settings.galleryPageSize` / `settings.galleryPageSizeDesc`
- `gallery.pageSize`（工具栏/选择器标题）
- `header.galleryPageSize`（Android header fold 文案）

## 图片与画册成员变更事件

### `images-change`（`DaemonEvent::ImagesChange`，`images` 表）

- 后端通过 `GlobalEmitter::emit_images_change` 广播，**`reason` 仅为** `add` / `delete` / `change`（如原 `wallpaper-set` 已并入 `change`）。
- Payload：`imageIds`，以及可选的 **`taskIds` / `surfRecordIds`**（用于任务详情 / 畅游等视图过滤）；**不再包含画册维度**（已拆出见下）。
- 前端：`apps/kabegame/src/composables/useImagesChangeRefresh.ts`。

### `album-images-change`（`DaemonEvent::AlbumImagesChange`，`album_images` 表）

- 后端通过 `emit_album_images_change`，`reason` 为 `add` / `delete`（对应收藏/画册增删成员等）。
- Payload：`albumIds`、`imageIds`。
- 前端：`apps/kabegame/src/composables/useAlbumImagesChangeRefresh.ts`；画册列表预览、收藏星标就地更新等依赖此事件。
- Plasma 壁纸插件（`src-plasma-wallpaper-plugin/plugin/wallpaperbackend.cpp`）同时订阅上述两类事件：画册路径以 `album-images-change` 为主；`images-change` 在画册视图下主要响应 `delete`/`change`（删文件、壁纸顺序等）。

## 排查清单

1. **翻页页码不对**：确认 `query.path` 末尾页码与 `useProviderPathRoute.currentPage` 一致，且切页后有触发 `navigateToPage`。
2. **改每页条数后仍显示旧页**：确认对应视图对 `pageSize` 有 `watch`，并 `navigateToPage(1)` 或重新 `loadCurrentPage`。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。

## 涉及文件（速查）

| 层级 | 文件 |
|------|------|
| Rust 浏览 | `src-tauri/kabegame-core/src/gallery/browse.rs` |
| Tauri 命令 | `src-tauri/kabegame/src/commands/image.rs` |
| IPC 默认页大小 | `src-tauri/kabegame/src/ipc/handlers/gallery.rs` |
| 设置 | `src-tauri/kabegame-core/src/settings.rs` |
| 前端设置 | `packages/core/src/stores/settings.ts` |
| 路由 offset | `apps/kabegame/src/composables/useProviderPathRoute.ts` |
| 列表加载 | `apps/kabegame/src/composables/useGalleryImages.ts` |
