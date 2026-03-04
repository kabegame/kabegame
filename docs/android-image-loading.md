# Android 图片加载与视口门控结论

本文档总结在 Android 上对图片 URL 加载时机、`readFile` 调用来源的排查结论，以及“仅视口内加载”的改造建议。

**说明**：下文「一～五」描述的是**历史架构**（基于 blob URL、LRU 缓存、视口门控）。「六」为 2025 年简化后的当前架构（直接由路径算 URL，配合全局图片状态缓存避免频繁闪回加载态）。

---

## 一、结论摘要

1. **视口门控有效**：Android 上仅当 `ImageItem` 进入视口（含 300px rootMargin）时才会触发 `IntersectionObserver` 和 `ensureForImage`，列表静止时只会加载视口内约 6 张，滚动后按视口再加载。
2. **双路加载**：实际第一次（也是当前实现下唯一一次）`readFile` 并非由 `ImageItem` 视口触发，而是由 **ImagePreviewDialog** 的 computed 在对整表做“原图 URL 预取”时触发；`ImageItem` 随后触发时命中 in-flight 或 cache，因此不再产生额外 `readFile`。
3. **若希望“仅视口内才读文件”**：需要让 ImagePreviewDialog 在 Android 上不要对整表预取原图（例如改为按当前预览索引/视口再调用 `getOrCreateOriginalUrlFor`），或与 ImageItem 共用同一套“视口内才加载”的约定。

---

## 二、双路加载链路

### 2.1 ImageItem.vue（视口门控）

- **IntersectionObserver**：rootMargin 300px，threshold 0；仅当 item 进入视口时 `isInViewport = true`。
- **watch**：当 `isInViewport && !imageUrl?.original && !loadTriggered` 时调用 `cache.ensureForImage(image, true)`，并设 `loadTriggered = true` 防止重复。
- 因此：**只有进入视口的 item 会触发 ensureForImage**，readFile 理论上应受此门控影响。

### 2.2 ImagePreviewDialog.vue（整表预取）

- 预览弹层内对**当前图片列表**做 computed，对每项调用 `getOrCreateOriginalUrlFor(...)`，进而走 `ensureOriginalAssetUrl` → 在 Android content:// 下走 `ensureOriginalBlobUrl`，内部会调用 **readFile**。
- 该 computed 在页面/数据变化时就会执行，**不依赖视口**，因此会在打开预览或列表变化时对整表发起原图 URL 请求。
- 第一次 readFile 即来自此路径；之后 ImageItem 的 ensureForImage 对同一资源会命中 **INFLIGHT-DEDUP** 或 **CACHE-HIT**，故不再触发 readFile。

### 2.3 useImageUrlMapCache.ts 中的行为

- **ensureOriginalBlobUrl**：content:// 时通过自定义 `read_file` 命令读文件并生成 blob URL；有 LRU + in-flight 去重。
- **ensureForImage**：在 Android 上若 `localPath` 为 content:// 且尚无 original，会调用 `ensureOriginalBlobUrl`；否则走 `ensureOriginalAssetUrl`。
- 因此：谁先请求某张图的 original，谁就会触发 readFile；后续请求同一张图会复用 in-flight 或 cache。

---

## 三、验证方式（历史调试手段，已移除）

此前为在 Android 真机上确认上述结论，曾采用：

- **Rust**：`append_debug_log(line)` 命令，将 NDJSON 行追加到 `AppPaths::global().cache_dir()/debug-01a2e3.log`。
- **前端**：在 ImageItem（IntersectionObserver、onMounted、watch-ensureForImage）、readFile.ts、useImageUrlMapCache（ensureOriginalBlobUrl/ensureForImage 各分支）打日志并带调用栈。
- **拉取日志**：`adb -s <device> shell "run-as app.kabegame cat cache/debug-01a2e3.log"`。

上述调试代码已全部移除；若需再次验证，可参考本段恢复或改用其他日志方案。

---

## 四、改造建议（仅视口内才读文件）

若产品上希望“只有视口内的图片才触发 readFile”：

1. **ImagePreviewDialog**：在 Android 上不要对整表一次性调用 `getOrCreateOriginalUrlFor`；改为仅对**当前预览索引**或**当前可见/即将可见**的少量项请求原图 URL，或与 ImageItem 共用同一套“视口/可见再加载”的约定。
2. **统一入口**：原图 URL 的请求尽量只从“视口内/当前预览”这条路径发起，避免列表级 computed 对整表预取，从而与 ImageItem 的视口门控一致，减少不必要的 readFile。

---

## 五、相关文件（历史架构）

