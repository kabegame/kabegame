import { computed, nextTick, ref, watch, type Ref } from "vue";
import type { ImageInfo } from "@/types/image";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { withPaged } from "@/utils/galleryPath";

type PagedRouteStore = {
  computedPath: string;
};

type PreviewBoundary = {
  direction: "prev" | "next";
  targetPage: number;
};

type PagedGalleryMessages = {
  loading?: string;
  next?: string;
  prev?: string;
};

type UsePagedGalleryParams = {
  routeStore: PagedRouteStore;
  pageSize: Ref<number>;
  totalImagesCount: Ref<number>;
  images: Ref<ImageInfo[]>;
  loadedKey: Ref<string>;
  viewRef: Ref<any>;
  rootPathFallback?: () => string;
  messages?: PagedGalleryMessages;
};

// 页面导航、clamp；只产出行路径，加载由使用方按路径请求。
export function usePagedGallery(params: UsePagedGalleryParams) {
  const totalImagesCount = params.totalImagesCount;
  const currentPage = ref(1);
  const pageSize = params.pageSize;
  const viewBody = computed(() => params.routeStore.computedPath || params.rootPathFallback?.() || "");
  const rowsPath = computed(() => (viewBody.value ? withPaged(viewBody.value, pageSize.value, currentPage.value) : ""));
  const bigPageEnabled = computed(() => totalImagesCount.value > pageSize.value);
  const pendingPreviewBoundary = ref<PreviewBoundary | null>(null);
  const messages = {
    loading: "loading~~~",
    next: "已进入下一页",
    prev: "已进入上一页",
    ...params.messages,
  };

  const handleJumpToPage = async (page: number) => {
    currentPage.value = page;
  };

  watch(
    viewBody,
    () => {
      pendingPreviewBoundary.value = null;
      currentPage.value = 1;
    },
    { flush: "sync" },
  );

  watch(
    pageSize,
    (next, previous) => {
      currentPage.value = Math.floor(((currentPage.value - 1) * previous) / next) + 1;
    },
    { flush: "sync" },
  );

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
    },
  );

  let ensuringPage = false;
  // 手动兜底clamp到最后一页有效页
  const ensureValidPageAfterMassRemoval = async () => {
    if (ensuringPage) return;
    ensuringPage = true;
    try {
      if (params.images.value.length > 0) return;

      if (totalImagesCount.value <= 0) {
        currentPage.value = 1;
        return;
      }

      const targetPage = Math.min(currentPage.value, Math.max(1, Math.ceil(totalImagesCount.value / pageSize.value)));
      await handleJumpToPage(targetPage);
    } finally {
      ensuringPage = false;
    }
  };

  // 到达页面边界，尝试加载下一页或上一页
  const handlePreviewPageBoundary = async (payload: { direction: "prev" | "next"; image: ImageInfo }) => {
    if (pendingPreviewBoundary.value) {
      ElMessage({
        type: "info",
        message: messages.loading,
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil((totalImagesCount.value || 0) / pageSize.value));
    const targetPage = payload.direction === "next" ? currentPage.value + 1 : currentPage.value - 1;
    if (targetPage < 1 || targetPage > totalPages) return;

    pendingPreviewBoundary.value = {
      direction: payload.direction,
      targetPage,
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
      if (params.loadedKey.value !== rowsPath.value) return;
      const image = pending.direction === "next" ? list[0] : list[list.length - 1];
      if (!image) return;

      const loadedPath = params.loadedKey.value;
      await nextTick();
      if (
        pendingPreviewBoundary.value !== pending ||
        currentPage.value !== pending.targetPage ||
        params.loadedKey.value !== loadedPath ||
        loadedPath !== rowsPath.value
      )
        return;
      params.viewRef.value?.openPreviewById?.(image.id);
      pendingPreviewBoundary.value = null;
      ElMessage.info(pending.direction === "next" ? messages.next : messages.prev);
    },
    { flush: "post" },
  );

  // 离开边界目标页时放弃这次交接
  watch(rowsPath, () => {
    const pending = pendingPreviewBoundary.value;
    if (pending && currentPage.value !== pending.targetPage) {
      pendingPreviewBoundary.value = null;
    }
  });

  return {
    totalImagesCount,
    viewBody,
    rowsPath,
    currentPage,
    pageSize,
    bigPageEnabled,
    pendingPreviewBoundary,
    handleJumpToPage,
    handlePreviewPageBoundary,
    ensureValidPageAfterMassRemoval,
  };
}
