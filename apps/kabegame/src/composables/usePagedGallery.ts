import { computed, nextTick, ref, watch, type Ref } from "vue";
import { pathqlEntry } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";
import type { ImageInfo } from "@kabegame/core/types/image";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";

type PagedRouteStore = {
  computedPath: string;
  page: number;
  pageSize: number;
  navigate: (patch: { page: number }) => Promise<unknown>;
};

type PagedGalleryLoading = {
  startLoading: () => void;
  finishLoading: () => void;
};

type PreviewBoundary = {
  direction: "prev" | "next";
  targetPage: number;
  targetPath?: string;
};

type PagedGalleryMessages = {
  loading?: string;
  next?: string;
  prev?: string;
};

type UsePagedGalleryParams = {
  routeStore: PagedRouteStore;
  images: Ref<ImageInfo[]>;
  loadedKey: Ref<string>;
  viewRef: Ref<any>;
  loading: PagedGalleryLoading;
  load: (path: string) => Promise<void>;
  computeCountPath: (path: string) => string;
  isActive: () => boolean;
  computeTargetPath?: (page: number) => string;
  onCountError?: (error: unknown) => Promise<number | void> | number | void;
  onLoadError?: (error: unknown, path: string) => Promise<void> | void;
  messages?: PagedGalleryMessages;
};

// 页面导航、clamp
export function usePagedGallery(params: UsePagedGalleryParams) {
  const totalImagesCount = ref(0);
  // 各页面不同 :path/
  const currentPath = computed(() => params.routeStore.computedPath);
  // {path/x{pageSize}x/{page}
  const currentPage = computed(() => params.routeStore.page);
  const pageSize = computed(() => params.routeStore.pageSize);
  const bigPageEnabled = computed(() => totalImagesCount.value > pageSize.value);
  const pendingPreviewBoundary = ref<PreviewBoundary | null>(null);
  const messages = {
    loading: "loading~~~",
    next: "已进入下一页",
    prev: "已进入上一页",
    ...params.messages,
  };

  const loadTotalImagesCount = async () => {
    try {
      const countPath = params.computeCountPath(currentPath.value);
      if (!countPath) return;
      const res = await pathqlEntry(withGalleryPrefix(countPath));
      totalImagesCount.value = res?.total ?? 0;
    } catch (error) {
      const fallback = await params.onCountError?.(error);
      if (typeof fallback === "number") {
        totalImagesCount.value = fallback;
      }
    }
  };

  const handleJumpToPage = async (page: number) => {
    params.loading.startLoading();
    try {
      await params.routeStore.navigate({ page });
    } finally {
      params.loading.finishLoading();
    }
  };

  // clamp到最后一页
  watch(
    () => totalImagesCount.value,
    async (total) => {
      if (!bigPageEnabled.value) {
        if (currentPage.value !== 1) {
          await handleJumpToPage(1);
        }
        return;
      }
      const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize.value));
      if (currentPage.value > totalPages) {
        await handleJumpToPage(totalPages);
      }
    }
  );

  let ensuringPage = false;
  // 手动兜底clamp到最后一页有效页
  const ensureValidPageAfterMassRemoval = async () => {
    if (ensuringPage) return;
    ensuringPage = true;
    try {
      await loadTotalImagesCount();

      if (params.images.value.length > 0) return;

      if (totalImagesCount.value <= 0) {
        await params.routeStore.navigate({ page: 1 });
        return;
      }

      const targetPage = Math.min(
        currentPage.value,
        Math.max(1, Math.ceil(totalImagesCount.value / pageSize.value)),
      );
      await handleJumpToPage(targetPage);
    } finally {
      ensuringPage = false;
    }
  };

  // 到达页面边界，尝试加载下一页或上一页
  const handlePreviewPageBoundary = async (payload: {
    direction: "prev" | "next";
    index: number;
    image: ImageInfo;
  }) => {
    if (pendingPreviewBoundary.value) {
      ElMessage({
        type: "info",
        message: messages.loading,
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil((totalImagesCount.value || 0) / pageSize.value));
    const targetPage = payload.direction === "next"
      ? currentPage.value + 1
      : currentPage.value - 1;
    if (targetPage < 1 || targetPage > totalPages) return;

    pendingPreviewBoundary.value = {
      direction: payload.direction,
      targetPage,
      targetPath: params.computeTargetPath?.(targetPage),
    };
    try {
      await handleJumpToPage(targetPage);
    } catch (error) {
      pendingPreviewBoundary.value = null;
      throw error;
    }
  };

  watch(
    () => [params.images.value, params.loadedKey.value] as const,
    async ([list]) => {
      const pending = pendingPreviewBoundary.value;
      if (!pending) return;
      if (currentPage.value !== pending.targetPage) return;
      if (params.loadedKey.value !== currentPath.value) return;
      const image = pending.direction === "next" ? list[0] : list[list.length - 1];
      if (!image) return;

      pendingPreviewBoundary.value = null;
      await nextTick();
      params.viewRef.value?.openPreviewById?.(image.id);
      ElMessage.info(pending.direction === "next" ? messages.next : messages.prev);
    },
    { flush: "post" }
  );

  watch(
    currentPath,
    async (newPath) => {
      if (!params.isActive()) return;
      if (!newPath) return;
      if (params.loadedKey.value === newPath) return;

      params.loading.startLoading();
      try {
        await params.load(newPath);
        await loadTotalImagesCount();
      } catch (error) {
        await params.onLoadError?.(error, newPath);
      } finally {
        params.loading.finishLoading();
      }
    },
    { immediate: true }
  );

  return {
    totalImagesCount,
    currentPath,
    currentPage,
    pageSize,
    bigPageEnabled,
    pendingPreviewBoundary,
    loadTotalImagesCount,
    handleJumpToPage,
    handlePreviewPageBoundary,
    ensureValidPageAfterMassRemoval,
  };
}
