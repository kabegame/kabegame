<template>
    <el-dialog v-model="previewVisible" title="图片预览" width="90%" :close-on-click-modal="true"
        class="image-preview-dialog" :show-close="true" :lock-scroll="true" @close="closePreview">
        <div v-if="previewImageUrl" ref="previewContainerRef" class="preview-container"
            @contextmenu.prevent.stop="handlePreviewDialogContextMenu" @mousemove="handlePreviewMouseMoveWithDrag"
            @mouseleave="handlePreviewMouseLeaveAll" @wheel.prevent="handlePreviewWheel" @mouseup="stopPreviewDrag">
            <div class="preview-nav-zone left" :class="{ visible: previewHoverSide === 'left' }" @click.stop="goPrev">
                <button class="preview-nav-btn" type="button" :class="{ disabled: !canGoPrev }" aria-label="上一张">
                    <el-icon>
                        <ArrowLeftBold />
                    </el-icon>
                </button>
            </div>
            <div class="preview-nav-zone right" :class="{ visible: previewHoverSide === 'right' }" @click.stop="goNext">
                <button class="preview-nav-btn" type="button" :class="{ disabled: !canGoNext }" aria-label="下一张">
                    <el-icon>
                        <ArrowRightBold />
                    </el-icon>
                </button>
            </div>
            <img ref="previewImageRef" :src="previewImageUrl" class="preview-image" alt="预览图片"
                :style="previewImageStyle" @load="handlePreviewImageLoad" @mousedown.prevent.stop="startPreviewDrag"
                @dragstart.prevent />
        </div>
    </el-dialog>

    <div class="preview-context-menu-wrapper">
        <component :is="contextMenuComponent" v-if="contextMenuComponent" :visible="previewContextMenuVisible"
            :position="previewContextMenuPosition" :image="previewImage" :selected-count="1"
            :selected-image-ids="previewImage ? new Set([previewImage.id]) : new Set()" @close="closePreviewContextMenu"
            @command="handlePreviewContextMenuCommand" />
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { ElMessage } from "element-plus";
import { ArrowLeftBold, ArrowRightBold } from "@element-plus/icons-vue";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ImageInfo } from "@/stores/crawler";

const props = defineProps<{
    images: ImageInfo[];
    imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
    contextMenuComponent?: Component;
}>();

const emit = defineEmits<{
    (e: "contextCommand", payload: { command: string; image: ImageInfo }): void;
}>();

const previewVisible = ref(false);
const previewImageUrl = ref("");
const previewImagePath = ref("");
const previewImage = ref<ImageInfo | null>(null);
const previewIndex = ref<number>(-1);
const previewHoverSide = ref<"left" | "right" | null>(null);

const previewContainerRef = ref<HTMLElement | null>(null);
const previewImageRef = ref<HTMLImageElement | null>(null);
const previewScale = ref(1);
const previewTranslateX = ref(0);
const previewTranslateY = ref(0);
const previewBaseSize = ref({ width: 0, height: 0 });
const previewContainerSize = ref({ width: 0, height: 0 });
const previewAvailableSize = ref({ width: 0, height: 0 });
const previewDragging = ref(false);
const previewDragStart = ref({ x: 0, y: 0 });
const previewDragStartTranslate = ref({ x: 0, y: 0 });
const previewImageLoading = ref(false);

const previewContextMenuVisible = ref(false);
const previewContextMenuPosition = ref({ x: 0, y: 0 });

const clamp = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

const clampTranslate = (nextScale: number, nextX: number, nextY: number) => {
    const available = previewAvailableSize.value;
    const base = previewBaseSize.value;
    if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
        const scaledWidth = base.width * nextScale;
        const scaledHeight = base.height * nextScale;
        if (scaledWidth <= available.width && scaledHeight <= available.height) {
            return { x: 0, y: 0 };
        }
        const maxOffsetX = Math.max(0, (scaledWidth - available.width) / 2);
        const maxOffsetY = Math.max(0, (scaledHeight - available.height) / 2);
        return {
            x: clamp(nextX, -maxOffsetX, maxOffsetX),
            y: clamp(nextY, -maxOffsetY, maxOffsetY),
        };
    }
    return { x: nextX, y: nextY };
};

