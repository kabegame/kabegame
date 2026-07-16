<template>
    <div class="task-detail" v-pull-to-refresh="pullToRefreshOpts">
        <ImageGrid ref="taskViewRef" class="detail-body" :surface="surface"
            :enable-ctrl-wheel-adjust-columns="!isCompact" :enable-ctrl-key-adjust-columns="!isCompact"
            enable-virtual-scroll scroll-whole-container hide-scrollbar>
            <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
                <TaskDetailPageHeader :task-name="taskName"
                    :show-stop-task="shouldShowStopButton" :show-open-webview="showOpenWebview" @refresh="handleRefresh" @stop-task="handleStopTask"
                    @delete-task="handleDeleteTask" @add-to-album="handleHeaderAddToAlbum" @help="openHelpDrawer"
                    @quick-settings="openQuickSettings" @view-task-log="handleViewTaskLog" @view-task-params="handleViewTaskParams" @open-task-webview="handleOpenTaskWebview" @failed-images="handleShowFailedImages" @back="goBack">
                    <template #subtitle>
                        <TaskCountsInline :success="successN" :failed="failedN" :deleted="deletedN" :dedup="dedupN"
                            :duration="durationText" />
                    </template>
                </TaskDetailPageHeader>

                <GalleryFilters
                    :filters="taskDetailRouteStore.filters"
                    :sort="taskDetailRouteStore.sort"
                    :page-size="pageSize"
                    :search="taskDetailRouteStore.search"
                    :provider-context-prefix="taskDetailRouteStore.computedContextPath"
                    :filter-features="taskFilterFeatures"
                    :sort-features="taskSortFeatures"
                    enable-search
                    enable-page-size
                    @update:filters="(f) => taskDetailRouteStore.navigate({ filters: f, page: 1 })"
                    @update:sort="(s) => taskDetailRouteStore.navigate({ sort: s })"
                    @update:page-size="(ps) => taskDetailRouteStore.navigate({ page: 1, pageSize: ps })"
                    @update:search="(v) => taskDetailRouteStore.navigate({ page: 1, search: v })"
                />

                <GalleryBigPaginator :total-count="totalCount" :current-page="currentPage"
                :big-page-size="pageSize" :is-sticky="true" @jump-to-page="jumpToPage" />
            </template>
        </ImageGrid>

        <TaskLogDialog ref="taskLogDialogRef" />
        <TaskParamsDialog :open="taskParamsDialog.isOpen.value" :z-index="taskParamsDialog.zIndex.value" :task="taskParamsTask" @close="taskParamsDialog.close()" />
        <!-- 紧凑模式下 FailedImages 在 fold 菜单里，FailedImagesHeaderButton comp 不渲染，对话框由本视图托管 -->
        <FailedImagesDialog v-if="isCompact" ref="failedImagesDialogRef" />
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onActivated, onDeactivated, watch } from "vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@/api/rpc";
import { listen } from "@/api/rpc";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryFilters from "@/components/GalleryFilters.vue";
import { createTaskDetailSurface } from "@/components/imageGrid/surfaces/task";
import type { GalleryFilterDimension, GallerySortField } from "@/utils/galleryPath";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import TaskDetailPageHeader from "@/components/header/TaskDetailPageHeader.vue";
import TaskLogDialog from "@kabegame/core/components/task/TaskLogDialog.vue";
import TaskParamsDialog from "@kabegame/core/components/task/TaskParamsDialog.vue";
import type { TaskRunParamsTask } from "@kabegame/core/components/task/TaskRunParamsContent.vue";
import TaskCountsInline from "@kabegame/core/components/task/TaskCountsInline.vue";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { IS_WEB } from "@kabegame/core/env";
import { createImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import { useI18n } from "@kabegame/i18n";
import { useFailedImagesStore } from "@/stores/failedImages";

const { t } = useI18n();
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

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("taskdetail");

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

const taskParamsDialog = useModal();
const taskParamsTask = computed<TaskRunParamsTask | null>(() => task.value ?? null);
const handleViewTaskParams = () => {
    if (!taskId.value) return;
    taskParamsDialog.open();
};

// 数据加载 / 菜单命令 / 事件刷新均由 ImageGrid connected 模式接管
const taskDetailRouteStore = useTaskDetailRouteStore();
const surface = createTaskDetailSurface({
    taskId: () => taskId.value,
});
const { search: searchQuery, taskId, page } = storeToRefs(taskDetailRouteStore);

const taskFilterFeatures: GalleryFilterDimension[] = [
  "wallpaperOrder", "noAlbum", "plugin", "mediaType", "date", "name", "size", "aspect",
];
const taskSortFeatures: GallerySortField[] = [
  "by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time",
];

const taskViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);

