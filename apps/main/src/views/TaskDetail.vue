<template>
    <div class="task-detail" v-pull-to-refresh="pullToRefreshOpts">
        <div v-if="loading" class="detail-body detail-body-loading">
            <el-skeleton :rows="8" animated />
        </div>
        <ImageGrid v-else-if="imageFilter === 'success'" ref="taskViewRef" class="detail-body" :images="images"
            :enable-ctrl-wheel-adjust-columns="!IS_ANDROID" :enable-ctrl-key-adjust-columns="!IS_ANDROID"
            :enable-virtual-scroll="!IS_ANDROID" :actions="imageActions" :on-context-command="handleImageMenuCommand">
            <template #before-grid>
                <TaskDetailPageHeader :task-name="taskName" :task-subtitle="taskSubtitle"
                    :show-stop-task="shouldShowStopButton" @refresh="handleRefresh" @stop-task="handleStopTask"
                    @delete-task="handleDeleteTask" @add-to-album="handleHeaderAddToAlbum" @help="openHelpDrawer"
                    @quick-settings="openQuickSettings" @view-task-log="handleViewTaskLog" @back="goBack" />

                    <div class="task-detail-page-size-toolbar">
                        <TaskFilterControl
                            v-model="imageFilter"
                            :failed-count="taskFromStore?.failedCount ?? failedImages.length"
                            variant="gallery"
                            android-ui="inline"
                        />
                        <GalleryPageSizeControl
                            :page-size="pageSize"
                            variant="gallery"
                            android-ui="inline"
                        />
                    </div>

                    <GalleryBigPaginator :total-count="totalImagesCount" :current-page="currentPage"
                    :big-page-size="pageSize" :is-sticky="true" @jump-to-page="handleJumpToPage" />
            </template>
        </ImageGrid>
        <div v-else class="detail-body failed-mode-body">
            <TaskDetailPageHeader :task-name="taskName" :task-subtitle="taskSubtitle"
                :show-stop-task="shouldShowStopButton" @refresh="handleRefresh" @stop-task="handleStopTask"
                @delete-task="handleDeleteTask" @add-to-album="handleHeaderAddToAlbum" @help="openHelpDrawer"
                @quick-settings="openQuickSettings" @view-task-log="handleViewTaskLog" @back="goBack" />

            <div class="task-detail-page-size-toolbar">
                <TaskFilterControl
                    v-model="imageFilter"
                    :failed-count="taskFromStore?.failedCount ?? failedImages.length"
                    variant="gallery"
                    android-ui="inline"
                />
            </div>

            <el-skeleton v-if="failedLoading" :rows="6" animated />
            <el-empty v-else-if="failedImages.length === 0" :description="t('gallery.emptyHint')" />
            <TransitionGroup v-else name="task-failed-list" tag="div" class="failed-list" :class="{ 'failed-list-android': IS_ANDROID }">
                <div v-for="failed in failedImages" :key="failed.id" class="failed-item">
                    <div class="failed-meta">
                        <div class="failed-url-block">
                            <span class="failed-url-link" @click="openFailedUrl(failed.url)">{{ failed.url }}</span>
                        </div>
                        <div class="failed-error-block">
                            <span class="failed-key">{{ t("tasks.failedError") }}</span>
                            <span class="failed-error">{{ failed.lastError || "-" }}</span>
                            <el-tooltip :content="t('tasks.copyErrorDetails')" placement="top">
                                <el-button text size="small" class="failed-copy-btn" @click="copyFailedError(failed)">
                                    <el-icon><DocumentCopy /></el-icon>
                                </el-button>
                            </el-tooltip>
                        </div>
                        <div class="failed-meta-row">
                            <el-tag size="small" type="info" class="failed-plugin-tag">
                                {{ getFailedPluginName(failed.pluginId) }}
                            </el-tag>
                            <span class="failed-time">{{ formatFailedTime(failed.createdAt) }}</span>
                        </div>
                        <div v-if="getFailedItemState(failed.url).isDownloading" class="failed-progress-row">
                            <el-tag size="small" :type="getStateTagType(getFailedItemState(failed.url).state)">
                                {{ getStateLabel(getFailedItemState(failed.url).state) }}
                            </el-tag>
                            <el-progress
                                :percentage="getFailedItemState(failed.url).progress ?? 0"
                                :indeterminate="getFailedItemState(failed.url).state !== 'downloading' || getFailedItemState(failed.url).progress == null"
                                :stroke-width="8"
                                class="failed-progress-bar"
                            />
                        </div>
                    </div>
                    <div class="failed-actions">
                        <el-button type="primary" size="small" :loading="retryingFailedIds.has(failed.id)"
                            :disabled="getFailedItemState(failed.url).isDownloading"
                            @click="handleRetryFailedImage(failed.id)">
                            {{ t("tasks.retryDownload") }}
                        </el-button>
                        <el-button size="small" type="danger" plain
                            :disabled="getFailedItemState(failed.url).isDownloading"
                            @click="handleDeleteFailedImage(failed.id)">
                            {{ t("tasks.deleteFailedRecord") }}
                        </el-button>
                    </div>
                </div>
            </TransitionGroup>
        </div>

        <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds" :task-id="addToAlbumTaskId"
            @added="handleAddedToAlbum" />

        <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
            :message="removeDialogMessage" :title="$t('tasks.confirmDelete')" :checkbox-label="t('gallery.deleteSourceFilesCheckboxLabel')"
            :danger-text="t('gallery.deleteSourceFilesDangerText')" :safe-text="t('gallery.deleteSourceFilesSafeText')"
            :hide-checkbox="IS_ANDROID" @confirm="confirmRemoveImages" />

        <TaskLogDialog ref="taskLogDialogRef" />
    </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { setWallpaperByImageIdWithModeFallback } from "@/utils/wallpaperMode";