const setPreviewTransform = (nextScale: number, nextX: number, nextY: number) => {
    const clampedScale = clamp(nextScale, 1, 10);
    const { x, y } = clampTranslate(clampedScale, nextX, nextY);
    previewScale.value = clampedScale;
    previewTranslateX.value = x;
    previewTranslateY.value = y;
};

const measureContainerSize = () => {
    const containerRect = previewContainerRef.value?.getBoundingClientRect();
    if (containerRect) {
        previewContainerSize.value = { width: containerRect.width, height: containerRect.height };
        previewAvailableSize.value = {
            width: containerRect.width,
            height: containerRect.height,
        };
    }
};

const measureBaseSize = () => {
    const imageRect = previewImageRef.value?.getBoundingClientRect();
    if (imageRect && previewScale.value === 1) {
        previewBaseSize.value = { width: imageRect.width, height: imageRect.height };
    }
};

const measureSizesAfterRender = async () => {
    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    measureContainerSize();
    measureBaseSize();
};

const resetPreviewTransform = async () => {
    setPreviewTransform(1, 0, 0);
    await measureSizesAfterRender();
};

const previewImageStyle = computed(() => ({
    transform: `translate(${previewTranslateX.value}px, ${previewTranslateY.value}px) scale(${previewScale.value})`,
    transition: previewDragging.value ? "none" : "transform 0.08s ease-out",
    cursor: previewScale.value > 1 ? (previewDragging.value ? "grabbing" : "grab") : "default",
    "transform-origin": "center center",
    opacity: previewImageLoading.value ? 0 : 1,
}));

const isTextInputLike = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

const setPreviewByIndex = (index: number) => {
    const img = props.images[index];
    if (!img) return;
    const imageData = props.imageUrlMap[img.id];
    const originalUrl = imageData?.original;
    const thumbnailUrl = imageData?.thumbnail;
    const imageUrl = originalUrl || thumbnailUrl;
    if (!imageUrl) return;

    previewImageLoading.value = true;
    previewIndex.value = index;
    previewImageUrl.value = imageUrl;
    previewImagePath.value = img.localPath;
    previewImage.value = img;
    resetPreviewTransform();

    if (!originalUrl && thumbnailUrl && img.localPath) {
        loadOriginalForPreview(img);
    }
};

const canGoPrev = computed(() => {
    if (props.images.length <= 1) return false;
    return true;
});

const canGoNext = computed(() => {
    if (props.images.length <= 1) return false;
    return true;
});

const goPrev = () => {
    if (!previewVisible.value) return;
    if (props.images.length <= 1) {
        ElMessage.info("没有上一张");
        return;
    }
    if (previewIndex.value > 0) {
        setPreviewByIndex(previewIndex.value - 1);
        return;
    }
    setPreviewByIndex(props.images.length - 1);
};

const goNext = () => {
    if (!previewVisible.value) return;
    if (props.images.length <= 1) {
        ElMessage.info("没有下一张");
        return;
    }
    const lastIndex = props.images.length - 1;
    if (previewIndex.value >= 0 && previewIndex.value < lastIndex) {
        setPreviewByIndex(previewIndex.value + 1);
        return;
    }
    if (props.images.length > 0) {
        setPreviewByIndex(0);
        ElMessage.info("已回到第一张");
    }
};

const handlePreviewDialogContextMenu = (event: MouseEvent) => {
    if (!previewImage.value) return;
    previewContextMenuPosition.value = { x: event.clientX, y: event.clientY };
    previewContextMenuVisible.value = true;
};

const closePreviewContextMenu = () => {
    previewContextMenuVisible.value = false;
};

