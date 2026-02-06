<template>
    <div class="task-detail">
        <div v-if="loading" class="detail-body detail-body-loading">
            <el-skeleton :rows="8" animated />
        </div>
        <ImageGrid v-else ref="taskViewRef" class="detail-body" :images="images" :image-url-map="imageSrcMap"
            enable-virtual-scroll :enable-ctrl-wheel-adjust-columns="true" :show-empty-state="true"
            :context-menu-component="TaskImageContextMenu" :on-context-command="handleImageMenuCommand"
            @retry-download="handleRetryDownload" @scroll-stable="loadImageUrls()">
            <template #before-grid>
                <PageHeader :title="taskName || '任务'" :subtitle="taskSubtitle" show-back @back="goBack">
                    <el-button @click="handleRefresh" :loading="isRefreshing" :disabled="loading || !taskId">
                        <el-icon>
                            <Refresh />
                        </el-icon>
                        <span style="margin-left: 4px;">刷新</span>
                    </el-button>
                    <el-button v-if="shouldShowStopButton" type="warning" @click="handleStopTask">
                        <el-icon>
                            <VideoPause />
                        </el-icon>
                        <span style="margin-left: 4px;">停止任务</span>
                    </el-button>
                    <el-button type="danger" @click="handleDeleteTask">
                        <el-icon>
                            <Delete />
                        </el-icon>
                        <span style="margin-left: 4px;">删除任务</span>
                    </el-button>
                    <TaskDrawerButton />
                    <el-button @click="openHelpDrawer" circle title="帮助">
                        <el-icon>
                            <QuestionFilled />
                        </el-icon>
                    </el-button>
                    <el-button @click="openQuickSettings" circle>
                        <el-icon>
                            <Setting />
                        </el-icon>
                    </el-button>
                </PageHeader>

                <!-- 大页分页器（与 Gallery/AlbumDetail 一致：1000/页，对齐后端 provider 叶子目录） -->
                <GalleryBigPaginator :total-count="totalImagesCount" :current-offset="currentOffset"
                    :big-page-size="BIG_PAGE_SIZE" :is-sticky="true" @jump-to-page="handleJumpToPage" />
            </template>
        </ImageGrid>

        <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds" @added="handleAddedToAlbum" />

        <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
            :message="removeDialogMessage" title="确认删除" @confirm="confirmRemoveImages" />
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessage, ElMessageBox } from "element-plus";
import { VideoPause, Delete, Setting, Refresh, QuestionFilled } from "@element-plus/icons-vue";
import TaskImageContextMenu from "@/components/contextMenu/TaskImageContextMenu.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useImageOperations } from "@/composables/useImageOperations";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { useImageUrlLoader } from "@kabegame/core/composables/useImageUrlLoader";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { buildLeafProviderPathForPage } from "@/utils/gallery-provider-path";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { useBigPageRoute } from "@/composables/useBigPageRoute";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";

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
const pluginStore = usePluginStore();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);
const preferOriginalInGrid = computed(() => imageGridColumns.value <= 2);

const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");