| 文件 | 作用（已废弃或已改） |
|------|----------------------|
| `packages/core/src/components/image/ImageItem.vue` | 原：视口检测 + ensureForImage 门控 → 现：见「六」 |
| `packages/core/src/components/common/ImagePreviewDialog.vue` | 原：computed 整表预取原图 → 现：见「六」 |
| ~~`useImageUrlMapCache.ts`~~ | **已删除**：LRU、blob 生命周期、ensureForImage |
| ~~`useImageUrlLoader.ts`~~ | **已删除**：批量 URL 调度、视口内加载 |
| `packages/core/src/fs/readFile.ts` | Android content:// 仍可用于其他场景；当前图片展示不再经 blob |

---

## 六、当前架构（2025 简化：移除 imageSrcMap）

后端可直接提供图片路径等数据，前端不再维护 blob URL / LRU URL 缓存，改为 **images 列表 + 从路径同步计算 URL + 全局图片状态缓存 + onerror 错误状态**。

### 6.1 设计要点

- **无 URL 全局缓存**：不再有 `imageSrcMap` / `ImageUrlMap` / `useImageUrlMapCache` / `useImageUrlLoader`。
- **URL 来源**：桌面用 `fileToUrl(localPath)`（本地 HTTP 文件服务）；Android 用 `content://` → `CONTENT_URI_PROXY_PREFIX` 代理 URL，由 WebView 拦截请求流式返回。
- **全局状态缓存**：`useImageStateCache` 以图片 `id` 作为 key，缓存 `primaryUrl/fallbackUrl/primaryKind` 与最终渲染状态（`displayUrl/isLost/originalMissing/stage`）。
- **缓存失效策略**：`images-change` 自动刷新不清缓存；仅手动刷新（Gallery/AlbumDetail/TaskDetail）时显式 `clearImageStateCache()`。
- **状态更新**：`useImageItemLoader` 在 `img.onload` 和最终失败分支写缓存，页面切换返回后可直接复用状态。

### 6.2 桌面端 ImageItem

- **始终优先原图**：优先显示原图（`localPath`），失败则回退缩略图（`thumbnailPath` 或 `localPath`）；两者都不可得则显示“图片走丢了”。（与列数无关）
- **仅原图不可得**（例如能显示缩略图但原图 404）：右上角红色感叹号，悬浮提示“这张图片找不到了”。

### 6.3 移动端（Android）ImageItem

- 始终用原图 URL（content:// 代理）；不可得则直接显示“图片走丢了”，无缩略图 fallback。

### 6.4 预览弹层（ImagePreviewDialog）

- **桌面**：优先原图，onerror 回退缩略图，再 error 显示丢失占位。
- **Android PhotoSwipe**：暂不管理错误状态与加载中状态；已写入 `todo.ini`：“安卓 photoswipe 管理错误状态（图片丢失占位）和加载中状态”。

### 6.5 当前相关文件

| 文件 | 作用 |
|------|------|
| `packages/core/src/composables/useImageItemLoader.ts` | 按 `image` + `gridColumns` 计算 primaryUrl/fallbackUrl，命中缓存时直接恢复状态；onerror 切换与 isLost / originalMissing |
| `packages/core/src/composables/useImageStateCache.ts` | 全局图片状态缓存（按 id 存储）与手动刷新清空入口 |
| `packages/core/src/components/image/ImageItem.vue` | 使用 useImageItemLoader，无 imageUrl prop、无 IntersectionObserver |
| `packages/core/src/fileServer.ts` | 桌面 `fileToUrl`，Android 不参与 |
| `packages/core/src/components/common/ImagePreviewDialog.vue` | 直接从 ImageInfo 算预览 URL，原图优先、失败回退缩略图再丢失占位 |
| `packages/core/src/types/image.ts` | `ImageUrlMap` 已移除，仅保留 `ImageInfo` 等 |

### 6.6 images-change 时的增量稳定刷新

当 **images-change** 触发时，各页的 `useImagesChangeRefresh` 会执行 `onRefresh`，对当前页做「整页重拉、整体替换数组」（如 Gallery 的 `refreshImagesPreserveCache`、画册/任务的 `loadAlbum` / `loadTaskImages`）。当前实现通过两层机制避免全页面闪回骨架：

- `ImageGrid` 仍按 `:key="image.id"` 做 diff：删除不存在项、插入新增项、复用同 id 的组件实例。
- `useImageItemLoader` 的 watch 改为依赖基本类型值（`id + primaryUrl + fallbackUrl + primaryKind + localExists`），避免仅因对象引用变化而重置。
- `useImageStateCache` 命中（且 URL 计划未变化）时，`ImageItem` 直接恢复上次状态，不会先回到 `isImageLoading=true`。
- 仅当 URL 计划确实变化、首次出现或缓存未命中时，才进入加载流程并显示骨架。

因此：**当前实现下，images-change 触发后只会让真正变更的条目进入加载态；未变化条目保持已加载状态，页面切换返回也可直接命中缓存，视觉上更平滑。** 如需彻底重新探测图片状态，可通过手动刷新触发缓存清空。
