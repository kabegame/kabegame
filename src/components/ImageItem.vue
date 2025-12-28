<template>
  <div class="image-item"
    :class="{ 'image-item-selected': selected, 'image-item-dragging': isDragging, 'image-item-drag-over': isDragOver }"
    ref="itemRef" :data-id="image.id" :data-index="dragIndex" :draggable="draggable"
    @contextmenu.prevent="$emit('contextmenu', $event)" @dragstart="handleDragStartForReorder"
    @dragover.prevent="handleDragOver" @drop="handleDrop" @dragend="handleDragEnd" @dragleave="handleDragLeave">
    <transition name="fade-in" mode="out-in">
      <div v-if="!hasImageUrl" key="loading" class="thumbnail-loading" :style="loadingStyle">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>
      <div v-else-if="imageClickAction === 'preview' && originalUrl" key="preview" class="image-preview-wrapper"
        :style="imageHeightStyle" @click.stop="$emit('click', $event)" @dblclick.stop="$emit('dblclick', $event)"
        @contextmenu.prevent.stop="$emit('contextmenu', $event)">
        <img :src="displayUrl" class="thumbnail" :alt="image.id" loading="lazy" :draggable="!draggable"
          @dragstart="handleDragStart" @error="(e: any) => { if (originalUrl) e.target.src = originalUrl; }" />
      </div>
      <div v-else key="open" class="image-wrapper" :style="imageHeightStyle" @click.stop="$emit('click', $event)"
        @dblclick.stop="$emit('dblclick', $event)" @contextmenu.prevent.stop="$emit('contextmenu', $event)">
        <img :src="displayUrl" class="thumbnail" :alt="image.id" loading="lazy" :draggable="!draggable"
          @dragstart="handleDragStart" @error="(e: any) => { if (originalUrl) e.target.src = originalUrl; }" />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
  imageClickAction: "preview" | "open";
  useOriginal?: boolean; // 是否使用原图（当列数 <= 2 时）
  aspectRatioMatchWindow?: boolean; // 图片宽高比是否与窗口相同
  windowAspectRatio?: number; // 窗口宽高比
  selected?: boolean; // 是否被选中
  draggable?: boolean; // 是否可以通过拖动来调整顺序
  dragIndex?: number; // 当前项在列表中的索引（用于拖拽排序）
}

const props = defineProps<Props>();

const emit = defineEmits<{
  click: [event?: MouseEvent];
  dblclick: [event?: MouseEvent];
  contextmenu: [event: MouseEvent];
  dragstart: [event: DragEvent, index: number];
  dragover: [event: DragEvent, index: number];
  drop: [event: DragEvent, index: number];
  dragend: [event: DragEvent];
}>();

const thumbnailUrl = computed(() => props.imageUrl?.thumbnail);
const originalUrl = computed(() => props.imageUrl?.original);
// 检查是否有可用的图片 URL（thumbnail 或 original）
const hasImageUrl = computed(() => {
  return !!(props.imageUrl?.thumbnail || props.imageUrl?.original);
});
// 根据 useOriginal 决定使用缩略图还是原图
const displayUrl = computed(() => {
  if (props.useOriginal && originalUrl.value) {
    return originalUrl.value;
  }
  return thumbnailUrl.value || originalUrl.value || '';
});

const itemRef = ref<HTMLElement | null>(null);
const itemWidth = ref<number>(0);
const isDragging = ref(false);
const isDragOver = ref(false);

// 使用 ResizeObserver 监听元素宽度变化
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (itemRef.value) {
    // 初始化宽度
    itemWidth.value = itemRef.value.offsetWidth;

    // 创建 ResizeObserver 监听宽度变化
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === itemRef.value) {
          itemWidth.value = entry.contentRect.width;
        }
      }
    });

    resizeObserver.observe(itemRef.value);
  }
});

