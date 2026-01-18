import { nextTick, ref, shallowRef, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useImageUrlLoader } from "@kabegame/core/composables/useImageUrlLoader";
import { buildLeafProviderPathForPage } from "@/utils/gallery-provider-path";

type GalleryBrowseEntry =
  | { kind: "dir"; name: string }
  | { kind: "image"; image: ImageInfo };

type GalleryBrowseResult = {
  total: number;
  baseOffset: number;
  rangeTotal: number;
  entries: GalleryBrowseEntry[];
};

const LEAF_SIZE = 1000;

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
  providerRootPathRef: Ref<string>,
  currentPageRef: Ref<number>,
  preferOriginalInGrid: Ref<boolean> = ref(false),
  gridColumns?: Ref<number>,
  isInteracting?: Ref<boolean>
) {
  const crawlerStore = useCrawlerStore();

  // 本地图片列表：避免直接修改 store 的 images 导致额外渲染
  const displayedImages = shallowRef<ImageInfo[]>([]);
  let displayedImageIds = new Set<string>();
  const setDisplayedImages = (next: ImageInfo[]) => {
    displayedImages.value = next;
    displayedImageIds = new Set(next.map((i) => i.id));
  };

  // 当前 leaf 的完整图片列表（最多 1000；最后一页可能 <1000）
  let leafAllImages: ImageInfo[] = [];

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

  const totalImages = ref(0);

  const setLeafAndResetDisplay = async (images: ImageInfo[]) => {
    leafAllImages = images;
    // 直接显示整个 leaf（最多 1000 张）
    setDisplayedImages(images);
    crawlerStore.images = images.slice();
    crawlerStore.hasMore = false;
    await nextTick();
    void loadImageUrls(images);
  };

  const fetchLeafByPage = async (page: number) => {
    const root = (providerRootPathRef.value || "全部").trim() || "全部";

    // 关键：每次都先 probe root 拿最新 total，避免去重后 total 大幅变化导致旧 total 计算出的 path 失效
    const probe = await invoke<GalleryBrowseResult>("browse_gallery_provider", {
      path: root,
    });
    totalImages.value = probe.total ?? 0;
    crawlerStore.totalImages = totalImages.value;

    if (totalImages.value <= 0) {
      await setLeafAndResetDisplay([]);
      return;
    }

    // total <= 1000：root 就是 leaf，直接展示（避免再算路径）
    if (totalImages.value <= LEAF_SIZE) {
      const images = (probe.entries || [])
        .filter((e) => e.kind === "image")
        .map((e) => (e as any).image as ImageInfo);
      await setLeafAndResetDisplay(images);
      return;
    }

    try {
      const { path } = buildLeafProviderPathForPage(
        root,
        totalImages.value,
        page
      );
      const res = await invoke<GalleryBrowseResult>("browse_gallery_provider", {
        path,
      });
      totalImages.value = res.total ?? totalImages.value;
      crawlerStore.totalImages = totalImages.value;

      // 只取 image 条目（UI 不展示 dir）
      const images = (res.entries || [])
        .filter((e) => e.kind === "image")
        .map((e) => (e as any).image as ImageInfo);

      await setLeafAndResetDisplay(images);
    } catch (e) {
      // 如果在去重过程中 total 继续变化导致 path 失效，兜底回到第 1 页再试一次
      if (page !== 1) {
        await fetchLeafByPage(1);
        return;
      }
      throw e;
    }
  };

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

    // 强制重载：
    // - 只清理“当前画廊列表”涉及的 id 对应的 URL 缓存
    // - 关键：不要清空 displayedImages，否则会导致整页 ImageItem 卸载/重建（破坏 key 复用）
    // - fetchLeafByPage 会随后用最新数据替换数组引用，让 Vue 仅按 key diff（删除缺失项/复用已有项）
    if (forceReload && displayedImages.value.length > 0) {
      removeFromCacheByIds(displayedImages.value.map((i) => i.id));
    }

    if (reset) {
      currentPageRef.value = 1;
    }
    await fetchLeafByPage(currentPageRef.value);

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
   */
  const refreshLatestIncremental = async () => {
    if (isRefreshingIncremental) return;
    isRefreshingIncremental = true;
    try {
      // Provider 模式下：增量刷新直接重拉当前页的 leaf（显示全部）
      await fetchLeafByPage(currentPageRef.value);
      // fetchLeafByPage 已经通过 setLeafAndResetDisplay 设置了全部图片
    } catch (error) {
      console.error("增量刷新最新图片失败:", error);
    } finally {
      isRefreshingIncremental = false;
    }
  };

  /**
   * 加载更多图片（手动加载）
   * - 支持初始加载（displayedImages 为空）
   * - Provider 模式：直接加载整个 leaf
   */
  const loadMoreImages = async (isInitialLoad = false) => {
    if (isLoadingMore.value) return;

    isLoadingMore.value = true;
    const container = galleryContainerRef.value;
    const prevScrollTop = container?.scrollTop ?? 0;

    try {
      if (isInitialLoad || displayedImages.value.length === 0) {
        await fetchLeafByPage(currentPageRef.value);
        if (container) container.scrollTop = 0;
        return;
      }

      // 已经加载了全部 leaf，不需要再加载更多
      // 这个函数现在主要用于初始加载
    } finally {
      setTimeout(() => {
        isLoadingMore.value = false;
      }, 50);
    }
  };

  // loadAll 的取消标志
  let abortLoadAll = false;

  const loadAllImages = async (_bigPageSize = 0) => {
    // 已经一次性加载了整个 leaf，不需要额外处理
    // 保留函数以兼容现有调用
    if (leafAllImages.length === 0) {
      await fetchLeafByPage(currentPageRef.value);
    }
  };

  const cancelLoadAll = () => {
    abortLoadAll = true;
  };

  const jumpToBigPage = async (bigPage: number, _bigPageSize = LEAF_SIZE) => {
    // 这里的 bigPage 实际就是 leaf page（1000 一页）
    currentPageRef.value = Math.max(1, Math.floor(bigPage || 1));
    const container = galleryContainerRef.value;
    try {
      setDisplayedImages([]);
      await nextTick();
      resetUrlLoader();
      if (container) container.scrollTop = 0;
      await fetchLeafByPage(currentPageRef.value);
    } catch (error) {
      console.error("跳转页失败:", error);
    }
  };

  // 批量从 UI 列表与缓存里移除（用于后端批量去重/删除后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    // 同步更新 leaf 缓存
    leafAllImages = leafAllImages.filter((img) => !idSet.has(img.id));

    setDisplayedImages(
      displayedImages.value.filter((img) => !idSet.has(img.id))
    );
    removeFromCacheByIds(imageIds);

    crawlerStore.images = displayedImages.value.slice();
    crawlerStore.hasMore = false;
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
    totalImages,
  };
}
