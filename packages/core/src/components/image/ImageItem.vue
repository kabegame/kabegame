<template>
  <div ref="rootEl" class="image-item" :class="{
    'image-item-selected': selected,
    'reorder-mode': isReorderMode,
    'reorder-selected': reorderSelected,
    'item-entering': isEntering,
    'item-leaving': isLeaving,
  }" :data-id="image.id" @contextmenu.prevent="$emit('contextmenu', $event)" @mousedown="handleMouseDown"
    @mouseup="handleMouseUp" @mouseleave="handleMouseLeave" @animationend="handleAnimationEnd">
    <!-- 任务失败图片：下载重试（不阻挡点击/选择/右键） -->
    <el-tooltip v-if="image.isTaskFailed" content="重新下载" placement="top" :show-after="300">
      <div class="retry-download-badge" @click.stop="$emit('retryDownload')">
        <el-icon :size="14">
          <Download />
        </el-icon>
      </div>
    </el-tooltip>
    <!-- 本地文件缺失标识：不阻挡点击/选择/右键 -->
    <el-tooltip v-if="image.localExists === false" content="原图找不到了捏" placement="top" :show-after="300">
      <div class="missing-file-badge">
        <el-icon :size="14">
          <WarningFilled />
        </el-icon>
      </div>
    </el-tooltip>
    <transition name="fade-in" mode="out-in">
      <div v-if="!attemptUrl" key="loading" class="image-wrapper" :style="aspectRatioStyle"
        @dblclick.stop="$emit('dblclick', $event)" @contextmenu.prevent.stop="$emit('contextmenu', $event)"
        @click.stop="handleWrapperClick">
        <div v-if="isLost" class="thumbnail-lost">
          <ImageNotFound :show-image="false" />
        </div>
        <!-- 与 content 分支一致：loading 骨架使用 overlay 绝对铺满，避免父容器高度塌陷导致"纯空白" -->
        <div v-else class="thumbnail-loading thumbnail-loading-overlay">
          <el-skeleton :rows="0" animated>
            <template #template>
              <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
            </template>
          </el-skeleton>
        </div>
      </div>
      <div v-else key="content"
        :class="[imageClickAction === 'preview' && originalUrl ? 'image-preview-wrapper' : 'image-wrapper']"
        :style="aspectRatioStyle" @dblclick.stop="$emit('dblclick', $event)"
        @contextmenu.prevent.stop="$emit('contextmenu', $event)" @click.stop="handleWrapperClick">
        <!-- 加载期间始终显示骨架覆盖层，避免出现“破裂图”闪现 -->
        <div v-if="isImageLoading" class="thumbnail-loading thumbnail-loading-overlay">
          <el-skeleton :rows="0" animated>
            <template #template>
              <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
            </template>
          </el-skeleton>
        </div>
        <img :src="attemptUrl"
          :class="['thumbnail', { 'thumbnail-loading': isImageLoading, 'thumbnail-hidden': isImageLoading }]"
          :style="{ visibility: isImageLoading ? 'hidden' : 'visible' }" :alt="image.id" loading="lazy"
          draggable="false" @load="handleImageLoad" @error="handleImageError" />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { ref, toRef } from "vue";
import { WarningFilled, Download } from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import type { ImageClickAction } from "../../stores/settings";
import ImageNotFound from "../common/ImageNotFound.vue";
import { useImageItemLoader } from "../../composables/useImageItemLoader";

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
  isEntering?: boolean; // 是否正在入场（用于虚拟滚动的动画）
  isLeaving?: boolean; // 是否正在离开（用于虚拟滚动的动画）
}

const props = defineProps<Props>();

const emit = defineEmits<{
  click: [event?: MouseEvent];
  dblclick: [event?: MouseEvent];
  contextmenu: [event: MouseEvent];
  longPress: []; // 长按事件
  reorderClick: []; // 调整模式下的点击事件
  retryDownload: []; // 任务失败图片：重试下载
  enterAnimationEnd: []; // 入场动画结束
  leaveAnimationEnd: []; // 退场动画结束
}>();

const imageRef = toRef(props, "image");
const imageUrlRef = toRef(props, "imageUrl");
const useOriginalRef = toRef(props, "useOriginal");

const rootEl = ref<HTMLElement | null>(null);

const {
  attemptUrl,
  isImageLoading,
  isLost,
  lostText,
  originalUrl,
  handleImageLoad,
  handleImageError,
} = useImageItemLoader({
  image: imageRef,
  imageUrl: imageUrlRef,
  useOriginal: useOriginalRef,
  // 大列表“跳滚动条到中间”场景下，Blob 缩略图可能排队较久；这里提高阈值，避免误报“丢失”。
  // 真正缺失/失败会通过 localExists/isTaskFailed 更快体现。
  missingUrlTimeoutMs: 60000,
});

onUnmounted(() => {
  // 预留：若未来需要在卸载时做统计/打点，可在这里扩展
});

const aspectRatioStyle = computed(() => {
  // aspect-ratio = 宽 / 高；windowAspectRatio 本身就是宽/高
  const r = props.windowAspectRatio && props.windowAspectRatio > 0 ? props.windowAspectRatio : null;
  return r
    ? { aspectRatio: `${r}` }
    : { aspectRatio: "16 / 9" };
});

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

const handleAnimationEnd = (event: AnimationEvent) => {
  if (event.animationName === "itemEnter") {
    emit("enterAnimationEnd");
  } else if (event.animationName === "itemLeave") {
    emit("leaveAnimationEnd");
  }
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
    // transform: translateY(-6px) scale(1.015);
    // box-shadow: var(--anime-shadow-hover);
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

  /* 加载骨架覆盖层：不阻挡点击/选择；避免破裂图闪现 */
  .thumbnail-loading-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }

  .thumbnail-hidden {
    opacity: 0;
  }
}

.thumbnail-lost {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  box-sizing: border-box;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
  background: rgba(0, 0, 0, 0.18);
  border: 1px dashed rgba(255, 255, 255, 0.22);
  border-radius: 14px 14px 0 0;
  user-select: none;
  text-align: center;
}

.lost-text {
  width: 100%;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.88);
  word-break: break-word;
  line-clamp: 3;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
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

.retry-download-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: pointer;
  color: #fff;
  background: rgba(103, 194, 58, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  transition: background 0.2s ease;
}

.retry-download-badge:hover {
  background: rgba(103, 194, 58, 1);
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
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

/* 入场动画（与 transition-group fade-in-list 一致） */
@keyframes itemEnter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 退场动画（与 transition-group fade-in-list 一致） */
@keyframes itemLeave {
  from {
    opacity: 1;
    transform: translateY(0);
  }

  to {
    opacity: 0;
    transform: translateY(8px);
  }
}

.item-entering {
  animation: itemEnter 0.25s ease forwards;
}

.item-leaving {
  animation: itemLeave 0.25s ease forwards;
  pointer-events: none;
}
</style>