import { listen } from "@tauri-apps/api/event";
import { ElMessage, ElMessageBox } from "element-plus";
import { VideoPause, Delete, Setting, Refresh, QuestionFilled, Star, StarFilled, InfoFilled, DocumentCopy, Picture, FolderAdd, MoreFilled } from "@element-plus/icons-vue";
import { createImageActions } from "@/actions/imageActions";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import TaskFilterControl from "@/components/TaskFilterControl.vue";
import type { ImageInfo, TaskFailedImage } from "@kabegame/core/types/image";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import TaskDetailPageHeader from "@/components/header/TaskDetailPageHeader.vue";
import TaskLogDialog from "@kabegame/core/components/task/TaskLogDialog.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import type { Component } from "vue";

// 选择操作项类型（用于本页选择栏）
export interface SelectionAction {
    key: string;
    label: string;
    icon: Component;
    command: string;
}
import { useImageOperations } from "@/composables/useImageOperations";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { IS_ANDROID } from "@kabegame/core/env";
import { clearImageStateCache } from "@kabegame/core/composables/useImageStateCache";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useImageTypes } from "@/composables/useImageTypes";
import { openLocalImage } from "@/utils/openLocalImage";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { useFailedImagesStore } from "@/stores/failedImages";

const { t } = useI18n();
const { pluginName: resolvePluginName } = usePluginManifestI18n();

const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);

const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");

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

const taskId = ref<string>("");
const totalImagesCount = ref<number>(0); // provider.total（用于分页器）

// 任务数据一律从 crawlerStore 读取；用户进入 TaskDetail 必然经过 TaskDrawer，数据已加载
const taskFromStore = computed(() => {
    if (!taskId.value) return null;
    return crawlerStore.tasks.find((t) => t.id === taskId.value) ?? null;
});

const taskName = computed(() => {
    const task = taskFromStore.value;
    if (!task) return "";
    if (task.pluginId === "local-import") return t("tasks.drawerLocalImport");
    const plugin = pluginStore.plugins.find((p) => p.id === task.pluginId);
    return plugin ? (resolvePluginName(plugin) || task.pluginId) : (task.pluginId || t("tasks.task"));
});

const taskStatusFromStore = computed(() => taskFromStore.value?.status ?? "");

// 是否应该显示停止按钮（只在 running 状态显示）
const shouldShowStopButton = computed(() => {
    return taskStatusFromStore.value === "running";
});
const loading = ref(false);
const isRefreshing = ref(false);
const pullToRefreshOpts = computed(() =>
    !IS_ANDROID
        ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
        : undefined
);
const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();
const images = ref<ImageInfo[]>([]);
const failedImages = computed(() => failedImagesStore.byTaskId(taskId.value));
const failedLoading = computed(() => failedImagesStore.loading);
const imageFilter = ref<"success" | "failed">("success");
const taskViewRef = ref<any>(null);
const taskContainerRef = ref<HTMLElement | null>(null);
const currentWallpaperImageId = ref<string | null>(null);

const retryingFailedIds = ref(new Set<number>());

// 下载状态/进度追踪：url -> { state, progress? }
const downloadStateMap = reactive<Record<string, { state: string; progress?: number }>>({});