// 任务数据一律从 crawlerStore 读取
const task = computed(() => {
    if (!taskId.value) return null;
    return crawlerStore.tasks.find((t) => t.id === taskId.value) ?? null;
});

const taskName = computed(() => {
    const tsk = task.value;
    if (!tsk) return "";
    return tsk.pluginId ? pluginStore.pluginLabel(tsk.pluginId) : t("tasks.task");
});

const taskStatusFromStore = computed(() => task.value?.status ?? "");

// 是否应该显示停止按钮（只在 running 状态显示）
const shouldShowStopButton = computed(() => {
    return taskStatusFromStore.value === "running";
});

const showOpenWebview = computed(() => {
    const tsk = task.value;
    if (!tsk || tsk.status !== "running") return false;
    return pluginStore.plugins.find((plugin) => plugin.id === tsk.pluginId)?.scriptType === "js";
});

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
    isCompact.value
        ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
        : undefined
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
    const endMs = endTime
        ? (endTime > 1e12 ? endTime : endTime * 1000)
        : (currentTimeMs ?? Date.now());
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

// 清理定时器的函数（页面失活时调用，节省资源）
const stopTimers = () => {
    // 清理定时器
    if (timeUpdateInterval !== null) {
        clearInterval(timeUpdateInterval);
        timeUpdateInterval = null;
    }
};

// 启动定时器和事件监听器的函数
const startTimersAndListeners = async () => {
    // 如果已经启动，则跳过
    if (timeUpdateInterval !== null) {
        return;
    }

    // 启动定时器，每秒更新当前时间（用于实时显示运行时间）
    currentTime.value = Date.now();
    timeUpdateInterval = window.setInterval(() => {
        currentTime.value = Date.now();
    }, 1000);

    // 监听 `tasks-change`：本页任务终态时停止运行时间计时（进度由 crawler store 统一更新）
    if (!unlistenTasksChange) {
        unlistenTasksChange = await listen("tasks-change", async (event) => {
            const payload: any = event.payload;
            if (String(payload?.type ?? "") !== "TaskChanged") return;
            const tid = String(payload?.taskId ?? payload?.task_id ?? "").trim();
            if (!tid || tid !== taskId.value) return;
            const diff = payload?.diff ?? {};
            const status = typeof diff.status === "string" ? diff.status : "";
            if (
                status === "completed" ||
                status === "failed" ||
                status === "canceled"
            ) {
                stopTimers();
            }
        });
    }
};

// 清理所有定时器和事件监听器的函数（组件真正销毁时调用）
const stopTimersAndListeners = () => {
    // 清理定时器
    stopTimers();
    // 移除事件监听器
    if (unlistenTasksChange) {
        unlistenTasksChange();
        unlistenTasksChange = null;
    }
};

const durationText = computed(() => {
    const src = task.value;
    if (!src?.startTime) return "";
    const isRunning = taskStatusFromStore.value === "running";
    return formatDuration(
        src.startTime,
        src.endTime,
        isRunning ? currentTime.value : undefined
    );
});

// 监听路由参数变化：首个挂载与切换到另一个任务时初始化
watch(
    () => route.params.taskId,
    async (newId) => {
        // keep-alive 场景：离开任务页后 route 仍会变化（比如其它页面也有 :id）。
        // 这里必须只在 TaskDetail 激活时才响应，否则会错误地把其它页面的 id 当成 taskId。
        
        if (newId && typeof newId === "string" && newId !== taskId.value) {
            // 清理旧的定时器和监听器
            stopTimersAndListeners();
            // 切换到新任务（列表与总数由 ImageGrid 按 isActive/currentPath 自动加载）
            taskDetailRouteStore.patch({
                taskId: newId,
                search: '',
                page: 1
            })
            // 重新启动定时器和监听器
            await startTimersAndListeners();
        }
    },
    { immediate: true }
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
        await Promise.all([
            taskViewRef.value?.refresh(),
            failedImagesStore.loadAll(),
        ]);
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
    { immediate: true }
);

const handleStopTask = async () => {
    if (!taskId.value) return;
    try {
        await ElMessageBox.confirm(
            t("tasks.stopTaskConfirm"),
            t("tasks.stopTaskTitle"),
            { type: "warning" }
        );
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
        const msg = needStop
            ? t("tasks.deleteTaskConfirmRunning")
            : t("tasks.deleteTaskConfirm");
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

onActivated(async () => {
    await startTimersAndListeners();
});

onDeactivated(async () => {
    await taskDetailRouteStore.clear();
    stopTimersAndListeners();
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

}
</style>
