<template>
  <div class="image-item"
    :class="{ 'image-item-selected': selected, 'reorder-mode': isReorderMode, 'reorder-selected': reorderSelected }"
    ref="itemRef" :data-id="image.id" @contextmenu.prevent="$emit('contextmenu', $event)" @mousedown="handleMouseDown"
    @mouseup="handleMouseUp" @mouseleave="handleMouseLeave">
    <transition name="fade-in" mode="out-in">
      <div v-if="!hasImageUrl" key="loading" class="thumbnail-loading" :style="loadingStyle">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>
      <div v-else key="content"
        :class="[imageClickAction === 'preview' && originalUrl ? 'image-preview-wrapper' : 'image-wrapper']"
        :style="imageHeightStyle" @dblclick.stop="$emit('dblclick', $event)"
        @contextmenu.prevent.stop="$emit('contextmenu', $event)" @click.stop="handleWrapperClick">
        <img :src="displayUrl" :class="['thumbnail', { 'thumbnail-loading': isImageLoading }]" :alt="image.id"
          loading="lazy" draggable="false" @load="handleImageLoad"
          @error="(e: any) => { if (originalUrl) e.target.src = originalUrl; }" />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
  imageClickAction: "preview" | "open";
  useOriginal?: boolean; // 是否使用原图（当列数 <= 2 时）
  aspectRatioMatchWindow?: boolean; // 图片宽高比是否与窗口相同
  windowAspectRatio?: number; // 窗口宽高比
  selected?: boolean; // 是否被选中
  gridColumns?: number; // 网格列数
  gridIndex?: number; // 在网格中的索引
  totalImages?: number; // 总图片数
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
const isImageLoading = ref(true); // 跟踪图片是否正在加载
const isFirstMount = ref(true); // 跟踪是否是首次挂载
const loadingTimer = ref<number | null>(null); // 存储定时器ID，防止重复设置

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

  // 挂载时始终播放动画（刷新时也应该有动画）
  // 等待图片加载完成或动画完成后移除加载状态
  if (displayUrl.value) {
    nextTick(() => {
      const imgElement = itemRef.value?.querySelector('.thumbnail') as HTMLImageElement | null;
      if (imgElement) {
        if (imgElement.complete && imgElement.naturalHeight !== 0) {
          // 图片已在缓存中，但仍要播放动画，等待动画完成后再移除加载状态
          if (loadingTimer.value) {
            clearTimeout(loadingTimer.value);
          }
          loadingTimer.value = window.setTimeout(() => {
            isImageLoading.value = false;
            isFirstMount.value = false;
            loadingTimer.value = null;
          }, 400); // 400ms 等于动画时长
        }
        // 如果图片未加载完成，会在 handleImageLoad 中处理
      }
    });
  } else {
    isFirstMount.value = false;
  }
});

onUnmounted(() => {
  if (resizeObserver && itemRef.value) {
    resizeObserver.unobserve(itemRef.value);
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  // 清理定时器
  if (loadingTimer.value) {
    clearTimeout(loadingTimer.value);
    loadingTimer.value = null;
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

// 监听displayUrl变化，重置加载状态（仅在URL真正变化时触发，不是首次挂载）
let previousUrl = displayUrl.value;
watch(() => displayUrl.value, (newUrl) => {
  // 如果URL没有真正变化（首次挂载时），跳过，让onMounted处理
  if (newUrl === previousUrl) {
    return;
  }
  previousUrl = newUrl;
  // URL变化时，重置加载状态
  isImageLoading.value = true;
  // 使用nextTick检查图片是否已经在缓存中并已加载完成
  nextTick(() => {
    const imgElement = itemRef.value?.querySelector('.thumbnail') as HTMLImageElement | null;
    if (imgElement && imgElement.complete && imgElement.naturalHeight !== 0) {
      // 图片已经在缓存中并已加载完成，不播放动画
      isImageLoading.value = false;
    }
  });
});

// 处理图片加载完成
function handleImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.complete && img.naturalHeight !== 0) {
    if (isFirstMount.value) {
      // 首次挂载时，需要等待动画完成
      // 如果已经有定时器在运行，不再重复设置
      if (!loadingTimer.value) {
        loadingTimer.value = window.setTimeout(() => {
          isImageLoading.value = false;
          isFirstMount.value = false;
          loadingTimer.value = null;
        }, 400); // 400ms 等于动画时长
      }
    } else {
      // 非首次加载（URL变化），立即移除加载状态
      isImageLoading.value = false;
    }
  }
}

// 已移除图片原生拖拽（draggable/dragstart），以支持画廊"直接鼠标拖拽滚动"手势

// 长按检测
const longPressTimer = ref<number | null>(null);
const isLongPressing = ref(false);
const LONG_PRESS_DURATION = 500; // 500ms 长按时间

const handleMouseDown = (event: MouseEvent) => {
  // 只在非调整模式下检测长按
  if (props.isReorderMode) return;

  // 只处理左键
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

// 处理根元素点击（仅在调整模式下）
// 处理 wrapper 点击（正常模式）
const handleWrapperClick = (event?: MouseEvent) => {
  if (props.isReorderMode) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    emit("reorderClick");
    return;
  }

  // 正常模式下的点击
  emit("click", event);
};

onUnmounted(() => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
});
</script>

<style scoped lang="scss">
.image-item {
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease, border-color 0.25s ease;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
  box-sizing: border-box;

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


/* 调整模式下选中的图片高亮 */
.image-item.reorder-selected {
  border-color: #ff6b9d;
  border-width: 3px;
  box-shadow:
    0 0 0 4px rgba(255, 107, 157, 0.5),
    0 0 30px rgba(255, 107, 157, 0.6),
    0 6px 16px rgba(255, 107, 157, 0.4);
  z-index: 10;
  position: relative;
}
</style>
