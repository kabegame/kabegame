<template>
  <div class="task-detail" v-pull-to-refresh="pullToRefreshOpts">
    <ImageGrid
      ref="taskViewRef"
      class="detail-body"
      :adapter="adapter"
      :enable-ctrl-wheel-adjust-columns="!isCompact"
      :enable-ctrl-key-adjust-columns="!isCompact"
      enable-virtual-scroll
      scroll-whole-container
      hide-scrollbar
    >
      <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
        <TaskDetailPageHeader
          :task-name="taskName"
          :show-stop-task="shouldShowStopButton"
          :show-open-webview="showOpenWebview"
          :show-rerun="showRerun"
          @refresh="handleRefresh"
          @stop-task="handleStopTask"
          @delete-task="handleDeleteTask"
          @add-to-album="handleHeaderAddToAlbum"
          @view-task-log="handleViewTaskLog"
          @view-task-params="handleViewTaskParams"
          @open-task-webview="handleOpenTaskWebview"
          @rerun="handleRerun"
          @failed-images="handleShowFailedImages"
          @back="goBack"
        >
          <template #subtitle>
            <TaskCountsInline
              :success="successN"
              :failed="failedN"
              :deleted="deletedN"
              :dedup="dedupN"
              :dry-run="task?.isDryRun"
              :duration="durationText"
            />
          </template>
        </TaskDetailPageHeader>

        <GalleryQueryBar
          :query="taskDetailRouteStore.query"
          :no-album="taskDetailRouteStore.effectiveNoAlbum"
          :sort="taskDetailRouteStore.sort"
          :page-size="pageSize"
          :search-modes="taskDetailStickySearchModes"
          :provider-context-prefix="taskDetailRouteStore.computedContextPath"
          :context-base="taskDetailRouteStore.contextPathFor({ query: [] })"
          :filter-features="taskFilterFeatures"
          :sort-features="taskSortFeatures"
          :search-features="taskSearchFeatures"
          enable-clear-all
          @navigate="onQueryNavigate"
          @search-modes-change="rememberTaskDetailSearchModes"
        />

        <GalleryBigPaginator
          :total-count="totalCount"
          :current-page="currentPage"
          :big-page-size="pageSize"
          :is-sticky="true"
          @jump-to-page="jumpToPage"
        />
      </template>

      <template #empty>
        <div class="task-empty fade-in">
          <EmptyState
            :lines="[t('tasks.emptyStateTip')]"
            show-button
            :button-text="t('tasks.emptyStateReportIssue')"
            @button-click="openReportIssueLink"
          />
        </div>
      </template>
    </ImageGrid>

    <TaskLogDialog ref="taskLogDialogRef" />
    <TaskParamsDialog
      :open="taskParamsDialog.isOpen.value"
      :z-index="taskParamsDialog.zIndex.value"
      :task="taskParamsTask"
      @close="taskParamsDialog.close()"
    />
    <!-- 紧凑模式下 FailedImages 在 fold 菜单里，FailedImagesHeaderButton comp 不渲染，对话框由本视图托管 -->
    <FailedImagesDialog v-if="isCompact" ref="failedImagesDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onActivated, onDeactivated, onMounted, onUnmounted, watch } from "vue";
import { useModal } from "@/composables/useModal";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@/api/rpc";
import { ElMessageBox } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import ImageGrid from "@/components/ImageGrid.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import { createTaskDetailAdapter } from "@/components/imageGrid/adapters/task";
import {
  DEFAULT_GALLERY_SEARCH_MODES,
  GALLERY_SEARCH_MODES_BASIC,
  querySearchTerm,
  type GalleryBrowseDimension,
  type GalleryQueryPatch,
  type GallerySortField,
} from "@/utils/galleryPath";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useUiStore } from "@/stores/ui";
import { storeToRefs } from "pinia";
import TaskDetailPageHeader from "@/components/header/TaskDetailPageHeader.vue";
import TaskLogDialog from "@/components/task/TaskLogDialog.vue";
import TaskParamsDialog from "@/components/task/TaskParamsDialog.vue";
import type { TaskRunParamsTask } from "@/components/task/TaskRunParamsContent.vue";
import TaskCountsInline from "@/components/task/TaskCountsInline.vue";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import {
  useTaskDetailRouteStore,
  rememberTaskDetailSearchModes,
  taskDetailStickySearchModes,
} from "@/stores/taskDetailRoute";
import { IS_WEB } from "@/env";
import { canOpenTaskWebview } from "@/utils/webpageCollect";
import { createImageAnalytics } from "@/track/imageAnalytics";
import { useI18n } from "@kabegame/i18n";
import { useFailedImagesStore } from "@/stores/failedImages";
import { useGithubIssueUrl, type GithubIssueField } from "@/composables/useGithubIssueUrl";
import { useTaskRerun } from "@/composables/useTaskRerun";
import { normalizeTaskEvent, normalizeTaskRow } from "@/services/tasks";
import { kbEvent$, on, pathqlRequest$, usePathqlLooker } from "@/services/kbEvents";
import { encodeSeg } from "@kabegame/pathql-client";
import type { CrawlTask } from "@/stores/crawler";

