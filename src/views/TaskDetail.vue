<template>
    <div class="task-detail">
        <PageHeader :title="taskName || '任务'" :subtitle="taskSubtitle" show-back @back="goBack">
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
            <el-button @click="openQuickSettings" circle>
                <el-icon>
                    <Setting />
                </el-icon>
            </el-button>
        </PageHeader>

        <GalleryView class="detail-body" mode="albumDetail" :loading="loading" :images="images"
            :image-url-map="imageSrcMap" :image-click-action="imageClickAction" :columns="taskColumns"
            :aspect-ratio-match-window="!!taskAspectRatio" :window-aspect-ratio="taskAspectRatio || 16 / 9"
            :allow-select="true" :enable-context-menu="false" :enable-ctrl-wheel-adjust-columns="true"
            :show-empty-state="!loading" :enable-reorder="false" :is-blocked="() => isBlockingOverlayOpen"
            @adjust-columns="(...args) => throttledAdjustColumns(args[0])"
            @selection-change="(...args) => handleSelectionChange(args[0])"
            @image-dbl-click="(...args) => handleImageDblClick(args[0])"
            @contextmenu="(...args) => handleImageContextMenu(args[0], args[1])">

            <template #overlays>
                <ImageContextMenu :visible="imageMenuVisible" :position="imageMenuPosition" :image="imageMenuImage"
                    :selected-count="Math.max(1, selectedImages.size)" :is-image-selected="isImageMenuImageSelected"
                    :simplified-multi-select-menu="false" :hide-favorite-and-add-to-album="false"
                    remove-text="删除" @close="imageMenuVisible = false" @command="handleImageMenuCommand" />

                <ImagePreviewDialog v-model="showPreview" v-model:image-url="previewUrl" :image-path="previewPath"
                    :image="previewImage" @contextmenu="handlePreviewContextMenu" />

                <ImageDetailDialog v-model="showImageDetail" :image="selectedDetailImage" />

                <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="pendingAddToAlbumImageIds"
                    @added="handleAddedToAlbum" />

                <!-- 移除/删除确认对话框 -->
                <el-dialog v-model="showRemoveDialog" title="确认删除" width="420px" destroy-on-close>
                    <div style="margin-bottom: 16px;">
                        <p style="margin-bottom: 8px;">{{ removeDialogMessage }}</p>
                        <el-checkbox v-model="removeDeleteFiles" label="同时从电脑删除源文件（慎用）" />
                        <p class="var-description"
                            :style="{ color: removeDeleteFiles ? 'var(--el-color-danger)' : '' }">
                            {{ removeDeleteFiles ? '警告：该操作将永久删除电脑文件，不可恢复！' : '不勾选仅从画廊移除记录，保留电脑文件。' }}
                        </p>
                    </div>
                    <template #footer>
                        <el-button @click="showRemoveDialog = false">取消</el-button>
                        <el-button type="primary" @click="confirmRemoveImages">确定</el-button>
                    </template>
                </el-dialog>
            </template>
        </GalleryView>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessage, ElMessageBox } from "element-plus";
import { VideoPause, Delete, Setting } from "@element-plus/icons-vue";
import ImagePreviewDialog from "@/components/ImagePreviewDialog.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import ImageContextMenu from "@/components/ImageContextMenu.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import GalleryView from "@/components/GalleryView.vue";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useSettingsStore } from "@/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import { storeToRefs } from "pinia";
import PageHeader from "@/components/common/PageHeader.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useGallerySettings } from "@/composables/useGallerySettings";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";

const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const pluginStore = usePluginStore();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");

// 使用画廊设置 composable
const {
    imageClickAction,
    loadSettings,
} = useGallerySettings();

const taskId = ref<string>("");
const taskName = ref<string>("");
const taskStatus = ref<string>("");
const taskInfo = ref<any>(null);

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
const images = ref<ImageInfo[]>([]);
const imageSrcMap = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const blobUrls = new Set<string>();

// 用于实时更新运行时间的响应式时间戳
const currentTime = ref<number>(Date.now());
let timeUpdateInterval: number | null = null;
let unlistenImageAdded: (() => void) | null = null;
let unlistenTaskProgress: (() => void) | null = null;

