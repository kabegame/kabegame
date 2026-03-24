import { nextTick, ref, shallowRef, unref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "@kabegame/core/types/image";

type GalleryBrowseEntry =
  | { kind: "dir"; name: string }
  | { kind: "image"; image: ImageInfo };

type GalleryBrowseResult = {
  total: number;
  baseOffset: number;
  rangeTotal: number;
  entries: GalleryBrowseEntry[];
};

/**
 * 画廊图片列表管理（基于路径的查询）。
 * @param pageSize SimplePage 每页条数（与设置一致）
 */
export function useGalleryImages(
  galleryContainerRef: Ref<HTMLElement | null>,
  isLoadingMore: Ref<boolean>,
  pageSize: Ref<number>,
) {
  // 本地图片列表：由视图直接消费，避免引入额外全局同步开销
  const displayedImages = shallowRef<ImageInfo[]>([]);
  let displayedImageIds = new Set<string>();
  const setDisplayedImages = (next: ImageInfo[]) => {
    displayedImages.value = next;
    displayedImageIds = new Set(next.map((i) => i.id));
  };

  // 当前 leaf 的完整图片列表（最多 pageSize；最后一页可能更少）
  let leafAllImages: ImageInfo[] = [];

  const totalImages = ref(0);
  const loadedKey = ref("");

  const setLeafAndResetDisplay = async (images: ImageInfo[]) => {
    leafAllImages = images;
    // 直接显示整个 leaf
    setDisplayedImages(images);
    await nextTick();
  };

  /**
   * 根据路径加载图片列表
   * @returns { total: number, baseOffset: number } - 直接返回图片数据
   */
  const fetchByPath = async (
    path: string,
    opts?: { loadKey?: string },
  ) => {
    const safePath = (path || "all/1").trim() || "all/1";
    try {
      const res = await invoke<GalleryBrowseResult>("browse_gallery_provider", {
        path: safePath,
        pageSize: unref(pageSize),
      });
      totalImages.value = res.total ?? 0;

      // 直接处理图片条目（新路径格式总是返回图片）
      const images = (res.entries || [])
        .filter((e) => e.kind === "image")
        .map((e) => (e as any).image as ImageInfo);

      await setLeafAndResetDisplay(images);
      loadedKey.value = opts?.loadKey ?? safePath;

      return {
        total: totalImages.value,
        baseOffset: res.baseOffset ?? 0,
      };
    } catch (e) {
      throw e;
    }
  };

  /**
   * 刷新列表并尽量复用已有项，避免全量图片重新加载。
   * @param path 要加载的路径
   * @param opts.preserveScroll 是否保留当前滚动位置
   * @param opts.forceReload 是否强制重新生成 URL（仅清理当前列表的 id，不清全局缓存）
   * @param opts.skipScrollReset 是否跳过滚动处理
   */
  const refreshImagesPreserveCache = async (
    path: string,
    opts: {
      preserveScroll?: boolean;
      forceReload?: boolean;
      skipScrollReset?: boolean;
    } = {},
  ) => {
    const preserveScroll = opts.preserveScroll ?? false;
    const forceReload = opts.forceReload ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;

    const container = preserveScroll ? galleryContainerRef.value : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    // 强制重载：
    // - 只清理"当前画廊列表"涉及的 id 对应的 URL 缓存
    // - 关键：不要清空 displayedImages，否则会导致整页 ImageItem 卸载/重建（破坏 key 复用）
    // - fetchByPath 会随后用最新数据替换数组引用，让 Vue 仅按 key diff（删除缺失项/复用已有项）
    if (forceReload && displayedImages.value.length > 0) {
      // 简化后不再维护 URL 缓存，这里不需要额外处理
    }

    await fetchByPath(path);

    if (!skipScrollReset) {
      if (preserveScroll && container) {
        container.scrollTop = prevScrollTop;
      } else {
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
  const refreshLatestIncremental = async (currentPath: string) => {
    if (isRefreshingIncremental) return;
    isRefreshingIncremental = true;
    try {
      // Provider 模式下：增量刷新直接重拉当前页的 leaf（显示全部）
      await fetchByPath(currentPath);
      // fetchByPath 已经通过 setLeafAndResetDisplay 设置了全部图片
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
  const loadMoreImages = async (
    isInitialLoad = false,
    currentPath?: string,
  ) => {
    if (isLoadingMore.value) return;

    isLoadingMore.value = true;
    const container = galleryContainerRef.value;
    const prevScrollTop = container?.scrollTop ?? 0;

    try {
      if (isInitialLoad || displayedImages.value.length === 0) {
        if (currentPath) {
          await fetchByPath(currentPath);
        }
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

  const loadAllImages = async (_bigPageSize = 0, currentPath?: string) => {
    // 已经一次性加载了整个 leaf，不需要额外处理
    // 保留函数以兼容现有调用
    if (leafAllImages.length === 0 && currentPath) {
      await fetchByPath(currentPath);
    }
  };

  const cancelLoadAll = () => {
    abortLoadAll = true;
  };

  const jumpToBigPage = async (
    page: number,
    _bigPageSize = unref(pageSize),
    _currentRootPath?: string,
    _total?: number,
  ) => {
    // 直接跳转到指定页码（由调用方提供 navigateToPage 函数）
    // 这里仅作为兼容性接口，实际跳转由外部 composable 处理
    return page;
  };

  // 批量从 UI 列表与缓存里移除（用于后端批量去重/删除后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    // 同步更新 leaf 缓存
    leafAllImages = leafAllImages.filter((img) => !idSet.has(img.id));

    setDisplayedImages(
      displayedImages.value.filter((img) => !idSet.has(img.id)),
    );
  };

  const cleanup = () => {};

  return {
    displayedImages,
    fetchByPath,
    refreshImagesPreserveCache,
    refreshLatestIncremental,
    loadMoreImages,
    loadAllImages,
    cancelLoadAll,
    jumpToBigPage,
    removeFromUiCacheByIds,
    cleanup,
    totalImages,
    loadedKey,
  };
}