const { t } = useI18n();
const { openIssue } = useGithubIssueUrl();
const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

const isOnTaskRoute = computed(() => {
  const n = String(route.name ?? "");
  return n === "TaskDetail";
});

const taskLogDialogRef = ref<InstanceType<typeof TaskLogDialog> | null>(null);
const handleViewTaskLog = () => {
  const id = String(taskId.value || "").trim();
  if (!id) return;
  taskLogDialogRef.value?.openTaskLog(id);
};

const failedImagesDialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);
const handleShowFailedImages = () => {
  const id = String(taskId.value || "").trim();
  failedImagesDialogRef.value?.setTaskId(id || undefined);
  failedImagesDialogRef.value?.open();
};

// 运行配置里可能出现对象/数组值（如多选项）；httpHeaders 单独持有鉴权信息，永远不带入 issue 正文
const formatConfigValueForReport = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const openReportIssueLink = () => {
  const tsk = task.value;
  const configFields: GithubIssueField[] = Object.entries(tsk?.userConfig ?? {}).map(([key, value]) => ({
    label: key,
    value: formatConfigValueForReport(value),
  }));
  void openIssue({
    title: t("tasks.reportIssueTitle", { plugin: taskName.value || t("tasks.task") }),
    description: t("tasks.emptyStateTip"),
    sections: [
      {
        heading: t("tasks.reportIssueSection"),
        fields: [
          { label: t("tasks.reportIssuePlugin"), value: tsk ? `${taskName.value} (${tsk.pluginId})` : undefined },
          { label: t("tasks.reportIssueStatus"), value: tsk?.status },
          { label: t("tasks.reportIssueTrigger"), value: tsk?.triggerSource },
          { label: t("tasks.reportIssueSuccessCount"), value: tsk?.successCount },
          { label: t("tasks.reportIssueFailedCount"), value: tsk?.failedCount },
          { label: t("tasks.reportIssueDedupCount"), value: tsk?.dedupCount },
          { label: t("tasks.reportIssueDeletedCount"), value: tsk?.deletedCount },
        ],
      },
      {
        heading: t("tasks.reportIssueConfigSection"),
        fields: configFields,
      },
    ],
  });
};

const taskParamsDialog = useModal();
const taskParamsTask = computed<TaskRunParamsTask | null>(() => task.value ?? null);
const handleViewTaskParams = () => {
  if (!taskId.value) return;
  taskParamsDialog.open();
};

// 数据加载 / 菜单命令 / 事件刷新均由 ImageGrid connected 模式接管
const taskDetailRouteStore = useTaskDetailRouteStore();
const adapter = createTaskDetailAdapter({
  taskId: () => taskId.value,
});
const { taskId } = storeToRefs(taskDetailRouteStore);

const taskFilterFeatures: GalleryBrowseDimension[] = ["plugin", "mediaType", "date", "size", "aspect"];
const taskSortFeatures: GallerySortField[] = ["by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time"];
const taskSearchFeatures = GALLERY_SEARCH_MODES_BASIC;

const taskViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);

/** 查询行的唯一出口：一次 patch 一次导航，搜索模式顺带记进会话记忆。 */
const onQueryNavigate = (patch: GalleryQueryPatch, options?: { push?: boolean }) => {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberTaskDetailSearchModes(term.modes);
  void taskDetailRouteStore.navigate(patch, options);
};

const task = ref<CrawlTask | null>(null);
/** 页面是否处于可见存活期，控制任务观察与计时。 */
const isLive = ref(false);
const taskKey = computed(() => (isLive.value && taskId.value ? `tasks://id_${encodeSeg(taskId.value)}` : null));
function requestTask() {
  if (taskKey.value) pathqlRequest$.next(["rows", taskKey.value]);
}
usePathqlLooker({
  kind: "rows",
  key: () => taskKey.value,
  refreshOn: [
    on("tasks-change", (payload) => {
      const event = normalizeTaskEvent(payload);
      return event?.type === "TaskDeleted" && event.taskId === taskId.value;
    }),
  ],
  onResult: ({ rows }) => {
    task.value = normalizeTaskRow(rows[0]);
    if (!rows[0] && taskId.value) {
      if (window.history.length > 1) router.back();
      else void router.replace("/gallery");
    }
  },
});
// 换任务才清空；页面停用再激活时保留旧数据，等这次读取覆盖
watch(taskId, () => (task.value = null), { flush: "sync" });
watch(
  taskKey,
  (key) => {
    if (key) requestTask();
  },
  { immediate: true, flush: "sync" },
);

