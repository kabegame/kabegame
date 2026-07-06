import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useSurfImagesRouteStore } from "@/stores/surfImagesRoute";
import type { GridSurfaceAdapter } from "../types";

/**
 * SurfImages（`/surf/:host/images`）的 grid surface。
 * 必须在 SurfImages.vue 的 setup 中调用（route store 不能过早实例化）。
 */
export function createSurfImagesSurface(params: {
  /** 当前 surf record id（images-change 事件按 surfRecordIds 过滤） */
  recordId: () => string;
}): GridSurfaceAdapter {
  const routeStore = useSurfImagesRouteStore();
  const t = i18n.global.t;

  return {
    id: "surf",
    routeStore,
    isActive: () =>
      router.currentRoute.value.name === "SurfImages" && !!routeStore.host,
    rootPathFallback: () => (routeStore.host ? `surf/${routeStore.host}/1` : ""),
    computeCountPath: () => `surf/${routeStore.host}`,
    onCountError: (_error, ctx) => ctx.images.value.length,
    onLoadError: (error) => {
      const e = error as { message?: string } | null;
      ElMessage.error(e?.message || String(error) || t("surf.loadImagesFailed"));
    },
    imagesChange: {
      waitMs: 500,
      filter: (p) => {
        const rid = params.recordId();
        return !!rid && (p.surfRecordIds?.includes(rid) ?? false);
      },
    },
    albumImagesChange: { waitMs: 500 },
    actionsOptions: () => ({
      removeText: t("surf.removeText"),
      multiHide: ["favorite", "addToAlbum"],
    }),
    remove: {
      dialogText: (count) => ({
        title: t("surf.confirmDelete"),
        message:
          count > 1
            ? t("surf.removeMessageMulti", { count })
            : t("surf.removeMessageSingle"),
      }),
    },
  };
}
