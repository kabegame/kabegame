<template>
  <div class="image-item"
    :class="{ 'image-item-selected': selected, 'reorder-mode': isReorderMode, 'reorder-selected': reorderSelected }"
    ref="itemRef" :data-id="image.id" @contextmenu.prevent="$emit('contextmenu', $event)" @mousedown="handleMouseDown"
    @mouseup="handleMouseUp" @mouseleave="handleMouseLeave">
    <!-- 本地文件缺失标识：不阻挡点击/选择/右键 -->
    <el-tooltip v-if="image.localExists === false" content="原图找不到了捏" placement="top" :show-after="300">
      <div class="missing-file-badge">
        <el-icon :size="14">
          <WarningFilled />
        </el-icon>
      </div>
    </el-tooltip>
    <transition name="fade-in" mode="out-in">
      <div v-if="!attemptUrl" key="loading" class="thumbnail-loading" :style="aspectRatioStyle">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>
      <div v-else key="content"
        :class="[imageClickAction === 'preview' && originalUrl ? 'image-preview-wrapper' : 'image-wrapper']"
        :style="aspectRatioStyle" @dblclick.stop="$emit('dblclick', $event)"
        @contextmenu.prevent.stop="$emit('contextmenu', $event)" @click.stop="handleWrapperClick">
        <img :src="attemptUrl" :class="['thumbnail', { 'thumbnail-loading': isImageLoading }]" :alt="image.id"
          loading="lazy" draggable="false" @load="handleImageLoad" @error="handleImageError" />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import { readFile } from "@tauri-apps/plugin-fs";
import { WarningFilled } from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import type { ImageClickAction } from "../../stores/settings";

interface Props {
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
  imageClickAction: ImageClickAction;
  useOriginal?: boolean; // 是否使用原图（当列数 <= 2 时）
  windowAspectRatio?: number; // 窗口宽高比
  selected?: boolean; // 是否被选中
  gridColumns?: number; // 网格列数
  gridIndex?: number; // 在网格中的索引
  isReorderMode?: boolean; // 是否处于调整模式
  reorderSelected?: boolean; // 在调整模式下是否被选中（用于交换）
}

const props = defineProps<Props>();

const emit = defineEmits<{
  click: [event?: MouseEvent];
  dblclick: [event?: MouseEvent];
  contextmenu: [event: MouseEvent];
  longPress: []; // 长按事件
  reorderClick: []; // 调整模式下的点击事件
  blobUrlInvalid: [
    payload: {
      oldUrl: string;
      newUrl: string;
      newBlob?: Blob;
      imageId: string;
      localPath: string;
    }
  ]; // Blob URL 无效事件（已在本地重建 newUrl，用于上层同步/缓存）
}>();

const thumbnailUrl = computed(() => props.imageUrl?.thumbnail);
const originalUrl = computed(() => props.imageUrl?.original);
// 根据 useOriginal 决定使用缩略图还是原图
const computedDisplayUrl = computed(() => {
  if (props.useOriginal && originalUrl.value) {
    return originalUrl.value;
  }
  return thumbnailUrl.value || originalUrl.value || "";
});

// 当前尝试加载的 URL（永远不为 "" 才会渲染 <img>，避免出现破裂图）
const attemptUrl = ref<string>("");
// 错误处理防抖：避免同一 URL 的 error 事件造成死循环
const handledErrorForUrl = ref<string | null>(null);

// 通过读取文件重新创建 Blob URL（返回 url + blob，用于上层持有引用，避免被 GC 后 URL 失效）
async function recreateBlobUrl(
  localPath: string
): Promise<{ url: string; blob: Blob | null }> {
  if (!localPath) return { url: "", blob: null };
  try {
    let normalizedPath = localPath.trimStart().replace(/^\\\\\?\\/, "").trim();
    if (!normalizedPath) return { url: "", blob: null };

    const fileData = await readFile(normalizedPath);
    if (!fileData || fileData.length === 0) return { url: "", blob: null };

    const ext = normalizedPath.split(".").pop()?.toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    else if (ext === "gif") mimeType = "image/gif";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "bmp") mimeType = "image/bmp";

    const blob = new Blob([fileData], { type: mimeType });
    if (blob.size === 0) return { url: "", blob: null };

    const blobUrl = URL.createObjectURL(blob);
    return { url: blobUrl, blob };
  } catch (error) {
    console.error("重新创建 Blob URL 失败:", error, localPath);
    return { url: "", blob: null };
  }
}

const itemRef = ref<HTMLElement | null>(null);
const isImageLoading = ref(true); // 跟踪图片是否正在加载（用于隐藏 <img>，防止破裂图闪现）

onMounted(() => {
  attemptUrl.value = computedDisplayUrl.value || "";
  isImageLoading.value = !!attemptUrl.value;
});

onUnmounted(() => { });

const aspectRatioStyle = computed(() => {
  // aspect-ratio = 宽 / 高；windowAspectRatio 本身就是宽/高
  const r = props.windowAspectRatio && props.windowAspectRatio > 0 ? props.windowAspectRatio : null;
  return r
    ? { aspectRatio: `${r}` }
    : { aspectRatio: "16 / 9" };
});

