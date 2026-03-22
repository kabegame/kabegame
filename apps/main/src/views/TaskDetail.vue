<template>
    <div class="task-detail" v-pull-to-refresh="pullToRefreshOpts">
        <div v-if="loading" class="detail-body detail-body-loading">
            <el-skeleton :rows="8" animated />
        </div>
        <ImageGrid v-else ref="taskViewRef" class="detail-body" :images="images"
            :enable-ctrl-wheel-adjust-columns="!IS_ANDROID" :enable-ctrl-key-adjust-columns="!IS_ANDROID"
            :enable-virtual-scroll="!IS_ANDROID" :actions="imageActions" :on-context-command="handleImageMenuCommand"
            @retry-download="handleRetryDownload">
            <template #before-grid>
                <TaskDetailPageHeader :task-name="taskName" :task-subtitle="taskSubtitle"
                    :show-stop-task="shouldShowStopButton" @refresh="handleRefresh" @stop-task="handleStopTask"
                    @delete-task="handleDeleteTask" @add-to-album="handleHeaderAddToAlbum" @help="openHelpDrawer"
                    @quick-settings="openQuickSettings" @back="goBack" />

                <GalleryBigPaginator :total-count="totalImagesCount" :current-offset="currentOffset"
                    :big-page-size="BIG_PAGE_SIZE" :is-sticky="true" @jump-to-page="handleJumpToPage" />
            </template>
        </ImageGrid>

        <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds" :task-id="addToAlbumTaskId"
            @added="handleAddedToAlbum" />

        <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
            :message="removeDialogMessage" :title="$t('tasks.confirmDelete')" :checkbox-label="t('gallery.deleteSourceFilesCheckboxLabel')"
            :danger-text="t('gallery.deleteSourceFilesDangerText')" :safe-text="t('gallery.deleteSourceFilesSafeText')"
            :hide-checkbox="IS_ANDROID" @confirm="confirmRemoveImages" />
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { setWallpaperByImageIdWithModeFallback } from "@/utils/wallpaperMode";
import { listen } from "@tauri-apps/api/event";
import { ElMessage, ElMessageBox } from "element-plus";
import { VideoPause, Delete, Setting, Refresh, QuestionFilled, Star, StarFilled, InfoFilled, DocumentCopy, Picture, FolderAdd, MoreFilled } from "@element-plus/icons-vue";
import { createImageActions } from "@/actions/imageActions";
import ImageGrid from "@/components/ImageGrid.vue";
import type { ImageInfo as CoreImageInfo } from "@kabegame/core/types/image";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import TaskDetailPageHeader from "@/components/header/TaskDetailPageHeader.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useSelectionStore } from "@kabegame/core/stores/selection";
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
import { useProviderPathRoute } from "@/composables/useProviderPathRoute";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { IS_ANDROID } from "@kabegame/core/env";
import { clearImageStateCache } from "@kabegame/core/composables/useImageStateCache";
import { useImageTypes } from "@/composables/useImageTypes";
import { openLocalImage } from "@/utils/openLocalImage";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";

const { t } = useI18n();
const { pluginName: resolvePluginName } = usePluginManifestI18n();

type TaskFailedImage = {
    id: number;
    taskId: string;
    pluginId: string;
    url: string;
    order: number;
    createdAt: number;
    lastError?: string | null;
    lastAttemptedAt?: number | null;
};

const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const desktopSelectionStore = useSelectionStore();
const pluginStore = usePluginStore();
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

const taskId = ref<string>("");
const taskName = ref<string>("");
const taskStatus = ref<string>("");
const taskInfo = ref<any>(null);
const totalImagesCount = ref<number>(0); // provider.total（成功下载的图片数）

// 从 store 获取任务状态（确保状态同步）
const taskStatusFromStore = computed(() => {
    if (!taskId.value) return "";
    const task = crawlerStore.tasks.find((t) => t.id === taskId.value);
    return task?.status || taskStatus.value || "";
});

