import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { useFailedImagesStore } from "@/stores/failedImages";
import { stripComposablePathTail } from "@/utils/galleryPath";
import type { GridAdapter } from "../types";
import { addedTrigger, patchTriggers, hiddenTrigger } from "@/services/kbEvents";

/**
 * TaskDetail（`/tasks/:id`）的 grid adapter。
 * 必须在 TaskDetail.vue 的 setup 中调用（route store 不能过早实例化）。
 */
export function createTaskDetailAdapter(params: { taskId: () => string }): GridAdapter {
  const routeStore = useTaskDetailRouteStore();
  const failedImagesStore = useFailedImagesStore();
  const t = i18n.global.t;
  const view = () => ({ query: routeStore.query, sort: routeStore.sort, hide: routeStore.hide });

  return {
    id: "task",
    routeStore,
    viewState: view,
    isActive: () => router.currentRoute.value.name === "TaskDetail" && !!params.taskId(),
    rootPathFallback: () => (params.taskId() ? `task/${params.taskId()}` : ""),
    computeCountPath: stripComposablePathTail,
    onCountError: (error) => {
      console.error("加载任务总图片数失败:", error);
    },
    onLoadError: (error, path) => {
      console.error("加载任务图片失败:", path, error);
      // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
      ElMessage.error(t("tasks.loadImagesFailed"));
    },
    refreshOn: [
      addedTrigger(view, (image) => !!params.taskId() && image.taskId === params.taskId()),
      ...patchTriggers(view),
      ...hiddenTrigger(view),
    ],
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
        message: count > 1 ? t("tasks.removeDialogMessageMulti", { count }) : t("tasks.removeDialogMessageSingle"),
      }),
    },
  };
}
