<template>
    <div class="task-detail" v-pull-to-refresh="pullToRefreshOpts">
        <div v-if="loading" class="detail-body detail-body-loading">
            <el-skeleton :rows="8" animated />
        </div>
        <ImageGrid v-else ref="taskViewRef" class="detail-body" :images="images"
            :enable-ctrl-wheel-adjust-columns="!isCompact" :enable-ctrl-key-adjust-columns="!isCompact" enable-virtual-scroll
            :actions="imageActions" :on-context-command="handleImageMenuCommand" scroll-whole-container hide-scrollbar
            @preview-page-boundary="handlePreviewPageBoundary">
            <template #before-grid>
                <TaskDetailPageHeader :task-name="taskName"
                    :show-stop-task="shouldShowStopButton" @refresh="handleRefresh" @stop-task="handleStopTask"
                    @delete-task="handleDeleteTask" @add-to-album="handleHeaderAddToAlbum" @help="openHelpDrawer"
                    @quick-settings="openQuickSettings" @view-task-log="handleViewTaskLog" @view-task-params="handleViewTaskParams" @back="goBack">
                    <template #subtitle>
                        <TaskCountsInline :success="successN" :failed="failedN" :deleted="deletedN" :dedup="dedupN"
                            :duration="durationText" />
                    </template>
                </TaskDetailPageHeader>

                    <div class="task-detail-page-size-toolbar">
                        <GalleryPageSizeControl
                            :page-size="pageSize"
                            variant="gallery"
                            android-ui="inline"
                            @update:page-size="(ps) => taskDetailRouteStore.navigate({ page: 1, pageSize: ps })"
                        />
                        <SearchInput
                            v-if="!isCompact"
                            :model-value="searchQuery"
                            :placeholder="t('gallery.searchPlaceholder')"
                            class="task-detail-search"
                            @update:model-value="(v) => taskDetailRouteStore.navigate({ page: 1, search: v })"
                        />
                    </div>

                    <GalleryBigPaginator :total-count="totalImagesCount" :current-page="currentPage"
                    :big-page-size="pageSize" :is-sticky="true" @jump-to-page="handleJumpToPage" />
            </template>
        </ImageGrid>

        <AddToAlbumDialog :open="addToAlbumDialog.isOpen.value" :z-index="addToAlbumDialog.zIndex.value" :image-ids="addToAlbumImageIds" :task-id="addToAlbumTaskId"
            @close="addToAlbumDialog.close()" @added="handleAddedToAlbum" />

        <RemoveImagesConfirmDialog :open="removeDialog.isOpen.value" :z-index="removeDialog.zIndex.value" :message="removeDialogMessage"
            :title="$t('tasks.confirmDelete')" hide-checkbox @close="removeDialog.close()" @confirm="confirmRemoveImages" />

        <TaskLogDialog ref="taskLogDialogRef" />
        <TaskParamsDialog :open="taskParamsDialog.isOpen.value" :z-index="taskParamsDialog.zIndex.value" :task="taskParamsTask" @close="taskParamsDialog.close()" />
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@/api/rpc";
import { pathqlFetch } from "@/services/pathql";
import { rowToImageInfo } from "@/utils/imageRow";
import { withGalleryPrefix } from "@/utils/path";
import { setWallpaperOrBackground } from "@/utils/wallpaperMode";
import { listen } from "@/api/rpc";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Delete, Star, StarFilled } from "@element-plus/icons-vue";
import { createImageActions } from "@/actions/imageActions";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import SearchInput from "@/components/SearchInput.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import TaskDetailPageHeader from "@/components/header/TaskDetailPageHeader.vue";
import TaskLogDialog from "@kabegame/core/components/task/TaskLogDialog.vue";
import TaskParamsDialog from "@kabegame/core/components/task/TaskParamsDialog.vue";
import type { TaskRunParamsTask } from "@kabegame/core/components/task/TaskRunParamsContent.vue";
import TaskCountsInline from "@kabegame/core/components/task/TaskCountsInline.vue";
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
import type { ContextCommand } from "@/components/ImageGrid.vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { usePagedGallery } from "@/composables/usePagedGallery";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useImageTypes } from "@/composables/useImageTypes";
import { openLocalImage } from "@/utils/openLocalImage";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { IS_WEB } from "@kabegame/core/env";
import { createImageAnalytics } from "@kabegame/core/track/imageAnalytics";
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
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

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

const taskParamsDialog = useModal();
const taskParamsTask = computed<TaskRunParamsTask | null>(() => taskFromStore.value ?? null);
const handleViewTaskParams = () => {
    if (!taskId.value) return;
    taskParamsDialog.open();
};

const taskId = ref<string>("");

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
    isCompact.value
        ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
        : undefined
);
const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();
const images = ref<ImageInfo[]>([]);
const loadedKey = ref("");
const failedImages = computed(() => failedImagesStore.byTaskId(taskId.value));
const taskViewRef = ref<any>(null);
const taskContainerRef = ref<HTMLElement | null>(null);
const currentWallpaperImageId = computed<string | null>({
    get: () => settingsStore.values.currentWallpaperImageId ?? null,
    set: (value) => {
        settingsStore.values.currentWallpaperImageId = value;
    },
});

