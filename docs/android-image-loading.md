# Android 图片加载与视口门控结论

本文档总结在 Android 上对图片 URL 加载时机、`readFile` 调用来源的排查结论，以及“仅视口内加载”的改造建议。

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

## 五、相关文件

| 文件 | 作用 |
|------|------|
| `packages/core/src/components/image/ImageItem.vue` | 视口检测 + ensureForImage 门控 |
| `packages/core/src/components/common/ImagePreviewDialog.vue` | 预览弹层；computed 中整表 getOrCreateOriginalUrlFor 会率先触发 readFile |
| `packages/core/src/composables/useImageUrlMapCache.ts` | ensureForImage、ensureOriginalBlobUrl、ensureOriginalAssetUrl；LRU + in-flight 去重 |
| `packages/core/src/fs/readFile.ts` | Android/Linux 下 content:// 等走自定义 read_file，实际读文件处 |