onUnmounted(() => {
  if (resizeObserver && itemRef.value) {
    resizeObserver.unobserve(itemRef.value);
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

// 计算图片容器的高度样式
const imageHeightStyle = computed(() => {
  if (props.aspectRatioMatchWindow && props.windowAspectRatio && itemWidth.value > 0) {
    // 如果启用宽高比匹配，根据实际宽度和窗口宽高比计算高度
    // 高度 = 宽度 / 窗口宽高比
    const height = itemWidth.value / props.windowAspectRatio;
    return {
      height: `${height}px`
    };
  }
  // 默认高度 200px
  return {
    height: '200px'
  };
});

// 加载骨架屏的样式
const loadingStyle = computed(() => {
  if (props.aspectRatioMatchWindow && props.windowAspectRatio && itemWidth.value > 0) {
    const height = itemWidth.value / props.windowAspectRatio;
    return {
      height: `${height}px`
    };
  }
  return {
    height: '200px'
  };
});

// 监听窗口宽高比变化，重新计算高度
watch(() => props.windowAspectRatio, () => {
  // 触发重新计算
  if (itemRef.value) {
    itemWidth.value = itemRef.value.offsetWidth;
  }
});

// 处理拖拽排序
function handleDragStartForReorder(event: DragEvent) {
  if (!props.draggable || props.dragIndex === undefined) return;

  isDragging.value = true;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", props.image.id);
    // 设置拖拽预览
    if (itemRef.value) {
      event.dataTransfer.setDragImage(itemRef.value, 0, 0);
    }
  }
  emit("dragstart", event, props.dragIndex);
}

function handleDragOver(event: DragEvent) {
  if (!props.draggable || props.dragIndex === undefined) return;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  isDragOver.value = true;
  emit("dragover", event, props.dragIndex);
}

function handleDrop(event: DragEvent) {
  if (!props.draggable || props.dragIndex === undefined) return;
  isDragOver.value = false;
  emit("drop", event, props.dragIndex);
}

function handleDragEnd(event: DragEvent) {
  isDragging.value = false;
  isDragOver.value = false;
  emit("dragend", event);
}

function handleDragLeave() {
  isDragOver.value = false;
}

// 处理拖拽，传递原图路径给目标应用（当 draggable 为 false 时使用）
function handleDragStart(event: DragEvent) {
  // 如果启用了拖拽排序，则不允许文件拖拽
  if (props.draggable) {
    event.preventDefault();
    return;
  }
  if (!event.dataTransfer) return;

  const originalPath = props.image.localPath || props.image.thumbnailPath;
  if (!originalPath) return;

  // 移除 Windows 长路径前缀 \\?\（如果存在）
  const normalizedPath = originalPath.trimStart().replace(/^\\\\\?\\/, "");

  // 构造 file:// URL
  const fileUrl = normalizedPath.match(/^[A-Za-z]:/)
    ? `file:///${normalizedPath.replace(/\\/g, "/")}`
    : `file://${normalizedPath}`;

  // 文件名用于 DownloadURL
  const fileName = normalizedPath.split(/[/\\]/).pop() || "image.jpg";
  const mimeGuess = "image/jpeg";

  // 覆盖默认拖拽数据
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.clearData();
  if (event.dataTransfer.items) {
    while (event.dataTransfer.items.length > 0) {
      event.dataTransfer.items.remove(0);
    }
  }

  event.dataTransfer.setData("text/plain", normalizedPath);
  event.dataTransfer.setData("text/uri-list", fileUrl);
  // Chrome/Edge 识别的 DownloadURL 语法: <mime>:<filename>:<url>
  try {
    event.dataTransfer.setData("DownloadURL", `${mimeGuess}:${fileName}:${fileUrl}`);
  } catch {
    // 忽略
  }
  try {
    event.dataTransfer.setData("application/x-moz-file", normalizedPath);
  } catch {
    // 忽略兼容性错误
  }

  // 使用缩略图作为拖拽预览，不影响传出的原图路径
  if (displayUrl.value) {
    const img = new Image();
    img.src = displayUrl.value;
    const setDragImg = () => event.dataTransfer?.setDragImage(img, 0, 0);
    if (img.complete) {
      setDragImg();
    } else {
      img.onload = setDragImg;
      img.onerror = () => {
        const empty = new Image();
        empty.src =
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        event.dataTransfer?.setDragImage(empty, 0, 0);
      };
    }
  }

  // 同步调用原生命令，将文件写入系统剪贴板（部分应用如微信可粘贴）
  // 说明：拖拽数据仍然提供路径；若目标应用只接受原生文件拖放，可提示用户尝试 Ctrl+V 粘贴。
  invoke("copy_files_to_clipboard", { paths: [normalizedPath] }).catch(() => {
    /* 忽略失败 */
  });
}
</script>

<style scoped lang="scss">
.image-item {
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
  box-sizing: border-box;

  &:hover {
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

  &.image-item-dragging {
    opacity: 0.5;
    cursor: grabbing;
  }

  &.image-item-drag-over {
    border-color: var(--anime-primary);
    border-width: 3px;
    box-shadow: 0 0 0 3px rgba(255, 107, 157, 0.3);
  }

  .image-wrapper {
    width: 100%;
    position: relative;
    cursor: pointer;
    overflow: hidden;
    border-radius: 14px 14px 0 0;

    &::before {
      content: '';
      display: block;
      width: 100%;
    }
  }

  .image-preview-wrapper {
    width: 100%;
    position: relative;
    cursor: pointer;
    overflow: hidden;
    border-radius: 14px 14px 0 0;

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
    animation: fadeInImage 0.4s ease-in;
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

/* 淡入动画 */
.fade-in-enter-active {
  transition: opacity 0.3s ease-in, transform 0.3s ease-out;
}

.fade-in-leave-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-in;
}

.fade-in-enter-from {
  opacity: 0;
  transform: scale(0.95);
}

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
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}
</style>