useImageGridAutoLoad({
    containerRef: taskContainerRef,
    onLoad: () => { },
});

// Image actions for context menu / action sheet
const imageActions = computed(() => createImageActions({
    removeText: t("tasks.removeText"),
    multiHide: ["favorite", "addToAlbum"]
}));

const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const { handleCopyImage } = useImageOperations(
    images,
    currentWallpaperImageId,
    taskViewRef,
    () => { },
    async () => { }
);

watch(
    () => taskViewRef.value,
    async () => {
        await nextTick();
        taskContainerRef.value = taskViewRef.value?.getContainerEl?.() ?? null;
    },
    { immediate: true }
);

// 用于实时更新运行时间的响应式时间戳
const currentTime = ref<number>(Date.now());
let timeUpdateInterval: number | null = null;
let unlistenTasksChange: (() => void) | null = null;
let unlistenDownloadState: (() => void) | null = null;
let unlistenDownloadProgress: (() => void) | null = null;

const taskSubtitle = computed(() => {
    const parts: string[] = [];
    const src = taskFromStore.value;
    const okTotal =
        src != null && typeof src.successCount === "number"
            ? src.successCount
            : totalImagesCount.value;
    const failedTotal =
        src != null && typeof src.failedCount === "number"
            ? src.failedCount
            : failedImages.value.length;
    parts.push(t("tasks.totalCount", { n: okTotal }));
    if (failedTotal > 0) parts.push(t("tasks.failedCount", { n: failedTotal }));
    if (src?.deletedCount && src.deletedCount > 0) {
        parts.push(t("tasks.deletedCount", { n: src.deletedCount }));
    }
    if (src?.dedupCount && src.dedupCount > 0) {
        parts.push(t("tasks.dedupCount", { n: src.dedupCount }));
    }
    if (src?.startTime) {
        const isRunning = taskStatusFromStore.value === "running";
        const duration = formatDuration(
            src.startTime,
            src.endTime,
            isRunning ? currentTime.value : undefined
        );
        parts.push(duration);
    }
    return parts.join(" · ") || "";
});

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


// 监听路由参数变化，当切换到另一个任务时重新加载数据
watch(
    () => route.params.id,
    async (newId) => {
        // keep-alive 场景：离开任务页后 route 仍会变化（比如其它页面也有 :id）。
        // 这里必须只在 TaskDetail/TaskDetailPaged 激活时才响应，否则会错误地把其它页面的 id 当成 taskId。
        if (!isOnTaskRoute.value) return;
        if (newId && typeof newId === "string" && newId !== taskId.value) {
            // 清理旧的定时器和监听器
            stopTimersAndListeners();
            // 初始化新任务
            await initTask(newId);
            // 重新启动定时器和监听器
            await startTimersAndListeners();
        }
    }
);
const goBack = () => {
    router.back();
};

const handleRefresh = async () => {
    if (!isOnTaskRoute.value) return;
    if (!taskId.value) return;
    isRefreshing.value = true;
    try {
        clearImageStateCache();
        await loadTaskImages({ showSkeleton: false });
        await failedImagesStore.loadAll();
        ElMessage.success(t("tasks.refreshSuccess"));
    } catch (error) {
        console.error("刷新失败:", error);
        ElMessage.error(t("tasks.refreshFailed"));
    } finally {
        isRefreshing.value = false;
    }
};

// 本地计算的 provider root path，用于初始化
const localProviderRootPath = computed(() => {
    if (!taskId.value) return "";
    return `task/${taskId.value}`;
});

const pageSize = computed(() => {
    const n = Number(settingsStore.values.galleryPageSize);
    return n === 100 || n === 500 || n === 1000 ? n : 100;
});
const taskDetailRouteStore = useTaskDetailRouteStore();
const currentPath = computed(() => taskDetailRouteStore.currentPath);
const currentPage = computed(() => taskDetailRouteStore.page);

const handleJumpToPage = async (page: number) => {
    await taskDetailRouteStore.navigate({ page });
};

// 跟随路径变化重载当前 leaf（支持分页器跳转/浏览器前进后退）
watch(
    () => currentPath.value,
    async (newPath) => {
        if (!isOnTaskRoute.value) return;
        if (!taskId.value) return;
        if (!newPath) return;
        await loadTaskImages({ showSkeleton: false });
    },
    { immediate: true }
);

watch(
    () => route.query.path,
    (rawPath) => {
        // 与 AlbumDetail 一致：仅在当前路由为任务详情时同步，避免画册等页的 ?path= 污染 taskDetailRouteStore
        if (!isOnTaskRoute.value) return;
        const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
        if (!qp.trim()) return;
        if (qp !== currentPath.value) {
            taskDetailRouteStore.syncFromUrl(qp);
        }
    },
    { immediate: true }
);