const handlePreviewContextMenuCommand = (command: string) => {
    if (!previewImage.value) return;
    const payload = {
        command,
        image: previewImage.value,
    };
    closePreviewContextMenu();
    emit("contextCommand", payload);
};

const handlePreviewMouseMove = (event: MouseEvent) => {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = rect.width || 0;
    if (w <= 0) return;
    const edge = w * 0.2;
    if (x <= edge) previewHoverSide.value = "left";
    else if (x >= w - edge) previewHoverSide.value = "right";
    else previewHoverSide.value = null;
};

const handlePreviewMouseLeave = () => {
    previewHoverSide.value = null;
};

const handlePreviewMouseMoveWithDrag = (event: MouseEvent) => {
    handlePreviewMouseMove(event);
    handlePreviewDragMove(event);
};

const handlePreviewMouseLeaveAll = () => {
    handlePreviewMouseLeave();
};

const handlePreviewWheel = (event: WheelEvent) => {
    if (!previewVisible.value) return;
    event.preventDefault();
    const container = previewContainerRef.value;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    previewContainerSize.value = { width: containerRect.width, height: containerRect.height };
    previewAvailableSize.value = {
        width: containerRect.width,
        height: containerRect.height,
    };

    const prevScale = previewScale.value;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const nextScale = clamp(prevScale * factor, 1, 10);
    if (nextScale === prevScale) return;

    const centerX = containerRect.left + containerRect.width / 2;
    const centerY = containerRect.top + containerRect.height / 2;
    const pointerX = event.clientX - centerX;
    const pointerY = event.clientY - centerY;
    const scaleRatio = nextScale / prevScale;

    const nextX = pointerX - scaleRatio * (pointerX - previewTranslateX.value);
    const nextY = pointerY - scaleRatio * (pointerY - previewTranslateY.value);
    setPreviewTransform(nextScale, nextX, nextY);
};

const startPreviewDrag = (event: MouseEvent) => {
    if (!previewVisible.value) return;
    if (previewScale.value <= 1) return;
    if (event.button !== 0 && event.button !== 1) return;
    measureContainerSize();
    previewDragging.value = true;
    previewDragStart.value = { x: event.clientX, y: event.clientY };
    previewDragStartTranslate.value = { x: previewTranslateX.value, y: previewTranslateY.value };
};

const handlePreviewDragMove = (event: MouseEvent) => {
    if (!previewDragging.value) return;
    const dx = event.clientX - previewDragStart.value.x;
    const dy = event.clientY - previewDragStart.value.y;
    setPreviewTransform(previewScale.value, previewDragStartTranslate.value.x + dx, previewDragStartTranslate.value.y + dy);
};

const stopPreviewDrag = () => {
    previewDragging.value = false;
};

const handlePreviewImageLoad = async () => {
    await measureSizesAfterRender();
    if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
        const container = previewAvailableSize.value;
        const base = previewBaseSize.value;
        if (base.width <= container.width && base.height <= container.height) {
            setPreviewTransform(1, 0, 0);
        }
        prevAvailableSize.value = { ...previewAvailableSize.value };
    }
    previewImageLoading.value = false;
};

const handlePreviewKeyDown = (event: KeyboardEvent) => {
    if (!previewVisible.value) return;
    if (isTextInputLike(event.target)) return;
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
        return;
    }
    if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
        return;
    }
};

const closePreview = () => {
    previewVisible.value = false;
    previewImageUrl.value = "";
    previewImagePath.value = "";
    previewImage.value = null;
    previewIndex.value = -1;
    previewHoverSide.value = null;
    closePreviewContextMenu();
};

const handlePreviewImageDeleted = () => {
    if (!previewVisible.value) return;
    if (props.images.length === 0) {
        closePreview();
        return;
    }
    if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
        setPreviewByIndex(previewIndex.value);
    } else if (previewIndex.value >= props.images.length) {
        setPreviewByIndex(props.images.length - 1);
    } else {
        setPreviewByIndex(0);
    }
};