const taskSubtitle = computed(() => {
    const parts: string[] = [];
    if (images.value.length > 0) {
        parts.push(`共 ${images.value.length} 张`);
    } else if (taskInfo.value?.totalImages !== undefined) {
        parts.push(`共 ${taskInfo.value.totalImages} 张`);
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

const selectedImages = ref<Set<string>>(new Set());

// 任务详情页本地列数（初始值为 5，不再从设置读取）
const taskColumns = ref(5);
const taskAspectRatio = ref<number | null>(null);

// 调整列数的函数（不保存到设置）
const adjustColumns = (delta: number) => {
    if (delta > 0) {
        // 增加列数（最大 10 列）
        if (taskColumns.value < 10) {
            taskColumns.value++;
        }
    } else {
        // 减少列数（最小 1 列）
        if (taskColumns.value > 1) {
            taskColumns.value--;
        }
    }
};

// 节流函数
const throttle = <T extends (...args: any[]) => any>(func: T, delay: number): T => {
    let lastCall = 0;
    return ((...args: any[]) => {
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            return func(...args);
        }
    }) as T;
};

// 节流后的调整列数函数（100ms 节流）
const throttledAdjustColumns = throttle(adjustColumns, 100);

watch(
    () => settingsStore.values.galleryImageAspectRatio,
    (newValue) => {
        if (!newValue) {
            taskAspectRatio.value = null;
            return;
        }
        const value = newValue as string;
        if (value.includes(":") && !value.startsWith("custom:")) {
            const [w, h] = value.split(":").map(Number);
            if (w && h) {
                taskAspectRatio.value = w / h;
            }
        }
        if (value.startsWith("custom:")) {
            const parts = value.replace("custom:", "").split(":");
            const [w, h] = parts.map(Number);
            if (w && h) {
                taskAspectRatio.value = w / h;
            }
        }
    },
    { immediate: true }
);

const isBlockingOverlayOpen = computed(() => {
    return showPreview.value || showImageDetail.value || showAddToAlbumDialog.value || imageMenuVisible.value;
});

const goBack = () => {
    router.back();
};

const getImageUrl = async (localPath: string): Promise<string> => {
    if (!localPath) return "";
    try {
        const normalizedPath = localPath.trimStart().replace(/^\\\\\?\\/, "");
        const fileData = await readFile(normalizedPath);
        const ext = normalizedPath.split(".").pop()?.toLowerCase();
        let mimeType = "image/jpeg";
        if (ext === "png") mimeType = "image/png";
        else if (ext === "gif") mimeType = "image/gif";
        else if (ext === "webp") mimeType = "image/webp";
        else if (ext === "bmp") mimeType = "image/bmp";
        const blob = new Blob([fileData], { type: mimeType });
        const url = URL.createObjectURL(blob);
        blobUrls.add(url);
        return url;
    } catch (e) {
        console.error("加载图片失败", e);
        return "";
    }
};

const loadTaskImages = async () => {
    if (!taskId.value) return;
    loading.value = true;
    let imgs: ImageInfo[] = [];
    try {
        imgs = await invoke<ImageInfo[]>("get_task_images", { taskId: taskId.value });
        images.value = imgs;

        // 清理旧资源
        blobUrls.forEach((u) => URL.revokeObjectURL(u));
        blobUrls.clear();
        imageSrcMap.value = {};
    } finally {
        loading.value = false;
    }

    // 异步加载图片的 Blob URL
    for (const img of imgs) {
        try {
            const thumbnailUrl = img.thumbnailPath ? await getImageUrl(img.thumbnailPath) : "";
            const originalUrl = await getImageUrl(img.localPath);
            imageSrcMap.value[img.id] = { thumbnail: thumbnailUrl, original: originalUrl };
        } catch (e) {
            console.error(`加载图片 ${img.id} 失败:`, e);
        }
    }
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
        }
    } catch (e) {
        console.error("加载任务信息失败:", e);
    }
};

