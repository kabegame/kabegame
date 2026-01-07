import { ref, watch, type Ref } from "vue";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ImageInfo } from "@/stores/crawler";

export type ImageUrlMap = Record<string, { thumbnail?: string; original?: string }>;

type LoadKind = "thumbnail" | "original";

type UseImageUrlLoaderParams = {
  /**
   * `ImageGrid` 的真实滚动容器（通过 `gridRef.getContainerEl()` 拿到）。
   * 用于估算可视范围，做到“只优先加载视口附近的图片”。
   */
  containerRef: Ref<HTMLElement | null>;
  /**
   * 当前页面的图片列表（Gallery/AlbumDetail/TaskDetail 都可复用）。
   */
  imagesRef: Ref<ImageInfo[]>;
  /**
   * 是否优先加载原图（例如列数<=2 时，为了更清晰）。
   * - false：只保证缩略图，原图按需再补
   * - true：视口优先队列会同时补齐 original
   */
  preferOriginalInGrid?: Ref<boolean>;
  /**
   * 网格列数（用于快速估算可见范围，避免 DOM 扫描）。
   * - 不传则退化为 DOM 扫描（大列表会慢）
   */
  gridColumns?: Ref<number>;
  /**
   * 强交互期间尽量推迟后台任务（例如 dragScroll 拖拽滚动 / 预览拖拽缩放）。
   */
  isInteracting?: Ref<boolean>;
};

/**
 * 从本地路径读取文件并生成 Blob URL（带超时/重试/并发控制/视口优先）。
 *
 * 这套实现最初来自 Gallery 的 `loadImageUrls` 优化；抽出后可复用于所有 `ImageGrid` 页面。
 */
