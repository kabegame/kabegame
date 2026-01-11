import { nextTick, ref, shallowRef, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  useCrawlerStore,
  type ImageInfo,
  type RangedImages,
} from "@/stores/crawler";
import { useImageUrlLoader } from "@kabegame/core/composables/useImageUrlLoader";

/**
 * 画廊图片列表管理（分页/增量/大页）+ 图片 URL 加载（委托给 useImageUrlLoader）。
 *
 * 规则：
 * - 缩略图：一律 Blob URL（由 core 的全局 LRU 缓存创建/淘汰）
 * - 原图：一律 asset URL（convertFileSrc）
 */
export function useGalleryImages(
  galleryContainerRef: Ref<HTMLElement | null>,
  isLoadingMore: Ref<boolean>,
  preferOriginalInGrid: Ref<boolean> = ref(false),
  gridColumns?: Ref<number>,
  isInteracting?: Ref<boolean>,
  currentBigPageOffset?: Ref<number>
) {
  const crawlerStore = useCrawlerStore();

  // 本地图片列表：避免直接修改 store 的 images 导致额外渲染
  const displayedImages = shallowRef<ImageInfo[]>([]);
  let displayedImageIds = new Set<string>();
  const setDisplayedImages = (next: ImageInfo[]) => {
    displayedImages.value = next;
    displayedImageIds = new Set(next.map((i) => i.id));
  };

  // URL 加载器（内部使用 core 的全局 imageUrlMap LRU）
  const {
    imageSrcMap,
    loadImageUrls,
    removeFromCacheByIds,
    recreateImageUrl,
    reset: resetUrlLoader,
    cleanup: cleanupUrlLoader,
  } = useImageUrlLoader({
    containerRef: galleryContainerRef,
    imagesRef: displayedImages as any,
    preferOriginalInGrid,
    gridColumns,
    isInteracting,
  });

  /**
   * 刷新列表并尽量复用已有项，避免全量图片重新加载。
   * @param reset 是否从第一页重置加载
   * @param opts.preserveScroll 是否保留当前滚动位置
   * @param opts.forceReload 是否强制重新生成 URL（仅清理当前列表的 id，不清全局缓存）
   * @param opts.skipScrollReset 是否跳过滚动处理
   */
  const refreshImagesPreserveCache = async (
    reset = true,
    opts: {
      preserveScroll?: boolean;
      forceReload?: boolean;
      skipScrollReset?: boolean;
    } = {}
  ) => {
    const preserveScroll = opts.preserveScroll ?? false;
    const forceReload = opts.forceReload ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;

    const container = preserveScroll ? galleryContainerRef.value : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    // 强制重载：只清理“当前画廊列表”涉及的 id（全局缓存仍共享，但不会被整库清空）
    if (forceReload && displayedImages.value.length > 0) {
      removeFromCacheByIds(displayedImages.value.map((i) => i.id));
      setDisplayedImages([]);
      await nextTick();
    }

    const oldIds = forceReload
      ? new Set<string>()
      : new Set(displayedImages.value.map((img) => img.id));

    await crawlerStore.loadImages(reset);
    setDisplayedImages([...crawlerStore.images]);
    await nextTick();

    const imagesToLoad = forceReload
      ? displayedImages.value
      : displayedImages.value.filter((img) => !oldIds.has(img.id));
    void loadImageUrls(imagesToLoad);

    if (!skipScrollReset) {
      if (preserveScroll && container) {
        container.scrollTop = prevScrollTop;
      } else if (reset) {
        const c = container ?? galleryContainerRef.value;
        if (c) c.scrollTop = 0;
      }
    }
  };

  // 执行锁，防止 refreshLatestIncremental 并发执行
  let isRefreshingIncremental = false;

  /**
   * 仅增量获取最新一页图片并追加到末尾，避免全量刷新和旧图重载。
   *
   * 规则：
   * - hasMore=true 时不自动增长画廊（新图藏在“加载更多”里）
   * - hasMore=false 时画廊自动增长
   */
  const refreshLatestIncremental = async () => {
    if (isRefreshingIncremental) return;
    isRefreshingIncremental = true;
    try {
      if (displayedImages.value.length === 0) {
        await refreshImagesPreserveCache(true);
        return;
      }
      if (crawlerStore.hasMore) return;

      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      const fetchSize = Math.max(
        crawlerStore.pageSize,
        displayedImages.value.length + 100
      );
      const result = await invoke<RangedImages>("get_images_range", {
        offset: 0,
        limit: fetchSize,
      });

      const currentExistingIds = new Set(
        displayedImages.value.map((img) => img.id)
      );
      const newOnes = result.images.filter(
        (img) => !existingIds.has(img.id) && !currentExistingIds.has(img.id)
      );

      const totalAfterAdd = displayedImages.value.length + newOnes.length;
      if (totalAfterAdd >= result.total) {
        crawlerStore.hasMore = false;
      }
      if (newOnes.length === 0) return;

      const finalExistingIds = new Set(
        displayedImages.value.map((img) => img.id)
      );
      const trulyNewOnes = newOnes.filter((img) => !finalExistingIds.has(img.id));
      if (trulyNewOnes.length === 0) return;

      setDisplayedImages([...displayedImages.value, ...trulyNewOnes]);
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.totalImages = result.total;

      void loadImageUrls(trulyNewOnes);
    } catch (error) {
      console.error("增量刷新最新图片失败:", error);
    } finally {
      isRefreshingIncremental = false;
    }
  };

  /**
   * 加载更多图片（手动加载）
   * - 支持初始加载（displayedImages 为空）
   * - 支持大页限制（bigPageSize > 0）
   */
  const loadMoreImages = async (isInitialLoad = false, bigPageSize = 0) => {
    if (!isInitialLoad && (!crawlerStore.hasMore || isLoadingMore.value)) return;
    if (!isInitialLoad && isLoadingMore.value) return;

    isLoadingMore.value = true;
    const container = galleryContainerRef.value;
    if (!container) {
      isLoadingMore.value = false;
      return;
    }

    const prevScrollTop = container.scrollTop;
    const isFirstPage = displayedImages.value.length === 0;

    try {
      const bigPageStart =
        bigPageSize > 0 && currentBigPageOffset ? currentBigPageOffset.value : 0;
      const offset = bigPageStart + displayedImages.value.length;

      if (isInitialLoad || isFirstPage) {
        crawlerStore.images = [];
        crawlerStore.hasMore = false;
      }

      const result = await invoke<RangedImages>("get_images_range", {
        offset,
        limit: crawlerStore.pageSize,
      });

      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      const newImages = result.images.filter((img) => !existingIds.has(img.id));

      if (newImages.length > 0) {
        const totalDisplayed = displayedImages.value.length + newImages.length;
        let hasMore = totalDisplayed < result.total;

        if (bigPageSize > 0 && currentBigPageOffset) {
          const currentBigPageStart = currentBigPageOffset.value;
          const currentBigPageEnd = currentBigPageStart + bigPageSize;
          const currentEndOffset = currentBigPageStart + totalDisplayed;
          const remainingInBigPage = Math.max(
            0,
            Math.min(currentBigPageEnd, result.total) - currentEndOffset
          );
          hasMore = remainingInBigPage > 0;
        }

        crawlerStore.hasMore = hasMore;
        setDisplayedImages([...displayedImages.value, ...newImages]);
        await nextTick();

        if (isFirstPage) {
          if (container) container.scrollTop = 0;
        } else {
          setTimeout(() => {
            if (container) container.scrollTop = prevScrollTop;
          }, 100);
        }

        void loadImageUrls(newImages);
      } else {
        let totalDisplayed = displayedImages.value.length;
        let hasMore = totalDisplayed < result.total;
        if (bigPageSize > 0 && currentBigPageOffset) {
          const currentBigPageStart = currentBigPageOffset.value;
          const currentBigPageEnd = currentBigPageStart + bigPageSize;
          const currentEndOffset = currentBigPageStart + totalDisplayed;
          const remainingInBigPage = Math.max(
            0,
            Math.min(currentBigPageEnd, result.total) - currentEndOffset
          );
          hasMore = remainingInBigPage > 0;
        }
        crawlerStore.hasMore = hasMore;
      }

      crawlerStore.images = [...displayedImages.value];
      crawlerStore.totalImages = result.total;
    } catch (error) {
      console.error("加载更多图片失败:", error);
    } finally {
      setTimeout(() => {
        isLoadingMore.value = false;
      }, 100);
    }
  };

  // loadAll 的取消标志
  let abortLoadAll = false;

  const loadAllImages = async (bigPageSize = 0) => {
    if (!crawlerStore.hasMore || isLoadingMore.value) return;
    const container = galleryContainerRef.value;
    if (!container) return;

    abortLoadAll = false;
    const prevScrollTop = container.scrollTop;

    try {
      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      const bigPageStart =
        bigPageSize > 0 && currentBigPageOffset ? currentBigPageOffset.value : 0;
      const currentOffset = bigPageStart + displayedImages.value.length;

      let limitToLoad: number;
      if (bigPageSize > 0) {
        const bigPageEnd = bigPageStart + bigPageSize;
        limitToLoad = Math.max(0, bigPageEnd - currentOffset);
      } else {
        limitToLoad = 1000000;
      }
      if (limitToLoad <= 0) return;

      const result = await invoke<RangedImages>("get_images_range", {
        offset: currentOffset,
        limit: limitToLoad,
      });

      if (abortLoadAll) return;

      crawlerStore.totalImages = result.total;
      if (!result.images || result.images.length === 0) {
        crawlerStore.hasMore = false;
        return;
      }

      const newImages = result.images.filter((img) => !existingIds.has(img.id));
      if (newImages.length > 0) {
        setDisplayedImages([...displayedImages.value, ...newImages]);
        await nextTick();
        void loadImageUrls(newImages);
      }

      const delta = Math.abs(container.scrollTop - prevScrollTop);
      if (delta < 4) container.scrollTop = prevScrollTop;

      const totalDisplayed = displayedImages.value.length;
      if (bigPageSize > 0 && currentBigPageOffset) {
        const currentBigPageStart = currentBigPageOffset.value;
        const currentBigPageEnd = currentBigPageStart + bigPageSize;
        const remainingInBigPage = Math.max(
          0,
          Math.min(currentBigPageEnd, crawlerStore.totalImages) -
            (currentBigPageStart + totalDisplayed)
        );
        crawlerStore.hasMore = remainingInBigPage > 0;
      } else {
        crawlerStore.hasMore = totalDisplayed < crawlerStore.totalImages;
      }

      crawlerStore.images = [...displayedImages.value];
    } catch (error) {
      console.error("加载全部图片失败:", error);
    }
  };

  const cancelLoadAll = () => {
    abortLoadAll = true;
  };

  const jumpToBigPage = async (bigPage: number, bigPageSize = 10000) => {
    const targetOffset = (bigPage - 1) * bigPageSize;
    const container = galleryContainerRef.value;
    try {
      setDisplayedImages([]);
      await nextTick();

      // 只重置 loader 的内部状态（不清全局缓存）
      resetUrlLoader();

      if (container) container.scrollTop = 0;

      const result = await invoke<RangedImages>("get_images_range", {
        offset: targetOffset,
        limit: crawlerStore.pageSize,
      });

      const currentBigPageStart = targetOffset;
      const currentBigPageEnd = currentBigPageStart + bigPageSize;
      const remainingInBigPage = Math.max(
        0,
        Math.min(currentBigPageEnd, result.total) - currentBigPageStart
      );

      setDisplayedImages([...result.images]);
      crawlerStore.images = [...result.images];
      crawlerStore.totalImages = result.total;

      const loadedInBigPage = result.images.length;
      crawlerStore.hasMore = loadedInBigPage < remainingInBigPage;

      await nextTick();
      void loadImageUrls(result.images);
    } catch (error) {
      console.error("跳转大页失败:", error);
    }
  };

  // 批量从 UI 列表与缓存里移除（用于后端批量去重/删除后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    setDisplayedImages(displayedImages.value.filter((img) => !idSet.has(img.id)));
    removeFromCacheByIds(imageIds);
  };

  const cleanup = () => {
    cleanupUrlLoader();
  };

  return {
    displayedImages,
    imageSrcMap,
    loadImageUrls,
    refreshImagesPreserveCache,
    refreshLatestIncremental,
    loadMoreImages,
    loadAllImages,
    cancelLoadAll,
    jumpToBigPage,
    removeFromUiCacheByIds,
    recreateImageUrl,
    cleanup,
  };
}