const isOnTaskRoute = computed(() => {
    const n = String(route.name ?? "");
    return n === "TaskDetail" || n === "TaskDetailPaged";
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

// 是否应该显示停止按钮（只在 running 状态显示）
const shouldShowStopButton = computed(() => {
    return taskStatusFromStore.value === "running";
});
const loading = ref(false);
const isRefreshing = ref(false);
const images = ref<ImageInfo[]>([]);
const failedImages = ref<TaskFailedImage[]>([]);
const taskViewRef = ref<any>(null);
const taskContainerRef = ref<HTMLElement | null>(null);
const currentWallpaperImageId = ref<string | null>(null);

// 记录“用户主动点击重试”的失败记录（用于成功下载后刷新时精准移除占位）
const retryingFailedIds = ref(new Map<number, string>()); // failedId -> url

const { isInteracting } = useImageGridAutoLoad({
    containerRef: taskContainerRef,
    onLoad: () => void loadImageUrls(),
});

const {
    imageSrcMap,
    loadImageUrls,
    removeFromCacheByIds,
    reset: resetImageUrlLoader,
    cleanup: cleanupImageUrlLoader,
} = useImageUrlLoader({
    containerRef: taskContainerRef,
    imagesRef: images,
    preferOriginalInGrid,
    gridColumns: imageGridColumns,
    isInteracting,
});

const { handleCopyImage } = useImageOperations(
    images,
    imageSrcMap,
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
        if (taskContainerRef.value && images.value.length > 0) {
            requestAnimationFrame(() => void loadImageUrls());
        }
    },
    { immediate: true }
);

// 用于实时更新运行时间的响应式时间戳
const currentTime = ref<number>(Date.now());
let timeUpdateInterval: number | null = null;
let unlistenTaskProgress: (() => void) | null = null;
let unlistenDownloadState: (() => void) | null = null;

const taskSubtitle = computed(() => {
    const parts: string[] = [];
    // 总数：以 provider.total 为准（避免被分页/leaf 限制成 1000）
    const failedTotal = failedImages.value.length;
    const okTotal = totalImagesCount.value;
    parts.push(`共 ${okTotal} 张`);
    if (failedTotal > 0) parts.push(`失败 ${failedTotal} 张`);
    // 如果已删除数量 > 0，显示已删除数量
    if (taskInfo.value?.deletedCount && taskInfo.value.deletedCount > 0) {
        parts.push(`已删除 ${taskInfo.value.deletedCount} 张`);
    }
    if (taskInfo.value?.startTime) {
        // 如果任务正在运行且没有结束时间，使用 currentTime 来实时更新
        const duration = formatDuration(taskInfo.value.startTime, taskInfo.value.endTime, currentTime.value);
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
        return `运行 ${hours} 小时 ${minutes % 60} 分钟`;
    } else if (minutes > 0) {
        return `运行 ${minutes} 分钟`;
    } else {
        return `运行 ${seconds} 秒`;
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
        await loadTaskInfo();
        await loadTaskImages({ showSkeleton: false });
        ElMessage.success("刷新成功");
    } catch (error) {
        console.error("刷新失败:", error);
        ElMessage.error("刷新失败");
    } finally {
        isRefreshing.value = false;
    }
};

// leaf 分页：每页 1000 张（与后端 provider 对齐）
const BIG_PAGE_SIZE = 1000;
const { currentPage, currentOffset, jumpToPage } = useBigPageRoute({
    route,
    router,
    baseRouteName: "TaskDetail",
    pagedRouteName: "TaskDetailPaged",
    bigPageSize: BIG_PAGE_SIZE,
    getBaseParams: () => ({ id: taskId.value }),
    getPagedParams: (page) => ({ id: taskId.value, page: String(page) }),
});

const handleJumpToPage = async (page: number) => {
    await jumpToPage(page);
};

// 跟随 page 变化重载当前 leaf（支持分页器跳转/浏览器前进后退）
watch(
    () => currentPage.value,
    (p, prev) => {
        if (!isOnTaskRoute.value) return;
        if (!taskId.value) return;
        if (p === prev) return;
        void loadTaskImages({ showSkeleton: false });
    }
);

const providerRootPath = computed(() => {
    if (!taskId.value) return "";
    return `按任务/${taskId.value}`;
});

const loadTaskImages = async (options?: { showSkeleton?: boolean }) => {
    if (!taskId.value) return;
    const showSkeleton = options?.showSkeleton ?? true;
    if (showSkeleton) loading.value = true;
    let imgs: ImageInfo[] = [];
    try {
        // 统一走 provider-path 浏览（与 VD 一致）：按任务/<taskId>[/range...]
        const root = providerRootPath.value;
        if (root) {
            const probe = await invoke<any>("browse_gallery_provider", { path: root });
            const total = (probe?.total ?? 0) as number;
            totalImagesCount.value = total;
            if (total <= 0) {
                imgs = [];
            } else if (total <= BIG_PAGE_SIZE) {
                imgs = (probe?.entries ?? [])
                    .filter((e: any) => e?.kind === "image")
                    .map((e: any) => e.image as ImageInfo);
            } else {
                const leaf = buildLeafProviderPathForPage(root, total, currentPage.value);
                const leafRes = await invoke<any>("browse_gallery_provider", { path: leaf.path });
                imgs = (leafRes?.entries ?? [])
                    .filter((e: any) => e?.kind === "image")
                    .map((e: any) => e.image as ImageInfo);
            }
        }
        // 同步拉取失败图片并合并到同一网格：
        // - 初始显示顺序：按 order 升序（任务开始下载的顺序）
        // - 之后成功下载：由 images-change 触发刷新
        const failed = await invoke<TaskFailedImage[]>("get_task_failed_images", { taskId: taskId.value });
        failedImages.value = failed || [];

        // 失败占位需要按当前大页过滤，否则翻页后仍会把第 1 页失败项混进来，看起来像“永远停在前 1000”
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

        // 清理旧资源
        resetImageUrlLoader();
    } catch (e) {
        console.error("加载任务图片失败:", e);
        // 兜底：避免“静默 0 张”让用户误判，提示可能是 provider-path 解析/缓存导致的问题
        ElMessage.error("加载任务图片失败，请稍后重试或点击右上角“刷新”");
    } finally {
        if (showSkeleton) loading.value = false;
    }
    requestAnimationFrame(() => void loadImageUrls());
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
        void loadImageUrls(toAppend);
    } catch (e) {
        // ignore（不影响主流程）
    }
};

const removeFailedPlaceholderById = (failedId: number) => {
    const key = `failed:${failedId}`;
    const before = images.value.length;
    images.value = images.value.filter((img) => img.id !== key);
    if (images.value.length !== before) {
        removeFromCacheByIds([key]);
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
        ElMessage.info("已发起重试下载");
    } catch (err) {
        console.error("重试下载失败:", err);
        ElMessage.error("重试下载失败");
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
            // 获取插件名称
            const plugin = pluginStore.plugins.find((p) => p.id === task.pluginId);
            taskName.value = plugin?.name || task.pluginId || "任务";
            // 同步更新 store 中的任务信息（确保 deletedCount 等字段同步）
            const taskIndex = crawlerStore.tasks.findIndex((t) => t.id === taskId.value);
            if (taskIndex !== -1) {
                crawlerStore.tasks[taskIndex].deletedCount = task.deletedCount ?? 0;
                crawlerStore.tasks[taskIndex].status = task.status;
                crawlerStore.tasks[taskIndex].progress = task.progress ?? 0;
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
            "确定要停止这个任务吗？已下载的图片将保留，未开始的任务将取消。",
            "停止任务",
            { type: "warning" }
        );
        await crawlerStore.stopTask(taskId.value);
        // 不写入本地“stopped”伪状态：任务最终状态由后端 task-status / task-error 事件与 DB 同步驱动
        ElMessage.info("任务已请求停止");
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
            ? "当前任务正在运行，删除前将先终止任务。确定继续吗？"
            : "确定要删除这个任务吗？";
        await ElMessageBox.confirm(msg, "确认删除", { type: "warning" });

        if (needStop) {
            try {
                await crawlerStore.stopTask(taskId.value);
            } catch (err) {
                console.error("终止任务失败，已取消删除", err);
                ElMessage.error("终止任务失败，删除已取消");
                return;
            }
        }

        await crawlerStore.deleteTask(taskId.value);
        ElMessage.success("任务已删除");
        router.back();
    } catch (error) {
        if (error !== "cancel") {
            ElMessage.error("删除失败");
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

// 加入画册对话框
const showAddToAlbumDialog = ref(false);
const addToAlbumImageIds = ref<string[]>([]);
const handleAddedToAlbum = () => {
    clearSelection();
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
            await invoke("set_wallpaper_by_image_id", {
                imageId: imagesToProcess[0].id,
            });
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
        payload?.selectedImageIds && payload.selectedImageIds.size > 0
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
            addToAlbumImageIds.value = imagesToProcess.map((img) => img.id);
            showAddToAlbumDialog.value = true;
            break;
        case "wallpaper":
            if (imagesToProcess.length > 0) {
                await setWallpaper(imagesToProcess);
            }
            break;
        case "open":
            if (!isMultiSelect && imagesToProcess.length === 1) {
                try {
                    await invoke("open_file_path", { filePath: imagesToProcess[0].localPath });
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
            removeDialogMessage.value = `将删除${count > 1 ? `这 ${count} 张图片` : "这张图片"}。`;
            removeDeleteFiles.value = false; // 默认不删除文件
            showRemoveDialog.value = true;
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
        removeFromCacheByIds(imageIds);
        clearSelection();

        // 重新加载任务信息以获取最新的 deletedCount
        await loadTaskInfo();

        const action = shouldDeleteFiles ? "删除" : "移除";
        ElMessage.success(
            `${count > 1 ? `已${action} ${count} 张图片` : `已${action}图片`}`
        );
    } catch (error) {
        console.error("删除图片失败:", error);
        const action = shouldDeleteFiles ? "删除" : "移除";
        ElMessage.error(`${action}失败`);
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

    // 监听任务进度更新事件，当任务状态变化时重新加载任务信息
    if (!unlistenTaskProgress) {
        unlistenTaskProgress = await listen(
            "task-progress",
            async (event) => {
                const payload: any = event.payload as any;
                const tid = String(payload?.task_id ?? "").trim();
                if (tid && tid === taskId.value) {
                    // 重新加载任务信息以获取最新的状态和结束时间
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

        const { addedIds, removedIds } = diffById(prevList, images.value);
        if (removedIds.length > 0) {
            removeFromCacheByIds(removedIds);
            taskViewRef.value?.clearSelection?.();
        }
        if (addedIds.length > 0) {
            const addedSet = new Set(addedIds);
            const addedImages = images.value.filter((img) => addedSet.has(img.id));
            if (addedImages.length > 0) {
                void loadImageUrls(addedImages);
            }
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
    cleanupImageUrlLoader();
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
    // 页面失活时清理定时器和事件监听器：TaskDetail 的数据仅在激活时刷新
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