// Image actions for context menu / action sheet
const imageActions = computed(() => createImageActions({
    removeText: t("tasks.removeText"),
    multiHide: ["favorite", "addToAlbum"]
}));

const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const { handleDownloadImage, handleCopyImage } = useImageOperations(
    images,
    currentWallpaperImageId,
    taskViewRef,
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

const successN = computed(() => taskFromStore.value?.successCount ?? 0);
const failedN = computed(() => taskFromStore.value?.failedCount ?? failedImages.value.length);
const deletedN = computed(() => taskFromStore.value?.deletedCount ?? 0);
const dedupN = computed(() => taskFromStore.value?.dedupCount ?? 0);

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

const durationText = computed(() => {
    const src = taskFromStore.value;
    if (!src?.startTime) return "";
    const isRunning = taskStatusFromStore.value === "running";
    return formatDuration(
        src.startTime,
        src.endTime,
        isRunning ? currentTime.value : undefined
    );
});


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
    analytics.track("task_detail_exit");
    router.back();
};

const handleRefresh = async () => {
    if (!isOnTaskRoute.value) return;
    if (!taskId.value) return;
    isRefreshing.value = true;
    try {
        await Promise.all([
            loadTaskImages({ showSkeleton: false }),
            loadTotalImagesCount(),
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

// 本地计算的 provider root path，用于初始化
const localProviderRootPath = computed(() => {
    if (!taskId.value) return "";
    return `task/${taskId.value}`;
});

const taskDetailRouteStore = useTaskDetailRouteStore();
const { search: searchQuery } = storeToRefs(taskDetailRouteStore);
let lastTrackedTaskPath: string | null = null;

const pagedTask = usePagedGallery({
    routeStore: taskDetailRouteStore,
    images,
    loadedKey,
    viewRef: taskViewRef,
    loading: { startLoading: () => { }, finishLoading: () => { } },
    load: (path) => loadTaskImages({ showSkeleton: false, path }),
    computeCountPath: () => taskDetailRouteStore.contextPath,
    isActive: () => isOnTaskRoute.value && !!taskId.value,
    onCountError: (error) => {
        console.error("加载任务总图片数失败:", error);
    },
});

const totalImagesCount = pagedTask.totalImagesCount;
const currentPath = pagedTask.currentPath;
const currentPage = pagedTask.currentPage;
const pageSize = pagedTask.pageSize;
const loadTotalImagesCount = pagedTask.loadTotalImagesCount;
const handleJumpToPage = pagedTask.handleJumpToPage;
const handlePreviewPageBoundary = pagedTask.handlePreviewPageBoundary;
const ensureValidTaskPageAfterMassRemoval = pagedTask.ensureValidPageAfterMassRemoval;
const analytics = createImageAnalytics(() => ({
    taskId: taskId.value,
    taskName: taskName.value,
    path: currentPath.value,
}));

watch(
    () => [currentPath.value, taskId.value] as const,
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

const loadTaskImages = async (options?: { showSkeleton?: boolean; path?: string }) => {
    if (!isOnTaskRoute.value) return;
    if (!taskId.value) return;
    const showSkeleton = options?.showSkeleton ?? true;
    if (showSkeleton) loading.value = true;
    try {
        const rawPath = options?.path || currentPath.value || localProviderRootPath.value || `task/${taskId.value}/1`;
        const pathToLoad = withGalleryPrefix(rawPath);
        clearImageMetadataCache();
        const rows = await pathqlFetch<Record<string, unknown>>(pathToLoad);
        const imgs = rows.map(rowToImageInfo);
        images.value = imgs;
        loadedKey.value = rawPath;

    } catch (e) {
        console.error("加载任务图片失败:", e);
        // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
        ElMessage.error(t("tasks.loadImagesFailed"));
    } finally {
        if (showSkeleton) loading.value = false;
    }
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

// 永久删除确认对话框相关
const removeDialog = useModal();
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);

const clearSelection = () => {
    taskViewRef.value?.clearSelection?.();
};

// 加入画册对话框（右键菜单用 imageIds，header 一键加入用 taskId）
const addToAlbumDialog = useModal();
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
    addToAlbumDialog.open();
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
        if (IS_WEB && imagesToProcess.length > 0) {
            await setWallpaperOrBackground(imagesToProcess[0].id);
            currentWallpaperImageId.value = imagesToProcess[0].id;
            ElMessage.success("壁纸设置成功");
            clearSelection();
            return;
        }

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

            await settingsStore.ensureLoaded();

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
            await setWallpaperOrBackground(imagesToProcess[0].id);
            currentWallpaperImageId.value = imagesToProcess[0].id;
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
): Promise<ContextCommand | null> => {
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
        case "download":
            for (const img of imagesToProcess) {
                await handleDownloadImage(img);
            }
            break;
        case "copy":
            if (IS_WEB) {
              if (imagesToProcess[0]) await handleCopyImage(imagesToProcess[0]);
            } else if (imagesToProcess[0]) {
              await handleCopyImage(imagesToProcess[0]);
            }
            break;
        case "favorite":
            if (await guardDesktopOnly("favoriteImage", { needSuper: true })) return null;
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
            addToAlbumDialog.open();
            break;
        case "addToHidden": {
            if (await guardDesktopOnly("hideImage", { needSuper: true })) return null;
            const ids = imagesToProcess.map((img) => img.id);
            if (ids.length === 0) return null;
            const isUnhide = !!image.isHidden;
            try {
                if (isUnhide) {
                    await albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids);
                    ElMessage.success(t("contextMenu.unhideSuccess"));
                } else {
                    await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids);
                    ElMessage.success(
                        ids.length > 1
                            ? t("contextMenu.hiddenCount", { count: ids.length })
                            : t("contextMenu.hiddenOne"),
                    );
                }
                taskViewRef.value?.clearSelection?.();
            } catch (e) {
                console.error(isUnhide ? "取消隐藏失败:" : "隐藏失败:", e);
                ElMessage.error(t(isUnhide ? "contextMenu.unhideFailed" : "contextMenu.hideFailed"));
            }
            break;
        }
        case "wallpaper":
            if (imagesToProcess.length > 0) {
                await setWallpaper(imagesToProcess);
            }
            break;
        case "share":
            if (await guardDesktopOnly("share")) break;
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
            // 永久删除确认对话框
            pendingRemoveImages.value = imagesToProcess;
            const count = imagesToProcess.length;
            removeDialogMessage.value = count > 1 ? t("tasks.removeDialogMessageMulti", { count }) : t("tasks.removeDialogMessageSingle");
            removeDialog.open();
            break;
        case "swipe-remove" as any:
            // 上划手势：隐藏（加入隐藏画册，保留磁盘文件）
            if (imagesToProcess.length === 0) return null;
            void (async () => {
                try {
                    const imageIds = imagesToProcess.map(img => img.id);
                    await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, imageIds);
                    ElMessage.success(
                        imageIds.length > 1
                            ? t("contextMenu.hiddenCount", { count: imageIds.length })
                            : t("contextMenu.hiddenOne"),
                    );
                    clearSelection();
                } catch (error) {
                    console.error("隐藏失败:", error);
                    ElMessage.error(t("contextMenu.hideFailed"));
                }
            })();
            break;
    }
    return null;
};

