import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useSurfImagesRouteStore } from "@/stores/surfImagesRoute";
import { stripComposablePathTail } from "@/utils/galleryPath";
import type { GridAdapter } from "../types";
import { addedTrigger, patchTriggers, hiddenTrigger } from "@/services/kbEvents";

/**
 * SurfImages（`/surf/:host/images`）的 grid adapter。
 * 必须在 SurfImages.vue 的 setup 中调用（route store 不能过早实例化）。
 */
export function createSurfImagesAdapter(params: {
  /** 当前 surf record id（images-added 从图片行读取 surfRecordId） */
  recordId: () => string;
}): GridAdapter {
  const routeStore = useSurfImagesRouteStore();
  const t = i18n.global.t;
  const view = () => ({ query: routeStore.query, sort: routeStore.sort, hide: routeStore.hide });

  return {
    id: "surf",
    routeStore,
    viewState: view,
    isActive: () => router.currentRoute.value.name === "SurfImages" && !!routeStore.host,
    rootPathFallback: () => (routeStore.host ? `surf/${routeStore.host}` : ""),
    computeCountPath: stripComposablePathTail,
    onCountError: (_error, ctx) => ctx.images.value.length,
    onLoadError: (error) => {
      const e = error as { message?: string } | null;
      ElMessage.error(e?.message || String(error) || t("surf.loadImagesFailed"));
    },
    refreshOn: [
      addedTrigger(view, (image) => !!params.recordId() && image.surfRecordId === params.recordId()),
      ...patchTriggers(view, { surfRecordId: () => true }),
      ...hiddenTrigger(view),
    ],
    actionsOptions: () => ({
      removeText: t("surf.removeText"),
      multiHide: ["favorite", "addToAlbum"],
    }),
    remove: {
      dialogText: (count) => ({
        title: t("surf.confirmDelete"),
        message: count > 1 ? t("surf.removeMessageMulti", { count }) : t("surf.removeMessageSingle"),
      }),
    },
  };
}