const loadTaskImages = async (options?: { showSkeleton?: boolean }) => {
    if (!isOnTaskRoute.value) return;
    if (!taskId.value) return;
    if (imageFilter.value !== "success") return;
    const showSkeleton = options?.showSkeleton ?? true;
    if (showSkeleton) loading.value = true;
    try {
        // 直接加载当前路径（新路径格式总是包含页码）
        const pathToLoad = currentPath.value || localProviderRootPath.value || `task/${taskId.value}/1`;
        clearImageMetadataCache();
        const res = await invoke<{ total?: number; baseOffset?: number; entries?: Array<{ kind: string; image?: ImageInfo }> }>(
            "browse_gallery_provider",
            { path: pathToLoad, pageSize: pageSize.value }
        );
        totalImagesCount.value = res?.total ?? 0;
        const imgs: ImageInfo[] = (res?.entries ?? [])
            .filter((e: any) => e?.kind === "image")
            .map((e: any) => e.image as ImageInfo);
        images.value = imgs;

    } catch (e) {
        console.error("加载任务图片失败:", e);
        // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
        ElMessage.error(t("tasks.loadImagesFailed"));
    } finally {
        if (showSkeleton) loading.value = false;
    }
};

watch(
    pageSize,
    async (_v, prev) => {
        if (prev === undefined) return;
        if (!isOnTaskRoute.value) return;
        await taskDetailRouteStore.navigate({ page: 1 });
        await loadTaskImages({ showSkeleton: false });
    },
);

watch(
    () => imageFilter.value,
    async (next) => {
        if (next === "failed") {
            return;
        }
        if (!isOnTaskRoute.value) return;
        await loadTaskImages({ showSkeleton: false });
    }
);

const getFailedItemState = (url: string) => {
    const entry = downloadStateMap[url];
    if (!entry) return { isDownloading: false } as const;
    const isDownloading = ["preparing", "downloading", "processing"].includes(entry.state);
    return { isDownloading, state: entry.state, progress: entry.progress } as const;
};

watch(
    () => failedImages.value,
    (list) => {
        const urlSet = new Set((list || []).map((f) => f.url));
        for (const url of Object.keys(downloadStateMap)) {
            if (!urlSet.has(url)) delete downloadStateMap[url];
        }
    },
    { deep: true }
);

const getStateTagType = (state?: string) => {
    if (state === "preparing") return "info";
    if (state === "downloading") return "primary";
    if (state === "processing") return "warning";
    return "info";
};

const getStateLabel = (state?: string) => {
    if (state === "preparing") return t("tasks.statePreparing");
    if (state === "downloading") return t("tasks.stateDownloading");
    if (state === "processing") return t("tasks.stateProcessing");
    return state ?? "";
};

const handleRetryFailedImage = async (failedId: number) => {
    if (retryingFailedIds.value.has(failedId)) return;
    retryingFailedIds.value.add(failedId);
    try {
        await failedImagesStore.retryFailed(failedId);
    } catch (error) {
        console.error("重试下载失败:", error);
        ElMessage.error(t("tasks.retryDownloadFailed"));
    } finally {
        retryingFailedIds.value.delete(failedId);
    }
};

const handleDeleteFailedImage = async (failedId: number) => {
    const failed = failedImages.value.find((f) => f.id === failedId);
    if (!failed) return;
    if (getFailedItemState(failed.url).isDownloading) return;
    try {
        await failedImagesStore.deleteFailed(failedId);
        delete downloadStateMap[failed.url];
        ElMessage.success(t("tasks.deleteFailedRecordSuccess"));
    } catch (error) {
        console.error("删除失败记录失败:", error);
        ElMessage.error(t("tasks.deleteFailedRecordFailed"));
    }
};

const openFailedUrl = async (url: string) => {
    try {
        await openUrl(url);
    } catch {
        ElMessage.error(t("common.openUrlFailed"));
    }
};

const getFailedPluginName = (pluginId: string) => {
    if (pluginId === "local-import") return t("tasks.drawerLocalImport");
    const plugin = pluginStore.plugins.find((p) => p.id === pluginId);
    return plugin ? (resolvePluginName(plugin) || pluginId) : pluginId;
};