const handleImageDblClick = async (image: ImageInfo) => {
    if (imageClickAction.value === 'open') {
        try {
            await invoke("open_file_path", { filePath: image.localPath });
        } catch (error) {
            console.error("打开文件失败:", error);
            ElMessage.error("打开文件失败");
        }
    }
};

const handleImageContextMenu = (event: MouseEvent, image: ImageInfo) => {
    event.preventDefault();
    imageMenuImage.value = image;
    imageMenuPosition.value = { x: event.clientX, y: event.clientY };
    imageMenuVisible.value = true;
};

const handlePreviewContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (previewImage.value) {
        imageMenuImage.value = previewImage.value;
        imageMenuPosition.value = { x: event.clientX, y: event.clientY };
        imageMenuVisible.value = true;
    }
};

const handleAddedToAlbum = async () => {
    // 可以在这里刷新画册列表
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
        taskStatus.value = "stopped";
        ElMessage.success("任务已请求停止");
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

// 图片预览相关
const showPreview = ref(false);
const previewUrl = ref("");
const previewPath = ref("");
const previewImage = ref<ImageInfo | null>(null);

// 图片详情相关
const showImageDetail = ref(false);
const selectedDetailImage = ref<ImageInfo | null>(null);

// 图片右键菜单相关
const imageMenuVisible = ref(false);
const imageMenuPosition = ref({ x: 0, y: 0 });
const imageMenuImage = ref<ImageInfo | null>(null);
const isImageMenuImageSelected = computed(() => {
    return imageMenuImage.value ? selectedImages.value.has(imageMenuImage.value.id) : false;
});

// 添加到画册对话框
const showAddToAlbumDialog = ref(false);
const pendingAddToAlbumImageIds = ref<string[]>([]);

// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);

const handleSelectionChange = (selected: Set<string>) => {
    selectedImages.value = selected;
};

const clearSelection = () => {
    selectedImages.value.clear();
};

const handleImageMenuCommand = async (command: string) => {
    imageMenuVisible.value = false;
    if (!imageMenuImage.value) return;

    switch (command) {
        case "preview":
            previewImage.value = imageMenuImage.value;
            previewPath.value = imageMenuImage.value.localPath;
            previewUrl.value = imageSrcMap.value[imageMenuImage.value.id]?.original || "";
            showPreview.value = true;
            break;
        case "detail":
            selectedDetailImage.value = imageMenuImage.value;
            showImageDetail.value = true;
            break;
        case "open":
            try {
                await invoke("open_file_path", { filePath: imageMenuImage.value.localPath });
            } catch (error) {
                console.error("打开文件失败:", error);
                ElMessage.error("打开文件失败");
            }
            break;
        case "remove":
            // 显示移除对话框，让用户选择是否删除文件
            const imagesToProcess = selectedImages.value.size > 1
                ? images.value.filter((img) => selectedImages.value.has(img.id))
                : [imageMenuImage.value];
            pendingRemoveImages.value = imagesToProcess;
            const count = imagesToProcess.length;
            removeDialogMessage.value = `将删除${count > 1 ? `这 ${count} 张图片` : "这张图片"}。`;
            removeDeleteFiles.value = false; // 默认不删除文件
            showRemoveDialog.value = true;
            break;
        case "favorite":
            // 批量收藏：将选中的图片添加到收藏画册
            try {
                const imagesToFavorite = selectedImages.value.size > 1
                    ? images.value.filter((img) => selectedImages.value.has(img.id))
                    : [imageMenuImage.value];
                const imageIds = imagesToFavorite.map((img) => img.id);
                
                // 获取收藏画册ID
                await albumStore.loadAlbums();
                const favoriteAlbumId = FAVORITE_ALBUM_ID.value;
                
                if (!favoriteAlbumId) {
                    ElMessage.error("收藏画册不存在");
                    return;
                }
                
                // 添加到收藏画册
                await albumStore.addImagesToAlbum(favoriteAlbumId, imageIds);
                
                // 更新本地图片的 favorite 字段
                images.value = images.value.map((img) => {
                    if (imageIds.includes(img.id)) {
                        return { ...img, favorite: true } as ImageInfo;
                    }
                    return img;
                });
                
                const count = imageIds.length;
                ElMessage.success(count > 1 ? `已收藏 ${count} 张图片` : "已收藏");
            } catch (error: any) {
                console.error("收藏失败:", error);
                const errorMessage = error?.message || String(error);
                ElMessage.error(errorMessage || "收藏失败");
            }
            break;
        case "addToAlbum":
            // 仅当多选时右键多选的其中一个时才能批量操作
            const isMultiSelect = selectedImages.value.size > 1;
            if (isMultiSelect && !selectedImages.value.has(imageMenuImage.value.id)) {
                ElMessage.warning("请右键点击已选中的图片");
                return;
            }
            
            const imagesToAdd = isMultiSelect
                ? images.value.filter((img) => selectedImages.value.has(img.id))
                : [imageMenuImage.value];
            pendingAddToAlbumImageIds.value = imagesToAdd.map((img) => img.id);
            showAddToAlbumDialog.value = true;
            break;
    }
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
        for (const id of ids) {
            const data = imageSrcMap.value[id];
            if (data?.thumbnail) URL.revokeObjectURL(data.thumbnail);
            if (data?.original) URL.revokeObjectURL(data.original);
            const { [id]: _, ...rest } = imageSrcMap.value;
            imageSrcMap.value = rest;
        }
        clearSelection();

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
    await loadSettings();
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

    // 监听图片添加事件（来自爬虫下载完成）
    if (!unlistenImageAdded) {
        unlistenImageAdded = await listen<{ taskId: string; imageId: string; image?: any }>(
            "image-added",
            async (event) => {
                // 如果事件中的 taskId 与当前任务ID匹配，则添加新图片到列表
                if (event.payload.taskId && event.payload.taskId === taskId.value && event.payload.imageId) {
                    const imageId = event.payload.imageId;

                    // 检查图片是否已经在列表中（避免重复添加）
                    if (images.value.some(img => img.id === imageId)) {
                        return;
                    }

                    try {
                        // 获取新图片的详细信息
                        const newImage = await invoke<ImageInfo | null>("get_image_by_id", { imageId });
                        if (!newImage) {
                            return;
                        }

                        // 检查图片是否属于当前任务（通过获取任务图片ID列表）
                        const taskImageIds = await invoke<string[]>("get_task_image_ids", { taskId: taskId.value });
                        if (!taskImageIds.includes(imageId)) {
                            return;
                        }

                        // 生成图片的 blob URL
                        const thumbnailUrl = newImage.thumbnailPath ? await getImageUrl(newImage.thumbnailPath) : "";
                        const originalUrl = await getImageUrl(newImage.localPath);

                        // 添加到列表和映射中
                        images.value.push(newImage);
                        imageSrcMap.value[imageId] = { thumbnail: thumbnailUrl, original: originalUrl };
                    } catch (error) {
                        console.error("添加新图片到任务失败:", error);
                    }
                }
            }
        );
    }

    // 监听任务进度更新事件，当任务状态变化时重新加载任务信息
    if (!unlistenTaskProgress) {
        unlistenTaskProgress = await listen<{ taskId: string; progress: number }>(
            "task-progress",
            async (event) => {
                if (event.payload.taskId === taskId.value) {
                    // 重新加载任务信息以获取最新的状态和结束时间
                    await loadTaskInfo();
                }
            }
        );
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
    if (unlistenImageAdded) {
        unlistenImageAdded();
        unlistenImageAdded = null;
    }
    if (unlistenTaskProgress) {
        unlistenTaskProgress();
        unlistenTaskProgress = null;
    }
};

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

    // 清理 blob URLs
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.clear();
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
    // 页面失活时只清理定时器（节省资源），但保留事件监听器
    // 这样即使不在 TaskDetail 页面，图片也会继续同步添加到列表
    stopTimers();
});
</script>

<style scoped lang="scss">
.task-detail {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100vh;
    overflow: hidden;

    .detail-body {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding-top: 6px;
        padding-bottom: 6px;

        .image-grid-root {
            overflow: visible;
        }
    }
}
</style>