const taskName = computed(() => {
  const tsk = task.value;
  if (!tsk) return "";
  return tsk.pluginId ? pluginStore.pluginLabel(tsk.pluginId) : t("tasks.task");
});

const taskStatusFromStore = computed(() => task.value?.status ?? "");

// 是否应该显示停止按钮（只在 running 状态显示）
const shouldShowStopButton = computed(() => {
  return taskStatusFromStore.value === "running" || taskStatusFromStore.value === "waiting_downloads";
});

const showOpenWebview = computed(() => {
  const tsk = task.value;
  return !!tsk && canOpenTaskWebview(tsk, pluginStore.plugins);
});

const { canRerun, rerunTask } = useTaskRerun();
const showRerun = computed(() => !!task.value && canRerun(task.value));
const handleRerun = async () => {
  if (task.value) await rerunTask(task.value);
};

async function handleOpenTaskWebview() {
  const id = String(taskId.value || "").trim();
  if (!id) return;
  try {
    await invoke("show_crawler_window", { taskId: id });
    ElMessage.success(t("tasks.openTaskWebviewSuccess"));
  } catch (error) {
    ElMessage.error(String(error));
  }
}

const isRefreshing = ref(false);
const pullToRefreshOpts = computed(() =>
  isCompact.value ? { onRefresh: handleRefresh, refreshing: isRefreshing.value } : undefined,
);
const failedImages = computed(() => failedImagesStore.byTaskId(taskId.value));

// 用于实时更新运行时间的响应式时间戳
const currentTime = ref<number>(Date.now());
let timeUpdateInterval: number | null = null;
let unlistenTasksChange: (() => void) | null = null;

const successN = computed(() => task.value?.successCount ?? 0);
const failedN = computed(() => task.value?.failedCount ?? failedImages.value.length);
const deletedN = computed(() => task.value?.deletedCount ?? 0);
const dedupN = computed(() => task.value?.dedupCount ?? 0);

const formatDuration = (startTime: number, endTime?: number, currentTimeMs?: number) => {
  const startMs = startTime > 1e12 ? startTime : startTime * 1000;
  // 如果有结束时间就用结束时间，否则用传入的当前时间（用于实时更新）
  const endMs = endTime ? (endTime > 1e12 ? endTime : endTime * 1000) : (currentTimeMs ?? Date.now());
  const diff = endMs - startMs;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return t("tasks.runTimeHours", { hours, minutes: minutes % 60 });
  } else if (minutes > 0) {
    return t("tasks.runTimeMinutes", { minutes });
  } else {
    return t("tasks.runTimeSeconds", { seconds });
  }
};

// 运行时间计时器：只在页面存活且任务处于 running 时走，由任务状态驱动启停
const syncClock = () => {
  const ticking = isLive.value && taskStatusFromStore.value === "running";
  if (ticking && timeUpdateInterval === null) {
    currentTime.value = Date.now();
    timeUpdateInterval = window.setInterval(() => {
      currentTime.value = Date.now();
    }, 1000);
  } else if (!ticking && timeUpdateInterval !== null) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
};
watch(taskStatusFromStore, syncClock);

// 页面存活期：先订阅补丁，再激活观察 key 并请求，错过的变更由首读补上。
const startLive = () => {
  if (isLive.value) return;
  const subscription = kbEvent$("tasks-change").subscribe(({ payload }) => {
    const event = normalizeTaskEvent(payload);
    if (event?.type !== "TaskChanged" || event.taskId !== taskId.value) return;
    // 首读未回时请求自己的 key，由核心 pending 窗口处理先后返回。
    if (!task.value) requestTask();
    else task.value = { ...task.value, ...event.diff };
  });
  unlistenTasksChange = () => subscription.unsubscribe();
  isLive.value = true;
  syncClock();
};

const stopLive = () => {
  if (!isLive.value) return;
  isLive.value = false;
  unlistenTasksChange?.();
  unlistenTasksChange = null;
  syncClock();
};