watch(
    () => props.images,
    () => {
        if (!previewVisible.value || !previewImage.value) return;
        const stillExists = props.images.some((img) => img.id === previewImage.value?.id);
        if (!stillExists) {
            handlePreviewImageDeleted();
            return;
        }
        if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
            const currentImage = props.images[previewIndex.value];
            if (currentImage && currentImage.id === previewImage.value.id) {
                previewImage.value = currentImage;
            }
        }
    },
    { deep: true }
);

watch(
    () => props.images.length,
    (_nextLen, _prevLen) => {
        if (!previewVisible.value) return;
        if (previewImage.value) {
            const idx = props.images.findIndex((i) => i.id === previewImage.value?.id);
            if (idx !== -1) {
                previewIndex.value = idx;
            } else {
                handlePreviewImageDeleted();
            }
        }
    }
);

watch(
    () => previewVisible.value,
    async (visible) => {
        if (visible) {
            await nextTick();
            await measureSizesAfterRender();
            prevAvailableSize.value = { ...previewAvailableSize.value };
        } else {
            stopPreviewDrag();
            prevAvailableSize.value = { width: 0, height: 0 };
        }
    }
);

watch(
    () => previewImageUrl.value,
    (url) => {
        if (url) {
            setPreviewTransform(1, 0, 0);
        }
    }
);

let resizeObserver: ResizeObserver | null = null;
const prevAvailableSize = ref({ width: 0, height: 0 });

const setupResizeObserver = () => {
    if (resizeObserver) {
        resizeObserver.disconnect();
    }
    const container = previewContainerRef.value;
    if (!container) return;
    resizeObserver = new ResizeObserver(() => {
        if (!previewVisible.value) return;
        const prevAvailable = { ...prevAvailableSize.value };
        measureContainerSize();
        prevAvailableSize.value = { ...previewAvailableSize.value };
        if (previewScale.value === 1) {
            measureBaseSize();
            if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
                const containerSize = previewAvailableSize.value;
                const base = previewBaseSize.value;
                if (base.width <= containerSize.width && base.height <= containerSize.height) {
                    setPreviewTransform(1, 0, 0);
                }
            }
        } else {
            const currentScale = previewScale.value;
            const currentX = previewTranslateX.value;
            const currentY = previewTranslateY.value;
            const available = previewAvailableSize.value;
            const base = previewBaseSize.value;
            if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
                const scaledWidth = base.width * currentScale;
                const scaledHeight = base.height * currentScale;
                if (scaledWidth <= available.width && scaledHeight <= available.height) {
                    setPreviewTransform(1, 0, 0);
                    nextTick(() => {
                        measureBaseSize();
                    });
                } else {
                    if (prevAvailable.width <= 0 || prevAvailable.height <= 0) {
                        setPreviewTransform(currentScale, currentX, currentY);
                    } else {
                        const prevMaxOffsetX = Math.max(0, (scaledWidth - prevAvailable.width) / 2);
                        const prevMaxOffsetY = Math.max(0, (scaledHeight - prevAvailable.height) / 2);
                        const newMaxOffsetX = Math.max(0, (scaledWidth - available.width) / 2);
                        const newMaxOffsetY = Math.max(0, (scaledHeight - available.height) / 2);
                        let relativeX = 0;
                        let relativeY = 0;
                        if (prevMaxOffsetX > 0) {
                            relativeX = currentX / prevMaxOffsetX;
                        }
                        if (prevMaxOffsetY > 0) {
                            relativeY = currentY / prevMaxOffsetY;
                        }
                        const newX = newMaxOffsetX > 0 ? relativeX * newMaxOffsetX : 0;
                        const newY = newMaxOffsetY > 0 ? relativeY * newMaxOffsetY : 0;
                        setPreviewTransform(currentScale, newX, newY);
                    }
                }
            } else {
                setPreviewTransform(1, 0, 0);
                nextTick(() => {
                    measureBaseSize();
                });
            }
        }
    });
    resizeObserver.observe(container);
};

