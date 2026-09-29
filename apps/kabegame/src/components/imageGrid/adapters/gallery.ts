import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import {
  resetGalleryRouteToDefault,
  useGalleryRouteStore,
} from "@/stores/galleryRoute";
import {
  buildGalleryCountPath,
  hasActiveQuery,
} from "@/utils/galleryPath";
import type { ImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import type { GridAdapter } from "../types";
import { IS_WEB } from "@kabegame/core/env";

/**
 * Gallery（`/gallery`）的 grid adapter。
 * 必须在 Gallery.vue 的 setup 中调用。
 */
export function createGalleryAdapter(params: {
  analytics: ImageAnalytics;
}): GridAdapter {
  const routeStore = useGalleryRouteStore();
  const t = i18n.global.t;

  const isDefaultGalleryRoute = () =>
    !hasActiveQuery(routeStore.query) && routeStore.page === 1;

  const resetGalleryRouteAfterLoadError = async () => {
    if (isDefaultGalleryRoute()) return;
    ElMessage.warning(t("gallery.galleryPathLoadFailedClearFilters"));
    await resetGalleryRouteToDefault();
  };

  return {
    id: "gallery",
    routeStore,
    isActive: () => router.currentRoute.value.path === "/gallery",
    computeCountPath: () => {
      const rootPath = buildGalleryCountPath(routeStore.effectiveNoAlbum, routeStore.query);
      return routeStore.hide ? `hide/${rootPath}` : rootPath;
    },
    onCountError: resetGalleryRouteAfterLoadError,
    onLoadError: async (error, path) => {
      console.error("加载路径失败:", path, error);
      await resetGalleryRouteAfterLoadError();
    },
    // 空 `?path=` 表示回到默认画廊路径（如点击侧栏「画廊」）
    syncEmptyQueryPath: IS_WEB,
    changes: {
      relevant: (batch) =>
        batch.images.size > 0 ||
        (routeStore.effectiveNoAlbum && batch.albumIds.size > 0) ||
        batch.albumStructure.size > 0,
    },
    actionsOptions: () => ({ removeText: t("gallery.delete") }),
    remove: {
      dialogText: (count) => ({
        title: t("gallery.confirmDelete"),
        message:
          count > 1
            ? t("gallery.removeFromGalleryMessageMulti", { count })
            : t("gallery.removeFromGalleryMessageSingle"),
      }),
    },
    analytics: params.analytics,
  };
}