// 安卓下优先用 store 中的任务数据（与 1s 轮询同步），用于副标题等展示
const taskFromStoreForDisplay = computed(() => {
    if (!IS_ANDROID || !taskId.value) return null;
    return crawlerStore.tasks.find((t) => t.id === taskId.value) ?? null;
});

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
const images = ref<ImageInfo[]>([]);
const failedImages = ref<TaskFailedImage[]>([]);
const taskViewRef = ref<any>(null);
const taskContainerRef = ref<HTMLElement | null>(null);
const currentWallpaperImageId = ref<string | null>(null);

// 记录“用户主动点击重试”的失败记录（用于成功下载后刷新时精准移除占位）
const retryingFailedIds = ref(new Map<number, string>()); // failedId -> url

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
let unlistenTaskProgress: (() => void) | null = null;
let unlistenDownloadState: (() => void) | null = null;
let unlistenTaskStatus: (() => void) | null = null;

const taskSubtitle = computed(() => {
    const parts: string[] = [];
    // 总数：以 provider.total 为准（避免被分页/leaf 限制）
    const failedTotal = failedImages.value.length;
    const okTotal = totalImagesCount.value;
    parts.push(t("tasks.totalCount", { n: okTotal }));
    if (failedTotal > 0) parts.push(t("tasks.failedCount", { n: failedTotal }));
    // 安卓优先用 store 数据（与 1s 轮询一致），否则用 taskInfo
    const src = IS_ANDROID && taskFromStoreForDisplay.value ? taskFromStoreForDisplay.value : taskInfo.value;
    if (src?.deletedCount && src.deletedCount > 0) {
        parts.push(t("tasks.deletedCount", { n: src.deletedCount }));
    }
    if (src?.startTime) {
        // 仅当任务仍在运行时才用 currentTime 实时更新；结束后用 endTime 固定显示
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
    if (!taskId.value) return;
    isRefreshing.value = true;
    try {
        // 手动刷新：重新拉取任务信息与图片列表，确保与后端/DB 同步
        clearImageStateCache();
        await loadTaskInfo();
        await loadTaskImages({ showSkeleton: false });
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

// leaf 分页：安卓与桌面统一每页 100 张，无虚拟滚动
const BIG_PAGE_SIZE = 100;
const {
    currentPath,
    currentPage,
    currentOffset,
    setRootAndPage,
    navigateToPage,
} = useProviderPathRoute({
    route,
    router,
    defaultPath: computed(() => `task/${taskId.value}/1`),
});

const handleJumpToPage = async (page: number) => {
    await navigateToPage(page);
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

const loadTaskImages = async (options?: { showSkeleton?: boolean }) => {
    if (!taskId.value) return;
    const showSkeleton = options?.showSkeleton ?? true;
    if (showSkeleton) loading.value = true;
    try {
        // 直接加载当前路径（新路径格式总是包含页码）
        const pathToLoad = currentPath.value || localProviderRootPath.value || `task/${taskId.value}/1`;
        const res = await invoke<{ total?: number; baseOffset?: number; entries?: Array<{ kind: string; image?: ImageInfo }> }>(
            "browse_gallery_provider",
            { path: pathToLoad }
        );
        totalImagesCount.value = res?.total ?? 0;
        const imgs: ImageInfo[] = (res?.entries ?? [])
            .filter((e: any) => e?.kind === "image")
            .map((e: any) => e.image as ImageInfo);
        // 同步拉取失败图片并合并到同一网格：
        // - 初始显示顺序：按 order 升序（任务开始下载的顺序）
        // - 之后成功下载：由 images-change 触发刷新
        const failed = await invoke<TaskFailedImage[]>("get_task_failed_images", { taskId: taskId.value });
        failedImages.value = failed || [];

        // 失败占位需要按当前大页过滤，否则翻页后仍会把第 1 页失败项混进来
        const orders = failedImages.value.map((f) => f.order ?? 0);
        const minOrder = orders.length > 0 ? Math.min(...orders) : 0;
        const base = minOrder === 1 ? 1 : 0; // 兼容 order 1-based/0-based
        const startOrder = currentOffset.value + base;
        const endOrder = currentOffset.value + BIG_PAGE_SIZE + base;
        const failedInPage = failedImages.value.filter((f) => {
            const o = f.order ?? 0;
            return o >= startOrder && o < endOrder;
        });

        const failedAsImages: ImageInfo[] = (failedInPage || []).map((f) => ({
            id: `failed:${f.id}`,
            url: f.url,
            localPath: "",
            localExists: true,
            pluginId: f.pluginId,
            taskId: f.taskId,
            crawledAt: f.order,
            metadata: undefined,
            thumbnailPath: "",
            favorite: false,
            hash: "",
            order: f.order,
            isTaskFailed: true,
            taskFailedId: f.id,
            taskFailedError: f.lastError || undefined,
        }));

        const merged = [...imgs, ...failedAsImages];
        merged.sort((a, b) => (a.order ?? a.crawledAt ?? 0) - (b.order ?? b.crawledAt ?? 0));
        images.value = merged;

    } catch (e) {
        console.error("加载任务图片失败:", e);
        // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
        ElMessage.error(t("tasks.loadImagesFailed"));
    } finally {
        if (showSkeleton) loading.value = false;
    }
};

const syncFailedPlaceholdersIncremental = async () => {
    if (!taskId.value) return;
    try {
        const failed = await invoke<TaskFailedImage[]>("get_task_failed_images", { taskId: taskId.value });
        failedImages.value = failed || [];

        const orders = failedImages.value.map((f) => f.order ?? 0);
        const minOrder = orders.length > 0 ? Math.min(...orders) : 0;
        const base = minOrder === 1 ? 1 : 0;
        const startOrder = currentOffset.value + base;
        const endOrder = currentOffset.value + BIG_PAGE_SIZE + base;
        const failedInPage = failedImages.value.filter((f) => {
            const o = f.order ?? 0;
            return o >= startOrder && o < endOrder;
        });

        const existingFailedIds = new Set<number>();
        for (const img of images.value) {
            if (img.isTaskFailed && img.taskFailedId) existingFailedIds.add(img.taskFailedId);
        }

        const toAppend: ImageInfo[] = [];
        for (const f of failedInPage) {
            if (existingFailedIds.has(f.id)) continue;
            toAppend.push({
                id: `failed:${f.id}`,
                url: f.url,
                localPath: "",
                localExists: true,
                pluginId: f.pluginId,
                taskId: f.taskId,
                crawledAt: f.order,
                metadata: undefined,
                thumbnailPath: "",
                favorite: false,
                hash: "",
                order: f.order,
                isTaskFailed: true,
                taskFailedId: f.id,
                taskFailedError: f.lastError || undefined,
            });
        }
        if (toAppend.length === 0) return;

        // 刷新后：不对全量 images 排序，避免影响任务内顺序语义。
        images.value = [...images.value, ...toAppend];
    } catch (e) {
        // ignore（不影响主流程）
    }
};

const removeFailedPlaceholderById = (failedId: number) => {
    const key = `failed:${failedId}`;
    const before = images.value.length;
    images.value = images.value.filter((img) => img.id !== key);
    if (images.value.length !== before) {
        // no-op
    }
};

const handleRetryDownloadInner = async (payload: { image: any }) => {
    const img = payload?.image as any;
    if (!img?.isTaskFailed || !img.taskFailedId || !img.url) return;
    const failedId = img.taskFailedId;
    retryingFailedIds.value.set(failedId, img.url);

    // 不再前端预下载（会遇到 CORS / WebView 限制）：
    // 直接走后端 download_image 重试
    try {
        await invoke("retry_task_failed_image", { failedId });
        ElMessage.info(t("tasks.retryDownloadSent"));
    } catch (err) {
        console.error("重试下载失败:", err);
        ElMessage.error(t("tasks.retryDownloadFailed"));
        retryingFailedIds.value.delete(failedId);
    }
};

// 模板事件处理函数应返回 void（避免 TS 报错）
const handleRetryDownload = (payload: { image: any }) => {
    void handleRetryDownloadInner(payload);
};

const loadTaskInfo = async () => {
    if (!taskId.value) return;
    try {
        const task = await invoke<any>("get_task", { taskId: taskId.value });
        if (task) {
            taskInfo.value = task;
            taskStatus.value = task.status || "";
            // 获取插件名称（plugin.name 为 i18n 对象，需解析）；builtin local-import 用 i18n
            if (task.pluginId === "local-import") {
                taskName.value = t("tasks.drawerLocalImport");
            } else {
                const plugin = pluginStore.plugins.find((p) => p.id === task.pluginId);
                taskName.value = plugin ? (resolvePluginName(plugin) || task.pluginId) : (task.pluginId || t("tasks.task"));
            }
            // 同步更新 store 中的任务信息（确保 deletedCount 等字段同步）
            // 运行中任务不覆盖 progress，避免用 DB 的旧值覆盖事件驱动的实时进度
            const taskIndex = crawlerStore.tasks.findIndex((t) => t.id === taskId.value);
            if (taskIndex !== -1) {
                crawlerStore.tasks[taskIndex].deletedCount = task.deletedCount ?? 0;
                crawlerStore.tasks[taskIndex].status = task.status;
                if (task.status !== "running") {
                    crawlerStore.tasks[taskIndex].progress = task.progress ?? 0;
                }
            }
        }
    } catch (e) {
        console.error("加载任务信息失败:", e);
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
        // 不写入本地“stopped”伪状态：任务最终状态由后端 task-status / task-error 事件与 DB 同步驱动
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

// 切换收藏（仅更新本页 images + 收藏画册缓存/计数；不触碰 Gallery 的 crawlerStore.images）
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

    // 1) 更新本页列表
    const idSet = new Set(succeededIds);
    images.value = images.value.map((img) =>
        idSet.has(img.id) ? ({ ...img, favorite: desiredFavorite } as ImageInfo) : img
    );

    // 2) 更新收藏画册计数/缓存（用于 Albums/收藏画册详情页）
    const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID.value] || 0;
    albumStore.albumCounts[FAVORITE_ALBUM_ID.value] = Math.max(
        0,
        currentCount + (desiredFavorite ? succeededIds.length : -succeededIds.length)
    );

    const favList = albumStore.albumImages[FAVORITE_ALBUM_ID.value];
    if (Array.isArray(favList)) {
        if (desiredFavorite) {
            // 追加或更新
            for (const id of succeededIds) {
                const src = images.value.find((x) => x.id === id) || toChange.find((x) => x.id === id);
                if (!src) continue;
                const idx = favList.findIndex((x) => x.id === id);
                if (idx === -1) favList.push({ ...src, favorite: true } as ImageInfo);
                else favList[idx] = { ...(favList[idx] as any), favorite: true } as any;
            }
        } else {
            // 移除
            const removeSet = new Set(succeededIds);
            for (let i = favList.length - 1; i >= 0; i--) {
                if (removeSet.has(favList[i]!.id)) favList.splice(i, 1);
            }
        }
    }

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
        ? images.value.filter((img) => selectedSet.has(img.id) && !img.isTaskFailed)
        : image.isTaskFailed
            ? []
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
                    await crawlerStore.batchRemoveImages(imageIds);

                    // 更新本地状态
                    const ids = new Set(imageIds);
                    images.value = images.value.filter((img) => !ids.has(img.id));
                    clearSelection();

                    // 重新加载任务信息以获取最新的 deletedCount
                    await loadTaskInfo();
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
            await crawlerStore.batchDeleteImages(imageIds);
        } else {
            await crawlerStore.batchRemoveImages(imageIds);
        }

        // 更新本地状态（因为批量 API 已经在 store 中更新了全局状态，但这里需要更新局部状态）
        const ids = new Set(imageIds);
        images.value = images.value.filter((img) => !ids.has(img.id));
        clearSelection();

        // 重新加载任务信息以获取最新的 deletedCount
        await loadTaskInfo();

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
    await settingsStore.loadAll();
    await loadTaskInfo();
    await loadTaskImages();
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

    // 监听任务进度更新事件：用事件中的 progress 更新 store（避免被 loadTaskInfo 的 DB 旧值覆盖）；
    // 仅在进度 100% 时拉取任务信息以同步 end_time 等
    if (!unlistenTaskProgress) {
        unlistenTaskProgress = await listen(
            "task-progress",
            async (event) => {
                const payload: any = event.payload as any;
                const tid = String(payload?.task_id ?? "").trim();
                if (!tid || tid !== taskId.value) return;
                const newProgress = Number(payload?.progress ?? NaN);
                if (!Number.isFinite(newProgress)) return;
                const taskIndex = crawlerStore.tasks.findIndex((t) => t.id === tid);
                if (taskIndex !== -1) {
                    crawlerStore.tasks[taskIndex].progress = newProgress;
                }
                if (newProgress >= 100) {
                    await loadTaskInfo();
                }
            }
        );
    }

    // 监听下载状态：当出现失败时，实时把失败占位插入 TaskDetail（无需用户手动刷新）
    if (!unlistenDownloadState) {
        unlistenDownloadState = await listen("download-state", async (event) => {
            const payload: any = event.payload as any;
            const tid = String(payload?.task_id ?? "").trim();
            if (!tid || tid !== taskId.value) return;
            if (String(payload?.state ?? "") !== "failed") return;
            // 后端在 emit failed 前已写入 task_failed_images，因此这里可直接拉取增量
            await syncFailedPlaceholdersIncremental();
        });
    }

    // 监听任务状态：当任务结束（取消/完成/失败）时停止计时并刷新 taskInfo，使 header 显示固定运行时间
    if (!unlistenTaskStatus) {
        unlistenTaskStatus = await listen("task-status", async (event) => {
            const payload: any = event.payload as any;
            const tid = String(payload?.task_id ?? "").trim();
            if (!tid || tid !== taskId.value) return;
            const status = String(payload?.status ?? "").trim();
            if (status === "running") return;
            stopTimers();
            await loadTaskInfo();
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
    if (unlistenTaskProgress) {
        unlistenTaskProgress();
        unlistenTaskProgress = null;
    }
    if (unlistenDownloadState) {
        unlistenDownloadState();
        unlistenDownloadState = null;
    }
    if (unlistenTaskStatus) {
        unlistenTaskStatus();
        unlistenTaskStatus = null;
    }
};

// 统一图片变更事件：不做增量同步，收到 images-change 后刷新"当前页"（1000ms trailing 节流，不丢最后一次）
// 始终启用，不管是否在前台（用于同步删除等操作和更新 deletedCount）
useImagesChangeRefresh({
    enabled: ref(true),
    waitMs: 1000,
    filter: (p) => {
        // 明确 taskId 且不匹配：直接忽略
        if (p.taskId && p.taskId !== taskId.value) return false;
        // 新增图片：imageIds 在刷新前必然不在当前列表里，因此不能用“命中当前页”来过滤
        const reason = String((p as any)?.reason ?? "");
        if (p.taskId && p.taskId === taskId.value && reason === "add") return true;
        // 若给了 imageIds：只有命中当前页才刷新（减少无关的全局删除/去重事件导致的刷新）
        const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
        if (ids.length > 0) {
            return ids.some((id) => images.value.some((img) => img.id === id));
        }
        // 没有任何可用 hint：保守刷新
        return true;
    },
    onRefresh: async () => {
        if (!taskId.value) return;
        const prevList = images.value.slice();
        await loadTaskInfo();
        await loadTaskImages({ showSkeleton: false });

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
    // 页面失活时清空选择
    desktopSelectionStore.selectedIds = new Set();
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
}
</style>
