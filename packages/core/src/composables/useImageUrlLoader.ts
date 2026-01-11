import { ref, watch, type Ref } from "vue";
import type { ImageInfo, ImageUrlMap } from "../types/image";
import { useImageUrlMapCache } from "./useImageUrlMapCache";

type LoadKind = "thumbnail" | "original";

export type UseImageUrlLoaderParams<
  TImage extends Pick<ImageInfo, "id" | "localPath" | "thumbnailPath">
> = {
  /**
   * `ImageGrid` 的真实滚动容器（通过 `gridRef.getContainerEl()` 拿到）。
   * 用于估算可视范围，做到“只优先加载视口附近的图片”。
   */
  containerRef: Ref<HTMLElement | null>;
  /**
   * 当前页面的图片列表（Gallery/AlbumDetail/TaskDetail 都可复用）。
   */
  imagesRef: Ref<TImage[]>;
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
 * 统一的图片 URL 加载器（供所有 ImageGrid 页面复用）：
 * - thumbnail：一律 Blob URL（readFile -> Blob -> createObjectURL），由 core 的全局 LRU(10000) 管理
 * - original：一律 asset URL（convertFileSrc，同步）
 */
export function useImageUrlLoader<
  TImage extends Pick<ImageInfo, "id" | "localPath" | "thumbnailPath">
>(params: UseImageUrlLoaderParams<TImage>) {
  const preferOriginalInGrid = params.preferOriginalInGrid ?? ref(false);
  const cache = useImageUrlMapCache();

  // 全局共享的 imageUrlMap（Vue 响应式）
  const imageSrcMap = cache.imageUrlMap;

  // O(1) 存在性判断：避免异步回写到已被移除的图片
  let imageIdSet = new Set<string>();
  const rebuildIdSet = (imgs: TImage[]) => {
    imageIdSet = new Set((imgs || []).map((i) => i.id));
  };
  rebuildIdSet(params.imagesRef.value || []);

  // 追加场景下尽量增量更新 set（避免频繁全量 new Set）
  let lastImagesSnapshot: TImage[] = params.imagesRef.value || [];
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
          for (let i = prevArr.length; i < nextArr.length; i++) {
            const id = nextArr[i]?.id;
            if (id) imageIdSet.add(id);
          }
          return;
        }
      }
      // 删除/重排/全量刷新：重建
      rebuildIdSet(nextArr);
    },
    { deep: false }
  );

  // 加载状态缓存：避免 scroll-stable / rAF 高频触发时重复读同一张图
  const loadedThumbnailIds = new Set<string>();
  const loadedOriginalIds = new Set<string>();
  const inFlightThumbnailIds = new Set<string>();
  const inFlightOriginalIds = new Set<string>();

  // 重试（极少数文件暂时不可读/空返回时兜底）
  const MAX_THUMBNAIL_RETRIES = 3;
  const MAX_ORIGINAL_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 450;
  const thumbnailRetryCount = new Map<string, number>();
  const originalRetryCount = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const pickThumbnailPath = (image: TImage): string => {
    return ((image.thumbnailPath as any) || image.localPath || "").trim();
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
      // 退化：DOM 扫描
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

    // 关键：尽量使用真实 DOM 高度（避免“估算行高”与 ImageGrid 实际使用的 aspectRatio 不一致，导致加载错区间）。
    // 这里即使缩略图没出，骨架/占位也会渲染 `.image-item`，所以通常能测到。
    const firstItemEl = container.querySelector<HTMLElement>(".image-item");
    const measuredItemHeight = firstItemEl?.getBoundingClientRect().height ?? 0;
    const itemHeight =
      measuredItemHeight > 1
        ? measuredItemHeight
        : itemWidth > 0
        ? itemWidth /
          Math.max(0.1, window.innerWidth / Math.max(1, window.innerHeight))
        : 200;
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
    const end = Math.max(
      start,
      Math.min(images.length, (endRow + 1) * columns)
    );
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

  const loadSingleImageUrl = async (image: TImage, needOriginal: boolean) => {
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
        const thumbPath = pickThumbnailPath(image);
        const thumbUrl = thumbPath
          ? await cache.ensureThumbnailBlobUrl(image.id, thumbPath)
          : "";
        if (!imageIdSet.has(image.id)) return;
        if (thumbUrl) {
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
          ? cache.ensureOriginalAssetUrl(image.id, image.localPath)
          : "";
        if (!imageIdSet.has(image.id)) return;
        if (origUrl) {
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

  const loadImageUrls = async (targetImages?: TImage[]) => {
    if (params.isInteracting?.value && !targetImages) return;

    const range = estimateVisibleIndexRange();
    // 关键：避免在“一次性塞入 10k 图片”时把全量图片纳入本次扫描/队列。
    // 这种场景的用户预期是“当前视口先出图”，而不是后台把 10k 全部排队导致视口饿死。
    const MAX_TARGET_SCAN = 2000;
    const source =
      targetImages && targetImages.length > MAX_TARGET_SCAN
        ? params.imagesRef.value.slice(range.start, range.end)
        : targetImages ?? params.imagesRef.value.slice(range.start, range.end);
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

    // 可见图片优先
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
      void runPool(likelyVisible, visibleConcurrency, async (img) => {
        await loadSingleImageUrl(img, needOriginal);
      });
    }
  };

  // 列数/偏好变化时触发补齐
  let columnsChangeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleLoadOnColumnsChange = () => {
    const container = params.containerRef.value;
    if (!container) return;
    if (columnsChangeTimer) clearTimeout(columnsChangeTimer);
    columnsChangeTimer = setTimeout(() => {
      columnsChangeTimer = null;
      scheduleNext(() => void loadImageUrls());
    }, 80);
  };

  watch(
    () => preferOriginalInGrid.value,
    (next, prev) => {
      if (next === prev) return;
      if (next) scheduleLoadOnColumnsChange();
    }
  );

  watch(
    () => params.gridColumns?.value,
    (next, prev) => {
      if (next === prev) return;
      scheduleLoadOnColumnsChange();
    }
  );

  const removeFromCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    cache.removeByIds(imageIds);
    for (const id of imageIds) {
      clearRetryTimer(id);
      thumbnailRetryCount.delete(id);
      originalRetryCount.delete(id);
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
    if (isThumbnail) {
      const p = (image.thumbnailPath || localPath || "").trim();
      if (!p) return;
      await cache.ensureThumbnailBlobUrl(imageId, p);
      return;
    }
    if (!localPath) return;
    cache.ensureOriginalAssetUrl(imageId, localPath);
  };

  const reset = () => {
    // 换大页/换列表：终止旧页的 URL 加载任务（尤其是缩略图 Blob 队列）
    cache.cancelAllThumbnailLoads();

    // 让旧页 in-flight 结果尽量不落地（依赖 imageIdSet 检查）
    imageIdSet = new Set();
    lastImagesSnapshot = [];

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
    imageSrcMap: imageSrcMap as Ref<ImageUrlMap>,
    loadImageUrls,
    removeFromCacheByIds,
    recreateImageUrl,
    reset,
    cleanup: reset,
  };
}