// 确认永久删除
const confirmRemoveImages = async () => {
    const imagesToRemove = pendingRemoveImages.value;
    if (imagesToRemove.length === 0) {
        removeDialog.close();
        return;
    }

    const count = imagesToRemove.length;
    removeDialog.close();

    try {
        const imageIds = imagesToRemove.map(img => img.id);
        await invoke("batch_delete_images", { imageIds });
        clearSelection();
        ElMessage.success(count > 1 ? t("tasks.deleteSuccessCount", { count }) : t("tasks.deleteSuccess"));
    } catch (error) {
        console.error("删除图片失败:", error);
        ElMessage.error(t("tasks.deleteFailed"));
    }
};

const initTask = async (id: string) => {
    taskId.value = id;
    const rawPath = route.query.path;
    const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
    const qpBody = qp.startsWith("hide/") ? qp.slice("hide/".length) : qp;
    if (qpBody.startsWith(`task/${id}/`)) {
        taskDetailRouteStore.syncFromUrl(qp);
    } else {
        await taskDetailRouteStore.navigate({ taskId: id, page: 1 });
    }
    await failedImagesStore.initListeners();
    await settingsStore.ensureLoaded();
    await Promise.all([
        loadTaskImages(),
        loadTotalImagesCount(),
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
            loadTotalImagesCount(),
            failedImagesStore.loadAll(),
        ]);

        const { removedIds } = diffById(prevList, images.value);
        if (removedIds.length > 0) {
            taskViewRef.value?.clearSelection?.();
            await ensureValidTaskPageAfterMassRemoval();
        }
    },
});

// HIDDEN 画册成员变化：重新拉取当前页，让 image.isHidden（决定缩略图透明度）
// 以及在 hide=true 下 HideGate 带来的可见性变化能实时生效。
useAlbumImagesChangeRefresh({
    enabled: ref(true),
    waitMs: 500,
    filter: (p) => (p.albumIds ?? []).includes(HIDDEN_ALBUM_ID),
    onRefresh: async () => {
        if (!isOnTaskRoute.value) return;
        if (!taskId.value) return;
        await Promise.all([
            loadTaskImages({ showSkeleton: false }),
            loadTotalImagesCount(),
        ]);
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
    } else if (taskId.value) {
        // keep-alive 场景：用户可能在别的页面切换了全局 hide（currentPath 的 watcher
        // 在本页未激活时会早退），回来时需要重新拉取当前页以反映最新的 hide 过滤。
        await Promise.all([
            loadTaskImages({ showSkeleton: false }),
            loadTotalImagesCount(),
        ]);
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

    .task-detail-search {
        margin-left: auto;
    }
}
</style>