const copyFailedError = async (failed: TaskFailedImage) => {
    const pluginName = getFailedPluginName(failed.pluginId);
    const timeStr = formatFailedTime(failed.createdAt);
    const text = [
        `[${t("tasks.filterFailed")}]`,
        `${t("tasks.failedUrl")}: ${failed.url}`,
        `${t("tasks.failedError")}: ${failed.lastError || "-"}`,
        `${t("tasks.failedPlugin")}: ${pluginName}`,
        `${t("tasks.failedTime")}: ${timeStr}`,
    ].join("\n");
    try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
            const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(text);
        } else {
            await navigator.clipboard.writeText(text);
        }
        ElMessage.success(t("common.copySuccess"));
    } catch (error) {
        console.error("复制失败:", error);
        ElMessage.error(t("common.copyFailed"));
    }
};

const formatFailedTime = (value: number) => {
    if (!value) return "";
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toLocaleString();
};

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

// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);

const clearSelection = () => {
    taskViewRef.value?.clearSelection?.();
};

// 加入画册对话框（右键菜单用 imageIds，header 一键加入用 taskId）
const showAddToAlbumDialog = ref(false);
const addToAlbumImageIds = ref<string[]>([]);
const addToAlbumTaskId = ref<string | undefined>(undefined);
const handleAddedToAlbum = () => {
    clearSelection();
    addToAlbumTaskId.value = undefined;
};

// 一键加入画册（header 按钮）：只弹选择画册，由后端把该任务全部图片加入
const handleHeaderAddToAlbum = () => {
    addToAlbumTaskId.value = taskId.value;
    addToAlbumImageIds.value = [];
    showAddToAlbumDialog.value = true;
};

// 切换收藏（仅更新本页 images + 收藏画册缓存/计数）
const toggleFavoriteForImages = async (imgs: ImageInfo[]) => {
    if (imgs.length === 0) return;
    const desiredFavorite = imgs.some((img) => !(img.favorite ?? false));
    const toChange = imgs.filter((img) => (img.favorite ?? false) !== desiredFavorite);
    if (toChange.length === 0) return;

    const results = await Promise.allSettled(
        toChange.map((img) =>
            invoke("toggle_image_favorite", {
                imageId: img.id,
                favorite: desiredFavorite,
            })
        )
    );
    const succeededIds: string[] = [];
    results.forEach((r, idx) => {
        if (r.status === "fulfilled") succeededIds.push(toChange[idx]!.id);
    });
    if (succeededIds.length === 0) {
        ElMessage.error("操作失败");
        return;
    }

    // 列表与画册缓存由 album-images-change / images-change 事件驱动刷新

    ElMessage.success(desiredFavorite ? `已收藏 ${succeededIds.length} 张` : `已取消收藏 ${succeededIds.length} 张`);
    clearSelection();
};

// 设置壁纸（单选或多选）
const setWallpaper = async (imagesToProcess: ImageInfo[]) => {
    try {
        if (imagesToProcess.length > 1) {
            // 多选：创建"桌面画册x"，添加到画册，开启轮播
            // 1. 找到下一个可用的"桌面画册x"名称
            await albumStore.loadAlbums();
            let albumName = "桌面画册1";
            let counter = 1;
            while (albumStore.albums.some((a) => a.name === albumName)) {
                counter++;
                albumName = `桌面画册${counter}`;
            }

            // 2. 创建画册
            const createdAlbum = await albumStore.createAlbum(albumName);

            // 3. 将选中的图片添加到画册
            const imageIds = imagesToProcess.map((img) => img.id);
            try {
                await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);
            } catch (error: any) {
                // 提取友好的错误信息
                const errorMessage = typeof error === "string"
                    ? error
                    : error?.message || String(error) || "添加图片到画册失败";
                ElMessage.error(errorMessage);
                throw error;
            }

            await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);

            // 5. 如果轮播未开启，开启它
            if (!settingsStore.values.wallpaperRotationEnabled) {
                await setWallpaperRotationEnabled(true);
            }

            // 6. 设置轮播画册为新创建的画册
            await setWallpaperRotationAlbumId(createdAlbum.id);

            ElMessage.success(
                `已开启轮播：画册「${albumName}」（${imageIds.length} 张）`
            );
        } else {
            // 单选：直接设置壁纸
            await setWallpaperByImageIdWithModeFallback(imagesToProcess[0].id);
            ElMessage.success("壁纸设置成功");
        }

        clearSelection();
    } catch (error: any) {
        console.error("设置壁纸失败:", error);
        // 提取友好的错误信息
        const errorMessage = typeof error === "string"
            ? error
            : error?.message || String(error) || "未知错误";
        ElMessage.error(`设置壁纸失败: ${errorMessage}`);
    }
};