export function useImageUrlLoader(params: UseImageUrlLoaderParams) {
  const preferOriginalInGrid = params.preferOriginalInGrid ?? ref(false);

  // 图片 URL 映射（thumbnail/original）
  const imageSrcMap = ref<ImageUrlMap>({});

  // O(1) 存在性判断：避免异步回写到已被移除的图片
  let imageIdSet = new Set<string>();
  const rebuildIdSet = (imgs: ImageInfo[]) => {
    imageIdSet = new Set(imgs.map((i) => i.id));
  };
  rebuildIdSet(params.imagesRef.value || []);

  // 追加场景下尽量增量更新 set（避免频繁全量 new Set）
  let lastImagesSnapshot: ImageInfo[] = params.imagesRef.value || [];
  watch(
    () => params.imagesRef.value,
    (next, prev) => {
      const nextArr = next || [];
      const prevArr = prev || lastImagesSnapshot || [];
      lastImagesSnapshot = nextArr;

      if (nextArr.length === 0) {
        imageIdSet = new Set();
        return;
      }
      if (!prevArr || prevArr.length === 0) {
        rebuildIdSet(nextArr);
        return;
      }
      // 常见：追加（load more / image-added）
      if (nextArr.length >= prevArr.length) {
        const prevFirst = prevArr[0]?.id;
        const prevLast = prevArr[prevArr.length - 1]?.id;
        const nextFirst = nextArr[0]?.id;
        const nextLastAtPrev = nextArr[prevArr.length - 1]?.id;
        if (
          prevFirst &&
          prevLast &&
          prevFirst === nextFirst &&
          prevLast === nextLastAtPrev
        ) {
          // 增量补齐新增区间
          for (let i = prevArr.length; i < nextArr.length; i++) {
            const id = nextArr[i]?.id;
            if (id) imageIdSet.add(id);
          }
          return;
        }
      }
      // 其它情况（删除/重排/全量刷新）：重建一次
      rebuildIdSet(nextArr);
    },
    { deep: false }
  );

  // 加载状态缓存：避免 scroll-stable / rAF 高频触发时重复 readFile 同一张图
  const loadedThumbnailIds = new Set<string>();
  const loadedOriginalIds = new Set<string>();
  const inFlightThumbnailIds = new Set<string>();
  const inFlightOriginalIds = new Set<string>();

  // 超时 + 重试：避免少量图片卡住导致“永远 inFlight”
  const THUMBNAIL_TIMEOUT_MS = 2500;
  const ORIGINAL_TIMEOUT_MS = 6500;
  const MAX_THUMBNAIL_RETRIES = 3;
  const MAX_ORIGINAL_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 450;
  const thumbnailRetryCount = new Map<string, number>();
  const originalRetryCount = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Blob URL -> Blob：持有引用避免被 GC 造成 URL 偶发失效；同时用于统一释放
  const blobObjects = new Map<string, Blob>();

  const detectMime = (filePath: string) => {
    const ext = filePath.split(".").pop()?.toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    else if (ext === "gif") mimeType = "image/gif";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "bmp") mimeType = "image/bmp";
    return mimeType;
  };

  async function getImageUrl(
    localPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<string> {
    if (!localPath) return "";
    try {
      // 移除 Windows 长路径前缀 \\?\
      let normalizedPath = localPath
        .trimStart()
        .replace(/^\\\\\?\\/, "")
        .trim();

      if (!normalizedPath) return "";

      const timeoutMs = Math.max(0, opts?.timeoutMs ?? 0);
      const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
        if (!ms) return await p;
        return await Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`readFile timeout (${ms}ms)`)), ms)
          ),
        ]);
      };

      const fileData = await withTimeout(readFile(normalizedPath), timeoutMs);
      if (!fileData || fileData.length === 0) return "";

      const blob = new Blob([fileData], { type: detectMime(normalizedPath) });
      if (blob.size === 0) return "";

      const blobUrl = URL.createObjectURL(blob);
      blobObjects.set(blobUrl, blob);
      return blobUrl;
    } catch (error) {
      console.error("Failed to load image file:", error, localPath);
      return "";
    }
  }

  const uniquePaths = (paths: Array<string | undefined | null>): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const v = (p || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  const clearRetryTimer = (imageId: string) => {
    const t = retryTimers.get(imageId);
    if (t) {
      clearTimeout(t);
      retryTimers.delete(imageId);
    }
  };

  const scheduleRetry = (imageId: string, kind: LoadKind) => {
    if (!imageIdSet.has(imageId)) return;
    if (retryTimers.has(imageId)) return;

    const isThumb = kind === "thumbnail";
    const retryMap = isThumb ? thumbnailRetryCount : originalRetryCount;
    const max = isThumb ? MAX_THUMBNAIL_RETRIES : MAX_ORIGINAL_RETRIES;
    const current = retryMap.get(imageId) ?? 0;
    if (current >= max) return;

    const nextCount = current + 1;
    retryMap.set(imageId, nextCount);

    const delay = Math.min(
      5000,
      RETRY_BASE_DELAY_MS * Math.pow(2, nextCount - 1)
    );
    const timer = setTimeout(() => {
      retryTimers.delete(imageId);
      if (!imageIdSet.has(imageId)) return;
      const image = params.imagesRef.value.find((i) => i.id === imageId);
      if (!image) return;
      void loadSingleImageUrl(image, preferOriginalInGrid.value);
    }, delay);
    retryTimers.set(imageId, timer);
  };

  const calcGridGap = (columns: number) =>
    Math.max(4, 16 - (Math.max(1, columns) - 1));

  const estimateVisibleIndexRange = (): {
    start: number;
    end: number;
    visibleIds: string[];
  } => {
    const container = params.containerRef.value;
    const images = params.imagesRef.value;
    if (!container || images.length === 0) {
      return { start: 0, end: 0, visibleIds: [] };
    }

    const colsRaw = params.gridColumns?.value ?? 0;
    if (!colsRaw || colsRaw <= 0) {
      // 退化：DOM 扫描（慢，但兼容）
      const containerRect = container.getBoundingClientRect();
      const items = container.querySelectorAll<HTMLElement>(".image-item");
      const visibleIds: string[] = [];
      items.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const isVisible =
          rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
        if (isVisible) {
          const id = el.getAttribute("data-id");
          if (id) visibleIds.push(id);
        }
      });
      return { start: 0, end: images.length, visibleIds };
    }

    const columns = Math.max(1, colsRaw);
    const gap = calcGridGap(columns);

    // ImageGrid 左右 padding 8px
    const gridHorizontalPadding = 16;
    const containerWidth = Math.max(
      0,
      container.clientWidth - gridHorizontalPadding
    );
    const itemWidth =
      columns <= 1
        ? containerWidth
        : (containerWidth - gap * (columns - 1)) / columns;
    const aspectRatio = Math.max(
      0.1,
      window.innerWidth / Math.max(1, window.innerHeight)
    );
    const itemHeight = itemWidth > 0 ? itemWidth / aspectRatio : 200;
    const rowHeight = itemHeight + gap;

    const overscanRows = 8;
    const startRow = Math.max(
      0,
      Math.floor(container.scrollTop / rowHeight) - overscanRows
    );
    const endRow =
      Math.ceil((container.scrollTop + container.clientHeight) / rowHeight) +
      overscanRows;

    const start = Math.max(0, Math.min(images.length, startRow * columns));
    const end = Math.max(start, Math.min(images.length, (endRow + 1) * columns));
    const visibleIds = images.slice(start, end).map((i) => i.id);
    return { start, end, visibleIds };
  };

  const runPool = async <T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
  ) => {
    const limit = Math.max(1, concurrency | 0);
    let index = 0;
    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (index < items.length) {
          const current = index++;
          const item = items[current];
          try {
            await worker(item);
          } catch (e) {
            console.error("图片 URL 加载任务失败:", e);
          }
        }
      }
    );
    await Promise.all(runners);
  };

  const scheduleNext = (callback: () => void) => {
    // 强交互期间：尽量不安排 readFile/Blob 创建等重活
    if (params.isInteracting?.value) {
      setTimeout(() => {
        if (params.isInteracting?.value) {
          scheduleNext(callback);
          return;
        }
        callback();
      }, 160);
      return;
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => callback(), { timeout: 2000 });
    } else {
      setTimeout(callback, 50);
    }
  };

  const loadSingleImageUrl = async (image: ImageInfo, needOriginal: boolean) => {
    const existing = imageSrcMap.value[image.id] || {};
    const hasThumb =
      !!existing.thumbnail ||
      loadedThumbnailIds.has(image.id) ||
      inFlightThumbnailIds.has(image.id);
    const hasOrig =
      !!existing.original ||
      loadedOriginalIds.has(image.id) ||
      inFlightOriginalIds.has(image.id);

    if (!hasThumb) {
      inFlightThumbnailIds.add(image.id);
      try {
        const candidates = uniquePaths([image.thumbnailPath, image.localPath]);
        let thumbUrl = "";
        for (const p of candidates) {
          thumbUrl = await getImageUrl(p, { timeoutMs: THUMBNAIL_TIMEOUT_MS });
          if (thumbUrl) break;
        }
        if (!imageIdSet.has(image.id)) return;
        if (thumbUrl) {
          imageSrcMap.value[image.id] = { ...existing, thumbnail: thumbUrl };
          loadedThumbnailIds.add(image.id);
          thumbnailRetryCount.delete(image.id);
          clearRetryTimer(image.id);
        } else {
          scheduleRetry(image.id, "thumbnail");
        }
      } finally {
        inFlightThumbnailIds.delete(image.id);
      }
    }

    if (needOriginal && !hasOrig) {
      inFlightOriginalIds.add(image.id);
      try {
        const origUrl = image.localPath
          ? await getImageUrl(image.localPath, { timeoutMs: ORIGINAL_TIMEOUT_MS })
          : "";
        if (!imageIdSet.has(image.id)) return;
        if (origUrl) {
          const curr = imageSrcMap.value[image.id] || {};
          imageSrcMap.value[image.id] = { ...curr, original: origUrl };
          loadedOriginalIds.add(image.id);
          originalRetryCount.delete(image.id);
          clearRetryTimer(image.id);
        } else {
          scheduleRetry(image.id, "original");
        }
      } finally {
        inFlightOriginalIds.delete(image.id);
      }
    }
  };

  const loadImageUrls = async (targetImages?: ImageInfo[]) => {
    // 强交互期间：仅在“显式指定目标集合”时执行（避免滚动掉帧）
    if (params.isInteracting?.value && !targetImages) return;

    const range = estimateVisibleIndexRange();
    const source =
      targetImages ??
      params.imagesRef.value.slice(range.start, range.end);
    const visibleSet = new Set(range.visibleIds);

    const needOriginal = preferOriginalInGrid.value;
    const imagesToLoad = source.filter((img) => {
      const existing = imageSrcMap.value[img.id];
      const hasThumb =
        !!existing?.thumbnail ||
        loadedThumbnailIds.has(img.id) ||
        inFlightThumbnailIds.has(img.id);
      const hasOrig =
        !!existing?.original ||
        loadedOriginalIds.has(img.id) ||
        inFlightOriginalIds.has(img.id);
      if (!hasThumb) return true;
      if (needOriginal && !hasOrig) return true;
      return false;
    });

    if (imagesToLoad.length === 0) return;

    imagesToLoad.sort((a, b) => {
      const av = visibleSet.has(a.id) ? 0 : 1;
      const bv = visibleSet.has(b.id) ? 0 : 1;
      if (av !== bv) return av - bv;
      return 0;
    });

    const visibleConcurrency = params.isInteracting?.value ? 1 : 8;
    const likelyVisible = targetImages
      ? imagesToLoad.filter((img) => visibleSet.has(img.id))
      : imagesToLoad;
    if (likelyVisible.length > 0) {
      void runPool(likelyVisible, visibleConcurrency, async (image) => {
        await loadSingleImageUrl(image, needOriginal);
      });
    }

    const remainingImages = targetImages
      ? imagesToLoad.filter((img) => !visibleSet.has(img.id))
      : [];
    if (remainingImages.length > 0) {
      const remainingUpdates: ImageUrlMap = {};
      let processedCount = 0;
      const BATCH_SIZE = 20;
      let pendingUpdate = false;

      const flushUpdates = () => {
        if (Object.keys(remainingUpdates).length > 0) {
          Object.assign(imageSrcMap.value, remainingUpdates);
          Object.keys(remainingUpdates).forEach((key) => delete remainingUpdates[key]);
        }
        pendingUpdate = false;
      };

      const processRemaining = async (index = 0) => {
        if (index >= remainingImages.length) {
          if (Object.keys(remainingUpdates).length > 0) {
            Object.assign(imageSrcMap.value, remainingUpdates);
          }
          return;
        }

        const image = remainingImages[index];
        const existing = imageSrcMap.value[image.id];
        const hasThumb =
          !!existing?.thumbnail ||
          loadedThumbnailIds.has(image.id) ||
          inFlightThumbnailIds.has(image.id);
        const hasOrig =
          !!existing?.original ||
          loadedOriginalIds.has(image.id) ||
          inFlightOriginalIds.has(image.id);
        if (hasThumb && (!needOriginal || hasOrig)) {
          scheduleNext(() => processRemaining(index + 1));
          return;
        }

        try {
          if (!hasThumb) {
            inFlightThumbnailIds.add(image.id);
            try {
              const thumbPath = image.thumbnailPath || image.localPath;
              const thumbUrl = thumbPath
                ? await getImageUrl(thumbPath, { timeoutMs: THUMBNAIL_TIMEOUT_MS })
                : "";
              if (imageIdSet.has(image.id) && thumbUrl) {
                remainingUpdates[image.id] = {
                  ...(remainingUpdates[image.id] || {}),
                  thumbnail: thumbUrl,
                };
                loadedThumbnailIds.add(image.id);
                processedCount++;
              } else if (imageIdSet.has(image.id)) {
                scheduleRetry(image.id, "thumbnail");
              }
            } finally {
              inFlightThumbnailIds.delete(image.id);
            }
          }

          if (needOriginal && !hasOrig) {
            inFlightOriginalIds.add(image.id);
            try {
              const origUrl = image.localPath
                ? await getImageUrl(image.localPath, { timeoutMs: ORIGINAL_TIMEOUT_MS })
                : "";
              if (imageIdSet.has(image.id) && origUrl) {
                remainingUpdates[image.id] = {
                  ...(remainingUpdates[image.id] || {}),
                  original: origUrl,
                };
                loadedOriginalIds.add(image.id);
                processedCount++;
              } else if (imageIdSet.has(image.id)) {
                scheduleRetry(image.id, "original");
              }
            } finally {
              inFlightOriginalIds.delete(image.id);
            }
          }

          if (
            processedCount % BATCH_SIZE === 0 &&
            Object.keys(remainingUpdates).length > 0
          ) {
            if (!pendingUpdate) {
              pendingUpdate = true;
              requestAnimationFrame(flushUpdates);
            }
          }
        } catch (error) {
          console.error("Failed to load image:", error);
        }

        scheduleNext(() => processRemaining(index + 1));
      };

      scheduleNext(() => processRemaining(0));
    }
  };

  const removeFromCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    for (const id of imageIds) {
      clearRetryTimer(id);
      thumbnailRetryCount.delete(id);
      originalRetryCount.delete(id);

      const data = imageSrcMap.value[id];
      if (data?.thumbnail) {
        try {
          URL.revokeObjectURL(data.thumbnail);
        } catch {
          // ignore
        }
        blobObjects.delete(data.thumbnail);
      }
      if (data?.original) {
        try {
          URL.revokeObjectURL(data.original);
        } catch {
          // ignore
        }
        blobObjects.delete(data.original);
      }
      delete imageSrcMap.value[id];
      loadedThumbnailIds.delete(id);
      loadedOriginalIds.delete(id);
      inFlightThumbnailIds.delete(id);
      inFlightOriginalIds.delete(id);
      imageIdSet.delete(id);
    }
  };

  const recreateImageUrl = async (
    imageId: string,
    localPath: string,
    isThumbnail = false
  ) => {
    const image = params.imagesRef.value.find((img) => img.id === imageId);
    if (!image) return;

    const pathToUse =
      isThumbnail && image.thumbnailPath ? image.thumbnailPath : localPath;
    const newUrl = await getImageUrl(pathToUse);
    if (!newUrl) return;

    const currentData = imageSrcMap.value[imageId] || {};
    const nextData = { ...currentData };
    if (isThumbnail) {
      if (currentData.thumbnail) {
        try {
          URL.revokeObjectURL(currentData.thumbnail);
          blobObjects.delete(currentData.thumbnail);
        } catch {
          // ignore
        }
      }
      nextData.thumbnail = newUrl;
    } else {
      if (currentData.original) {
        try {
          URL.revokeObjectURL(currentData.original);
          blobObjects.delete(currentData.original);
        } catch {
          // ignore
        }
      }
      nextData.original = newUrl;
    }
    imageSrcMap.value[imageId] = nextData;
  };

  const reset = () => {
    for (const url of blobObjects.keys()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    blobObjects.clear();
    imageSrcMap.value = {};
    loadedThumbnailIds.clear();
    loadedOriginalIds.clear();
    inFlightThumbnailIds.clear();
    inFlightOriginalIds.clear();
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    thumbnailRetryCount.clear();
    originalRetryCount.clear();
  };

  return {
    imageSrcMap,
    loadImageUrls,
    removeFromCacheByIds,
    recreateImageUrl,
    reset,
    cleanup: reset,
  };
}






