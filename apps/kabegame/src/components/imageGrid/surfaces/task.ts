import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { useFailedImagesStore } from "@/stores/failedImages";
import { stripComposablePathTail } from "@/utils/galleryPath";
import type { GridSurfaceAdapter } from "../types";

/**
 * TaskDetail（`/tasks/:id`）的 grid surface。
 * 必须在 TaskDetail.vue 的 setup 中调用（route store 不能过早实例化）。
 */
export function createTaskDetailSurface(params: {
  taskId: () => string;
}): GridSurfaceAdapter {
  const routeStore = useTaskDetailRouteStore();
  const failedImagesStore = useFailedImagesStore();
  const t = i18n.global.t;

  return {
    id: "task",
    routeStore,
    isActive: () =>
      router.currentRoute.value.name === "TaskDetail" && !!params.taskId(),
    rootPathFallback: () =>
      params.taskId() ? `task/${params.taskId()}/1` : "",
    computeCountPath: stripComposablePathTail,
    onCountError: (error) => {
      console.error("加载任务总图片数失败:", error);
    },
    onLoadError: (error, path) => {
      console.error("加载任务图片失败:", path, error);
      // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
      ElMessage.error(t("tasks.loadImagesFailed"));
    },
    imagesChange: {
      waitMs: 1000,
      filter: (p, ctx) => {
        const tid = params.taskId();
        if (p.taskIds && p.taskIds.length > 0 && tid && !p.taskIds.includes(tid)) {
          return false;
        }
        const taskScoped =
          !!tid && !!p.taskIds && p.taskIds.length > 0 && p.taskIds.includes(tid);
        if (taskScoped) return true;
        // 无任务维度 hint：仅当 imageIds 命中当前页时刷新（减少无关全局事件）
        const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
        if (ids.length > 0) {
          return ids.some((id) => ctx.images.value.some((img) => img.id === id));
        }
        return true;
      },
    },
    albumImagesChange: { waitMs: 500 },
    // 失败图片计数与当前页数据同源刷新
    onAfterRefresh: async () => {
      await failedImagesStore.loadAll();
    },
    actionsOptions: () => ({
      removeText: t("tasks.removeText"),
      multiHide: ["favorite", "addToAlbum"],
    }),
    remove: {
      dialogText: (count) => ({
        title: t("tasks.confirmDelete"),
        message:
          count > 1
            ? t("tasks.removeDialogMessageMulti", { count })
            : t("tasks.removeDialogMessageSingle"),
      }),
    },
  };
}
