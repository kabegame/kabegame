<template>
  <div class="image-item" :class="{ 'image-item-selected': selected }" ref="itemRef" :data-id="image.id"
    @contextmenu.prevent="$emit('contextmenu', $event)">
    <transition name="fade-in" mode="out-in">
      <div v-if="!hasImageUrl" key="loading" class="thumbnail-loading" :style="loadingStyle">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>
      <div v-else key="content" :class="[imageClickAction === 'preview' && originalUrl ? 'image-preview-wrapper' : 'image-wrapper']"
        :style="imageHeightStyle" @click.stop="$emit('click', $event)" @dblclick.stop="$emit('dblclick', $event)"
        @contextmenu.prevent.stop="$emit('contextmenu', $event)">
        <img :src="displayUrl" :class="['thumbnail', { 'thumbnail-loading': isImageLoading }]" :alt="image.id"
          loading="lazy" draggable="false" @load="handleImageLoad"
          @error="(e: any) => { if (originalUrl) e.target.src = originalUrl; }" />
        <!-- 箭头按钮（仅在选中且允许移动时显示） -->
        <div v-if="selected && (props.canMoveItem ?? true)" class="order-arrows">
          <button v-if="showUpArrow" class="arrow-btn arrow-up" @click.stop="handleMove('up')" title="向上移动">
            <el-icon>
              <ArrowUp />
            </el-icon>
          </button>
          <button v-if="showDownArrow" class="arrow-btn arrow-down" @click.stop="handleMove('down')" title="向下移动">
            <el-icon>
              <ArrowDown />
            </el-icon>
          </button>
          <button v-if="showLeftArrow" class="arrow-btn arrow-left" @click.stop="handleMove('left')" title="向左移动">
            <el-icon>
              <ArrowLeft />
            </el-icon>
          </button>
          <button v-if="showRightArrow" class="arrow-btn arrow-right" @click.stop="handleMove('right')" title="向右移动">
            <el-icon>
              <ArrowRight />
            </el-icon>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from "@element-plus/icons-vue";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
  imageClickAction: "preview" | "open";
  useOriginal?: boolean; // 是否使用原图（当列数 <= 2 时）
  aspectRatioMatchWindow?: boolean; // 图片宽高比是否与窗口相同
  windowAspectRatio?: number; // 窗口宽高比
  selected?: boolean; // 是否被选中
  canMoveItem?: boolean; // 是否允许显示/使用移动箭头
  gridColumns?: number; // 网格列数（0 表示 auto-fill）
  gridIndex?: number; // 在网格中的索引
  totalImages?: number; // 总图片数
}

const props = defineProps<Props>();

const emit = defineEmits<{
  click: [event?: MouseEvent];
  dblclick: [event?: MouseEvent];
  contextmenu: [event: MouseEvent];
  move: [image: ImageInfo, direction: "up" | "down" | "left" | "right"];
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

// 已移除图片原生拖拽（draggable/dragstart），以支持画廊“直接鼠标拖拽滚动”手势

// 计算行列位置和箭头显示
const gridColumns = computed(() => props.gridColumns || 0);
const gridIndex = computed(() => props.gridIndex ?? 0);
const totalImages = computed(() => props.totalImages ?? 0);

// 计算实际列数（如果是 auto-fill，需要从 DOM 获取）
// 初始值：如果 gridColumns 有值就用它，否则设为 0（auto-fill 需要从 DOM 计算）
const actualColumns = ref<number>(gridColumns.value > 0 ? gridColumns.value : 0);

onMounted(() => {
  if (gridColumns.value === 0 && itemRef.value) {
    // 对于 auto-fill，从父元素计算实际列数
    const updateColumns = () => {
      if (itemRef.value?.parentElement) {
        const grid = itemRef.value.parentElement;
        // 使用更可靠的方法：检查第一个子元素的位置
        const firstChild = grid.firstElementChild as HTMLElement;
        if (firstChild) {
          const firstRect = firstChild.getBoundingClientRect();
          let cols = 1;
          // 遍历所有子元素，找到有多少个在同一行
          for (let i = 1; i < grid.children.length; i++) {
            const child = grid.children[i] as HTMLElement;
            const childRect = child.getBoundingClientRect();
            // 如果这个元素和第一个元素在同一行（Y 坐标相近），则列数+1
            if (Math.abs(childRect.top - firstRect.top) < 10) {
              cols++;
            } else {
              break; // 遇到下一行就停止
            }
          }
          if (cols > 0) {
            actualColumns.value = cols;
          }
        }
      }
    };
    // 使用 nextTick 确保 DOM 已渲染
    setTimeout(updateColumns, 100);
    // 监听窗口大小变化
    const resizeHandler = () => {
      setTimeout(updateColumns, 50);
    };
    window.addEventListener("resize", resizeHandler);
    onUnmounted(() => {
      window.removeEventListener("resize", resizeHandler);
    });
  } else if (gridColumns.value > 0) {
    actualColumns.value = gridColumns.value;
  }
});

// 计算行列
const row = computed(() => {
  // 如果 actualColumns 为 0，说明还没有计算出列数，此时不显示箭头（返回 0）
  if (actualColumns.value === 0) return 0;
  return Math.floor(gridIndex.value / actualColumns.value);
});

const col = computed(() => {
  if (actualColumns.value === 0) return 0;
  return gridIndex.value % actualColumns.value;
});

// 判断是否显示箭头
const showUpArrow = computed(() => row.value > 0);
const showDownArrow = computed(() => {
  if (actualColumns.value === 0) return false;
  // 计算下一行同一列的索引
  const nextRowSameColIndex = gridIndex.value + actualColumns.value;
  // 只有当下一行同一列存在图片时才显示下箭头
  return nextRowSameColIndex < totalImages.value;
});
const showLeftArrow = computed(() => col.value > 0);
const showRightArrow = computed(() => {
  if (actualColumns.value === 0) return false;
  // 检查是否在最后一列
  const isLastCol = col.value === actualColumns.value - 1;
  // 如果不在最后一行，或者最后一行但后面还有图片，则显示右箭头
  return isLastCol ? false : (gridIndex.value + 1 < totalImages.value);
});

// 处理移动
function handleMove(direction: "up" | "down" | "left" | "right") {
  emit("move", props.image, direction);
}
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

// 箭头按钮样式
.order-arrows {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 10;
}

.arrow-btn {
  position: absolute;
  width: 32px;
  height: 32px;
  border-radius: 0;
  background: rgba(255, 107, 157, 0.85);
  border: none;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: all;
  opacity: 0;
  transition: opacity 0.2s ease, background 0.2s ease;
  box-shadow: none;

  &:hover {
    opacity: 0.7;
    background: rgba(255, 77, 138, 0.95);
  }

  .el-icon {
    font-size: 16px;
  }
}

.arrow-up {
  top: 0;
  left: 50%;
  transform: translateX(-50%);
}

.arrow-down {
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
}

.arrow-left {
  left: 0;
  top: 50%;
  transform: translateY(-50%);
}

.arrow-right {
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}
</style>