onMounted(() => {
    window.addEventListener("mouseup", stopPreviewDrag);
    window.addEventListener("mousemove", handlePreviewDragMove);
    window.addEventListener("keydown", handlePreviewKeyDown);
});

onUnmounted(() => {
    window.removeEventListener("mouseup", stopPreviewDrag);
    window.removeEventListener("mousemove", handlePreviewDragMove);
    window.removeEventListener("keydown", handlePreviewKeyDown);
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
});

watch(
    () => previewContainerRef.value,
    (container) => {
        if (container) {
            setupResizeObserver();
        } else if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    },
    { immediate: true }
);

async function loadOriginalForPreview(image: ImageInfo) {
    if (!image.localPath) return;
    try {
        let normalizedPath = image.localPath.trimStart().replace(/^\\\\\?\\/, "").trim();
        if (!normalizedPath) return;
        const fileData = await readFile(normalizedPath);
        if (!fileData || fileData.length === 0) return;
        const ext = normalizedPath.split(".").pop()?.toLowerCase();
        let mimeType = "image/jpeg";
        if (ext === "png") mimeType = "image/png";
        else if (ext === "gif") mimeType = "image/gif";
        else if (ext === "webp") mimeType = "image/webp";
        else if (ext === "bmp") mimeType = "image/bmp";
        const blob = new Blob([fileData], { type: mimeType });
        if (blob.size === 0) return;
        const blobUrl = URL.createObjectURL(blob);
        if (previewImage.value?.id === image.id && previewVisible.value) {
            previewImageLoading.value = true;
            previewImageUrl.value = blobUrl;
        }
    } catch (error) {
        console.error("Failed to load original image for preview:", error, image);
    }
}

const open = (index: number) => {
    setPreviewByIndex(index);
    previewVisible.value = true;
};

defineExpose({
    open,
    close: closePreview,
});
</script>

<style lang="scss">
.image-preview-dialog.el-dialog {
    width: 90vw !important;
    height: 90vh !important;
    margin: 5vh auto !important;
    display: flex !important;
    flex-direction: column !important;
    overflow: hidden !important;

    .el-dialog__header {
        flex-shrink: 0 !important;
        padding: 15px 20px !important;
        height: 50px !important;
        box-sizing: border-box !important;
    }

    .el-dialog__body {
        flex: 1 1 auto !important;
        padding: 0 !important;
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        overflow: hidden !important;
        min-height: 0 !important;
        height: calc(90vh - 50px) !important;
    }

    .preview-container {
        width: 100%;
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
        box-sizing: border-box;
        position: relative;
    }

    .preview-image {
        max-width: calc(90vw - 40px) !important;
        max-height: calc(90vh - 70px) !important;
        width: auto;
        height: auto;
        object-fit: contain;
        display: block;
        cursor: pointer;
    }

    .preview-nav-zone {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 20%;
        display: flex;
        align-items: center;
        z-index: 2;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.12s ease;

        &.visible {
            opacity: 1;
            pointer-events: auto;
        }

        &.left {
            left: 0;
            justify-content: flex-start;
            padding-left: 18px;
        }

        &.right {
            right: 0;
            justify-content: flex-end;
            padding-right: 18px;
        }
    }

    .preview-nav-btn {
        width: 44px;
        height: 44px;
        border-radius: 999px;
        border: none;
        background: #ff5fb8;
        color: #ffffff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 10px 24px rgba(255, 95, 184, 0.28);
        transition: transform 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
        user-select: none;

        &:hover {
            transform: scale(1.04);
            box-shadow: 0 12px 28px rgba(255, 95, 184, 0.34);
        }

        &.disabled {
            background: #c9c9c9;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
        }

        .el-icon {
            font-size: 18px;
        }
    }
}

.preview-context-menu-wrapper {
    position: relative;
    z-index: 10000;
}
</style>