// 监听 computedDisplayUrl 变化：只有在 URL 字符串确实变化时才触发重载，避免无意义闪烁
let previousUrl = computedDisplayUrl.value;
watch(
  () => computedDisplayUrl.value,
  (newUrl) => {
    if (newUrl === previousUrl) return;
    previousUrl = newUrl;
    handledErrorForUrl.value = null;
    attemptUrl.value = newUrl || "";
    isImageLoading.value = !!attemptUrl.value;
  }
);

function handleImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.complete && img.naturalHeight !== 0) {
    isImageLoading.value = false;
    handledErrorForUrl.value = null;
  }
}

async function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement;
  const currentUrl = attemptUrl.value || img.src || "";
  if (!currentUrl) return;

  if (handledErrorForUrl.value === currentUrl) return;
  handledErrorForUrl.value = currentUrl;

  isImageLoading.value = true;

  const thumbUrl = thumbnailUrl.value;
  const origUrl = originalUrl.value;

  // 1) 当前是缩略图失败，且存在原图：尝试切换到原图 URL
  if (thumbUrl && origUrl && currentUrl === thumbUrl && origUrl !== thumbUrl) {
    attemptUrl.value = origUrl;
    return;
  }

  // 2) 尝试从本地文件重建 blob url（缩略图优先；没有则用原图）
  const pathToUse = props.useOriginal
    ? props.image.localPath
    : (props.image.thumbnailPath || props.image.localPath);

  const rebuilt = await recreateBlobUrl(pathToUse);
  if (rebuilt?.url) {
    attemptUrl.value = rebuilt.url;
    emit("blobUrlInvalid", {
      oldUrl: currentUrl,
      newUrl: rebuilt.url,
      newBlob: rebuilt.blob ?? undefined,
      imageId: props.image.id,
      localPath: pathToUse,
    });
    return;
  }

  attemptUrl.value = "";
}

// 长按检测
const longPressTimer = ref<number | null>(null);
const isLongPressing = ref(false);
const LONG_PRESS_DURATION = 500; // 500ms 长按时间

const handleMouseDown = (event: MouseEvent) => {
  if (props.isReorderMode) return;
  if (event.button !== 0) return;

  isLongPressing.value = true;
  longPressTimer.value = window.setTimeout(() => {
    if (isLongPressing.value) {
      emit("longPress");
      isLongPressing.value = false;
    }
  }, LONG_PRESS_DURATION);
};

const handleMouseUp = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
  isLongPressing.value = false;
};

const handleMouseLeave = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
  isLongPressing.value = false;
};

const handleWrapperClick = (event?: MouseEvent) => {
  if (props.isReorderMode) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    emit("reorderClick");
    return;
  }
  emit("click", event);
};
</script>

<style scoped lang="scss">
.image-item {
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease, border-color 0.25s ease;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
  box-sizing: border-box;
  will-change: transform, box-shadow;

  &:hover {
    transform: translateY(-6px) scale(1.015);
    box-shadow: var(--anime-shadow-hover);
    outline: 3px solid var(--anime-primary-light);
    outline-offset: -2px;
  }

  &.image-item-selected {
    border-color: #ff6b9d;
    border-width: 2px;
    box-shadow:
      0 0 0 3px rgba(255, 107, 157, 0.4),
      0 0 20px rgba(255, 107, 157, 0.5),
      0 4px 12px rgba(255, 107, 157, 0.3);
    outline: 4px solid #ff6b9d;
    outline-offset: -2px;

    &:hover {
      border-color: #ff4d8a;
      outline: 5px solid #ff4d8a;
      outline-offset: -2px;
      box-shadow:
        0 0 0 3px rgba(255, 77, 138, 0.5),
        0 0 30px rgba(255, 107, 157, 0.6),
        0 6px 16px rgba(255, 107, 157, 0.4);
    }
  }

  .image-wrapper,
  .image-preview-wrapper {
    width: 100%;
    position: relative;
    cursor: pointer;
    overflow: hidden;
    border-radius: 14px 14px 0 0;
    will-change: contents;

    &::before {
      content: '';
      display: block;
      width: 100%;
    }
  }

  .thumbnail {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 14px 14px 0 0;
    object-fit: cover;
    will-change: contents, opacity;

    &.thumbnail-loading {
      animation: fadeInImage 0.4s ease-in;
    }
  }

  .thumbnail-loading {
    width: 100%;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;

    >* {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
  }
}

.missing-file-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: help;
  color: #fff;
  background: rgba(245, 108, 108, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  transition: background 0.2s ease;

  &:hover {
    background: rgba(245, 108, 108, 1);
  }
}

.fade-in-enter-active {
  transition: opacity 0.3s ease-in, transform 0.3s ease-out;
}
.fade-in-leave-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-in;
}
.fade-in-enter-from,
.fade-in-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
.fade-in-enter-to,
.fade-in-leave-from {
  opacity: 1;
  transform: scale(1);
}

@keyframes fadeInImage {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>