// Android 选择模式：构建操作栏 actions
const buildSelectionActions = (selectedCount: number, selectedIds: ReadonlySet<string>): SelectionAction[] => {
    const countText = selectedCount > 1 ? `(${selectedCount})` : "";
    const firstSelectedImage = images.value.find(img => selectedIds.has(img.id));
    const isFavorite = firstSelectedImage?.favorite ?? false;

    if (selectedCount === 1) {
        return [
            { key: "favorite", label: isFavorite ? "取消收藏" : "收藏", icon: isFavorite ? StarFilled : Star, command: "favorite" },
            { key: "remove", label: "删除", icon: Delete, command: "remove" },
        ];
    } else {
        return [
            { key: "remove", label: `删除${countText}`, icon: Delete, command: "remove" },
        ];
    }
};


const handleImageMenuCommand = async (
    payload: any
): Promise<import("@/components/ImageGrid.vue").ContextCommand | null> => {
    const command = payload.command as string;
    // 注意：core 的 ContextCommandPayload.image 使用的是 core ImageInfo（url 可选），
    // 这里以当前页面的 images 列表为准，避免 TS 类型冲突并确保字段完整。
    const image: ImageInfo | undefined =
        images.value.find((i) => i.id === payload?.image?.id) ?? (payload?.image as ImageInfo | undefined);
    // 让 ImageGrid 执行默认内置行为（详情）
    if (command === "detail") return command;
    if (!image) return null;
    const selectedSet =
        "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
            ? payload.selectedImageIds
            : new Set([image.id]);

    const isMultiSelect = selectedSet.size > 1;
    const imagesToProcess: ImageInfo[] = isMultiSelect
        ? images.value.filter((img) => selectedSet.has(img.id))
        : [image];

    switch (command) {
        case "copy":
            if (imagesToProcess[0]) await handleCopyImage(imagesToProcess[0]);
            break;
        case "favorite":
            if (imagesToProcess.length === 0) return null;
            await toggleFavoriteForImages(imagesToProcess);
            break;
        case "openFolder":
            if (!isMultiSelect && imagesToProcess.length === 1) {
                try {
                    await invoke("open_file_folder", { filePath: imagesToProcess[0].localPath });
                } catch (error) {
                    console.error("打开文件夹失败:", error);
                    ElMessage.error("打开文件夹失败");
                }
            }
            break;
        case "addToAlbum":
            if (imagesToProcess.length === 0) return null;
            addToAlbumTaskId.value = undefined;
            addToAlbumImageIds.value = imagesToProcess.map((img) => img.id);
            showAddToAlbumDialog.value = true;
            break;
        case "wallpaper":
            if (imagesToProcess.length > 0) {
                await setWallpaper(imagesToProcess);
            }
            break;
        case "share":
            if (!isMultiSelect && imagesToProcess[0]) {
                try {
                    const image = imagesToProcess[0];
                    const filePath = image.localPath;
                    if (!filePath) {
                        ElMessage.error("图片路径不存在");
                        break;
                    }

                    const ext = filePath.split('.').pop()?.toLowerCase() || '';
                    await loadImageTypes();
                    const mimeType = getMimeTypeForImage(image, ext);
                    await invoke("share_file", { filePath, mimeType });
                } catch (error) {
                    console.error("分享失败:", error);
                    ElMessage.error("分享失败");
                }
            }
            break;
        case "open":
            if (!isMultiSelect && imagesToProcess.length === 1) {
                try {
                    await openLocalImage(imagesToProcess[0].localPath ?? "");
                } catch (error) {
                    console.error("打开文件失败:", error);
                    ElMessage.error("打开文件失败");
                }
            }
            break;
        case "remove":
            if (imagesToProcess.length === 0) return null;
            // 显示移除对话框，让用户选择是否删除文件
            pendingRemoveImages.value = imagesToProcess;
            const count = imagesToProcess.length;
            removeDialogMessage.value = count > 1 ? t("tasks.removeDialogMessageMulti", { count }) : t("tasks.removeDialogMessageSingle");
            removeDeleteFiles.value = false; // 默认不删除文件
            showRemoveDialog.value = true;
            break;
        case "swipe-remove" as any:
            // 上划删除：直接删除，不删除文件，不显示确认对话框
            if (imagesToProcess.length === 0) return null;
            void (async () => {
                try {
                    const imageIds = imagesToProcess.map(img => img.id);

                    // 不删除文件，只从任务中移除
                    await invoke("batch_remove_images", { imageIds });

                    clearSelection();
                } catch (error) {
                    console.error("删除图片失败:", error);
                    ElMessage.error(t("tasks.deleteImagesFailed"));
                }
            })();
            break;
    }
    return null;
};

