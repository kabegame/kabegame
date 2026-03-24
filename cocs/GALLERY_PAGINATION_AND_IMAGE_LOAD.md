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

- **位置**：[`src-tauri/app-main/src/commands/image.rs`](/src-tauri/app-main/src/commands/image.rs)（Tauri 命令，参数 `page_size`）。
- **前端 invoke**：必须使用 **camelCase** 参数名 **`pageSize`**（与 Tauri 对前端参数名的约定一致），否则会出现缺少参数错误。
- **实现**：[`src-tauri/core/src/gallery/browse.rs`](/src-tauri/core/src/gallery/browse.rs) 的 `browse_gallery_provider(storage, provider_rt, path, page_size)`。

### SimplePage 分支（可配置页大小）

- 对 `page_size` 做白名单归一：`100 | 500 | 1000`，否则按 `100`。
- `offset = (page - 1) * page_size`，`get_images_info_range_by_query(query, offset, page_size)`。
- 返回 `GalleryBrowseResult`：`total`、`base_offset`、`range_total`、`entries`（当前页图片列表）。

### 与 VD / Greedy 的区别

- **SimplePage**：一页行数 = 用户设置的 `galleryPageSize`（经上述 clamp）。
- **Greedy 等路径**：`browse.rs` 仍使用文件内 `LEAF_SIZE = 100` 做目录拆分，**不**读 `galleryPageSize`。

### 设置持久化

- **Rust**：`SettingKey::GalleryPageSize`、getter/setter（与 `gallery_grid_columns` 同类模式）。
- **CLI IPC**：[`src-tauri/app-main/src/ipc/handlers/gallery.rs`](/src-tauri/app-main/src/ipc/handlers/gallery.rs) 对 `browse_gallery_provider` 传固定 `100`（CLI 不需要可配页大小）。

## 前端

### 设置层

- **Store**：[`packages/core/src/stores/settings.ts`](/packages/core/src/stores/settings.ts)  
  - `AppSettings.galleryPageSize`  
  - `buildSettingKeyMap` 中 `get_gallery_page_size` / `set_gallery_page_size`，参数名 `size`（全平台通用键）。

### 路由与 offset

- **Composable**：[`apps/main/src/composables/useProviderPathRoute.ts`](/apps/main/src/composables/useProviderPathRoute.ts)  
  - `currentOffset = (currentPage - 1) * unref(pageSize ?? 100)`  
  - `pageSize` 来自 `settingsStore.values.galleryPageSize` 的 computed（各视图内）。

### 拉取当前页图片

- **Composable**：[`apps/main/src/composables/useGalleryImages.ts`](/apps/main/src/composables/useGalleryImages.ts)  
  - `invoke("browse_gallery_provider", { path, pageSize: unref(pageSize) })`  
  - `jumpToBigPage` 等内部与 `pageSize` 对齐。

### 使用 SimplePage 列表的视图（需统一）

以下视图从设置读取 `galleryPageSize`，传入 `useProviderPathRoute` 与 `useGalleryImages`，并在 **`pageSize` 变化时回到第 1 页并刷新**（`watch` 内 `navigateToPage(1)` 等）：

- [`apps/main/src/views/Gallery.vue`](/apps/main/src/views/Gallery.vue)
- [`apps/main/src/views/AlbumDetail.vue`](/apps/main/src/views/AlbumDetail.vue)
- [`apps/main/src/views/TaskDetail.vue`](/apps/main/src/views/TaskDetail.vue)
- [`apps/main/src/views/SurfImages.vue`](/apps/main/src/views/SurfImages.vue)

部分视图还会直接 `invoke("browse_gallery_provider", { path, pageSize })` 做「仅取 total」或「月份列表」等辅助请求，**同样需要传 `pageSize`**。

### UI：每页条数入口

- **画廊**：[`GalleryToolbar.vue`](/apps/main/src/components/GalleryToolbar.vue)（桌面下拉；Android：header fold + `van-picker`）。
- **画册详情**：[`AlbumDetailBrowseToolbar.vue`](/apps/main/src/components/AlbumDetailBrowseToolbar.vue) + [`GalleryPageSizeControl.vue`](/apps/main/src/components/GalleryPageSizeControl.vue)；Android 在 [`AlbumDetailPageHeader.vue`](/apps/main/src/components/header/AlbumDetailPageHeader.vue) fold 中增加与画廊相同的 `HeaderFeatureId.GalleryPageSize`。
- **任务 / 畅游**：分页器上方工具行内嵌 `GalleryPageSizeControl`（`android-ui="inline"`）。
- **设置**：[`GalleryPageSizeSetting.vue`](/apps/main/src/components/settings/items/GalleryPageSizeSetting.vue)，[`Settings.vue`](/apps/main/src/views/Settings.vue) 应用设置区。

### i18n

- `settings.galleryPageSize` / `settings.galleryPageSizeDesc`
- `gallery.pageSize`（工具栏/选择器标题）
- `header.galleryPageSize`（Android header fold 文案）

## 排查清单

1. **翻页后 offset 不对**：确认 `useProviderPathRoute` 传入了与 `useGalleryImages` 相同的 `pageSize` ref/computed。
2. **改每页条数后仍显示旧页**：确认对应视图对 `pageSize` 有 `watch`，并 `navigateToPage(1)` 或重新 `loadCurrentPage`。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。

## 涉及文件（速查）

| 层级 | 文件 |
|------|------|
| Rust 浏览 | `src-tauri/core/src/gallery/browse.rs` |
| Tauri 命令 | `src-tauri/app-main/src/commands/image.rs` |
| IPC 默认页大小 | `src-tauri/app-main/src/ipc/handlers/gallery.rs` |
| 设置 | `src-tauri/core/src/settings.rs` |
| 前端设置 | `packages/core/src/stores/settings.ts` |
| 路由 offset | `apps/main/src/composables/useProviderPathRoute.ts` |
| 列表加载 | `apps/main/src/composables/useGalleryImages.ts` |