const durationText = computed(() => {
  const src = task.value;
  if (!src?.startTime) return "";
  const isRunning = taskStatusFromStore.value === "running";
  return formatDuration(src.startTime, src.endTime, isRunning ? currentTime.value : undefined);
});

// 监听路由参数变化：切换到另一个任务时重置查询。
// 路由 store 往往已先从 URL 同步了 taskId，此时条件不成立——所以订阅与计时不能挂在这里，
// 统一由 startLive / stopLive 跟随组件生命周期，换任务由 taskKey 的 watch 请求。
watch(
  () => route.params.taskId,
  (newId) => {
    // keep-alive 场景：离开任务页后 route 仍会变化（比如其它页面也有 :id）。
    // 这里必须只在 TaskDetail 激活时才响应，否则会错误地把其它页面的 id 当成 taskId。
    if (newId && typeof newId === "string" && newId !== taskId.value) {
      // 切换到新任务（列表与总数由 ImageGrid 按 isActive/currentPath 自动加载）
      rememberTaskDetailSearchModes(DEFAULT_GALLERY_SEARCH_MODES);
      taskDetailRouteStore.patch({
        taskId: newId,
        // 换任务就是换数据源：上一个任务的查询不该跟过来
        query: [],
      });
    }
  },
  { immediate: true },
);

const goBack = () => {
  analytics.track("task_detail_exit");
  router.back();
};

const handleRefresh = async () => {
  if (!isOnTaskRoute.value) return;
  if (!taskId.value) return;
  isRefreshing.value = true;
  try {
    // 图片列表请求即返回，结果与错误经 ImageGrid 的观察方落地
    taskViewRef.value?.refresh();
    requestTask();
    await failedImagesStore.loadAll();
    ElMessage.success(t("tasks.refreshSuccess"));
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("tasks.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

let lastTrackedTaskPath: string | null = null;
const analytics = createImageAnalytics(() => ({
  taskId: taskId.value,
  taskName: taskName.value,
  path: taskDetailRouteStore.computedPath,
}));

// track
watch(
  () => [taskDetailRouteStore.computedPath, taskId.value] as const,
  ([path, id]) => {
    if (!IS_WEB) return;
    if (!isOnTaskRoute.value) return;
    if (!path || !id) return;
    const key = `${id}:${path}`;
    if (key === lastTrackedTaskPath) return;
    lastTrackedTaskPath = key;
    analytics.track("task_path");
  },
  { immediate: true },
);

const handleStopTask = async () => {
  if (!taskId.value) return;
  try {
    await ElMessageBox.confirm(t("tasks.stopTaskConfirm"), t("tasks.stopTaskTitle"), { type: "warning" });
    await crawlerStore.stopTask(taskId.value);
    // 不写入本地“stopped”伪状态：任务最终状态由后端 tasks-change（TaskChanged）与 DB 同步驱动
    ElMessage.info(t("tasks.taskStopRequested"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("停止任务失败:", error);
    }
  }
};

const handleDeleteTask = async () => {
  if (!taskId.value) return;
  try {
    const needStop = taskStatusFromStore.value === "running";
    const msg = needStop ? t("tasks.deleteTaskConfirmRunning") : t("tasks.deleteTaskConfirm");
    await ElMessageBox.confirm(msg, t("tasks.confirmDelete"), { type: "warning" });

    if (needStop) {
      try {
        await crawlerStore.stopTask(taskId.value);
      } catch (err) {
        console.error("终止任务失败，已取消删除", err);
        ElMessage.error(t("tasks.stopFailedCancel"));
        return;
      }
    }

    await crawlerStore.deleteTask(taskId.value);
    ElMessage.success(t("tasks.taskDeleted"));
    router.back();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("tasks.deleteFailed"));
    }
  }
};

// 一键加入画册（header 按钮）：只弹选择画册，由后端把该任务全部图片加入
const handleHeaderAddToAlbum = () => {
  if (!taskId.value) return;
  taskViewRef.value?.openAddToAlbum({ taskId: taskId.value });
};

// 未包 keep-alive 时只走 mounted / unmounted；包了则 activated / deactivated 也会成对触发，startLive 幂等
onMounted(startLive);
onActivated(startLive);
onUnmounted(stopLive);

onDeactivated(async () => {
  await taskDetailRouteStore.clear();
  stopLive();
});
</script>

<style scoped lang="scss">
.task-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;

  .detail-body {
    // flex: 1;
    // overflow-y: auto;
    // overflow-x: hidden;

    .image-grid-root {
      overflow: visible;
    }
  }

  .task-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 16px;
  }
}
</style>