// 确认移除图片（合并了原来的 remove 和 delete 逻辑）
const confirmRemoveImages = async () => {
    const imagesToRemove = pendingRemoveImages.value;
    if (imagesToRemove.length === 0) {
        showRemoveDialog.value = false;
        return;
    }

    const count = imagesToRemove.length;
    const shouldDeleteFiles = removeDeleteFiles.value;

    showRemoveDialog.value = false;

    try {
        const imageIds = imagesToRemove.map(img => img.id);

        // 使用批量 API
        if (shouldDeleteFiles) {
            await invoke("batch_delete_images", { imageIds });
        } else {
            await invoke("batch_remove_images", { imageIds });
        }

        clearSelection();

        if (shouldDeleteFiles) {
            ElMessage.success(count > 1 ? t("tasks.deleteSuccessCount", { count }) : t("tasks.deleteSuccess"));
        } else {
            ElMessage.success(count > 1 ? t("tasks.removeSuccessCount", { count }) : t("tasks.removeSuccess"));
        }
    } catch (error) {
        console.error("删除图片失败:", error);
        ElMessage.error(shouldDeleteFiles ? t("tasks.deleteFailed") : t("tasks.removeFailed"));
    }
};

const initTask = async (id: string) => {
    taskId.value = id;
    const rawPath = route.query.path;
    const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
    if (qp.startsWith(`task/${id}/`)) {
        taskDetailRouteStore.syncFromUrl(qp);
    } else {
        await taskDetailRouteStore.navigate({ taskId: id, page: 1 });
    }
    await failedImagesStore.initListeners();
    await settingsStore.loadAll();
    await Promise.all([
        loadTaskImages(),
        failedImagesStore.loadAll(),
    ]);
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

    // 监听下载状态：更新 downloadStateMap + 刷新失败列表
    if (!unlistenDownloadState) {
        unlistenDownloadState = await listen("download-state", async (event) => {
            const payload: any = event.payload as any;
            const tid = String(payload?.task_id ?? payload?.taskId ?? "").trim();
            const url = String(payload?.url ?? "").trim();
            const state = String(payload?.state ?? "").trim();
            if (!tid || tid !== taskId.value) return;
            if (url && state) {
                if (["preparing", "downloading", "processing"].includes(state)) {
                    downloadStateMap[url] = { ...(downloadStateMap[url] || {}), state };
                } else {
                    delete downloadStateMap[url];
                }
            }
        });
    }

    // 监听下载进度：更新 downloadStateMap 的 progress
    if (!unlistenDownloadProgress) {
        unlistenDownloadProgress = await listen("download-progress", (event) => {
            const payload: any = event.payload as any;
            const tid = String(payload?.task_id ?? payload?.taskId ?? "").trim();
            const url = String(payload?.url ?? "").trim();
            const received = Number(payload?.received_bytes ?? payload?.receivedBytes ?? 0);
            const total = payload?.total_bytes ?? payload?.totalBytes ?? null;
            if (!tid || tid !== taskId.value || !url) return;
            if (!downloadStateMap[url]) return;
            const pct = total != null && Number(total) > 0 ? Math.round((received / Number(total)) * 100) : undefined;
            downloadStateMap[url] = { ...downloadStateMap[url], state: "downloading", progress: pct };
        });
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

// 清理所有定时器和事件监听器的函数（组件真正销毁时调用）
const stopTimersAndListeners = () => {
    // 清理定时器
    stopTimers();

    // 移除事件监听器
    if (unlistenTasksChange) {
        unlistenTasksChange();
        unlistenTasksChange = null;
    }
    if (unlistenDownloadState) {
        unlistenDownloadState();
        unlistenDownloadState = null;
    }
    if (unlistenDownloadProgress) {
        unlistenDownloadProgress();
        unlistenDownloadProgress = null;
    }
};

// 统一图片变更事件：不做增量同步，收到 images-change 后刷新"当前页"（1000ms trailing 节流，不丢最后一次）
// 始终启用，不管是否在前台（用于同步删除等操作和更新 deletedCount）
useImagesChangeRefresh({
    enabled: ref(true),
    waitMs: 1000,
    filter: (p) => {
        const tid = taskId.value;
        if (
            p.taskIds &&
            p.taskIds.length > 0 &&
            tid &&
            !p.taskIds.includes(tid)
        ) {
            return false;
        }

        const taskScoped =
            !!tid && !!p.taskIds && p.taskIds.length > 0 && p.taskIds.includes(tid);

        if (taskScoped) {
            return true;
        }

        // 无任务维度 hint：仅当 imageIds 命中当前页时刷新（减少无关全局事件）
        const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
        if (ids.length > 0) {
            return ids.some((id) => images.value.some((img) => img.id === id));
        }
        return true;
    },
    onRefresh: async () => {
        if (!isOnTaskRoute.value) return;
        if (!taskId.value) return;
        const prevList = images.value.slice();
        await Promise.all([
            loadTaskImages({ showSkeleton: false }),
            failedImagesStore.loadAll(),
        ]);

        const { removedIds } = diffById(prevList, images.value);
        if (removedIds.length > 0) {
            taskViewRef.value?.clearSelection?.();
        }
    },
});

onMounted(async () => {
    const id = route.params.id as string;
    if (id) {
        await initTask(id);
    }
    // 首次挂载时启动定时器和监听器
    await startTimersAndListeners();
});

onBeforeUnmount(() => {
    // 清理定时器和监听器（真正销毁时）
    stopTimersAndListeners();
});

onActivated(async () => {
    const id = route.params.id as string;
    if (id && id !== taskId.value) {
        await initTask(id);
    }
    // 页面激活时启动定时器和监听器（keep-alive 场景）
    await startTimersAndListeners();
});

onDeactivated(() => {
    stopTimersAndListeners();
    taskViewRef.value?.clearSelection?.();
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
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;

        .image-grid-root {
            overflow: visible;
        }
    }

    .detail-body-loading {
        padding: 20px;
    }

    .task-detail-page-size-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
    }

    .failed-mode-body {
        padding: 0 8px 8px;
    }

    .failed-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 20px;
    }

    .task-failed-list-enter-active,
    .task-failed-list-leave-active {
        transition: all 0.3s ease;
    }

    .task-failed-list-enter-from {
        opacity: 0;
        transform: translateY(-20px);
    }

    .task-failed-list-leave-to {
        opacity: 0;
        transform: translateX(30px);
    }

    .task-failed-list-move {
        transition: transform 0.3s ease;
    }

    .failed-list-android {
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;

        .failed-item {
            padding: 10px 12px;
            min-height: 0;

            .failed-key,
            .failed-time {
                font-size: 11px;
            }
            .failed-error {
                font-size: 12px;
            }
            .failed-actions {
                gap: 4px;
                .el-button {
                    padding: 4px 8px;
                    font-size: 12px;
                }
            }
            .failed-progress-row .el-progress {
                --el-progress-text-size: 10px;
            }
        }
    }

    .failed-item {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 14px;
        border: 2px solid var(--anime-border, var(--el-border-color));
        border-radius: 12px;
        padding: 14px 16px;
        background: var(--anime-bg-card, var(--el-bg-color-overlay));
        box-shadow: var(--anime-shadow, 0 1px 3px rgba(0, 0, 0, 0.08));
        transition: box-shadow 0.25s ease, border-color 0.2s ease;

        &:hover {
            box-shadow: var(--anime-shadow-hover, 0 4px 12px rgba(0, 0, 0, 0.12));
            border-color: var(--anime-primary-light, var(--el-color-primary-light-5));
        }
    }

    .failed-meta {
        flex: 1;
        min-width: 0;
    }

    .failed-url-block {
        min-width: 0;
        margin-bottom: 8px;

        .failed-url-link {
            display: block;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--el-color-primary);
            cursor: pointer;
            font-size: 13px;

            &:hover {
                color: var(--el-color-primary-light-3);
                text-decoration: underline;
            }
        }
    }

    .failed-error-block {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 8px;

        .failed-key {
            flex-shrink: 0;
        }
        .failed-error {
            flex: 1;
            min-width: 0;
            word-break: break-word;
            font-size: 13px;
            color: var(--el-color-danger);
        }
        .failed-copy-btn {
            flex-shrink: 0;
            margin: -4px -4px -4px 0;
        }
    }

    .failed-meta-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;

        .failed-plugin-tag {
            flex-shrink: 0;
        }
    }

    .failed-key {
        color: var(--el-text-color-secondary);
        font-size: 12px;
        font-weight: 500;
    }

    .failed-time {
        color: var(--el-text-color-secondary);
        font-size: 12px;
    }

    .failed-progress-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
        .failed-progress-bar {
            flex: 1;
            min-width: 0;
        }
    }

    .failed-actions {
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex-shrink: 0;
    }
}
</style>
