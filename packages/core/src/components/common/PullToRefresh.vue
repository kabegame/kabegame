<template>
  <div
    ref="containerRef"
    class="pull-to-refresh"
    :class="{ 'is-pulling': isPulling, 'is-refreshing': isRefreshing }"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  >
    <!-- 出现容器：圆圈从该区域顶部向下出现 -->
    <div class="pull-to-refresh-head">
      <div
        class="pull-to-refresh-indicator"
        :style="{ transform: `translateX(-50%) translateY(${pullDistance}px)` }"
      >
        <div class="spinner-wrapper">
          <div class="spinner" :class="{ 'is-spinning': isRefreshing }">
            <svg viewBox="0 0 24 24" class="spinner-svg">
              <circle
                cx="12"
                cy="12"
                r="10"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                :stroke-dasharray="circumference"
                :stroke-dashoffset="circumference - (pullProgress * circumference)"
                class="spinner-circle"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
    <!-- 下拉检测容器：触顶后继续下拉时触发；不位移、不 bouncing -->
    <div class="pull-to-refresh-body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from "vue";

interface Props {
  /** 是否正在刷新 */
  refreshing?: boolean;
  /** 触发刷新的下拉距离阈值（px） */
  threshold?: number;
  /** 最大下拉距离（px） */
  maxDistance?: number;
  /** 是否禁用 */
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  refreshing: false,
  threshold: 80,
  maxDistance: 120,
  disabled: false,
});

const emit = defineEmits<{
  refresh: [];
}>();

const containerRef = ref<HTMLElement | null>(null);
const isPulling = ref(false);
const isRefreshing = computed(() => props.refreshing);
const pullDistance = ref(0);
const startY = ref(0);
const currentY = ref(0);
const isDragging = ref(false);

// 计算下拉进度（0-1）
const pullProgress = computed(() => {
  if (props.threshold <= 0) return 0;
  return Math.min(pullDistance.value / props.threshold, 1);
});

// 圆圈周长（用于 SVG stroke-dasharray）
const circumference = computed(() => 2 * Math.PI * 10); // r=10

const handleTouchStart = (e: TouchEvent) => {
  if (props.disabled || isRefreshing.value) return;
  
  const touch = e.touches[0];
  if (!touch) return;
  
  const container = containerRef.value;
  if (!container) return;
  
  // 从触摸目标向上遍历 DOM 树，找到最近的滚动容器
  // 这样可以正确检测嵌套滚动容器（如 ImageGrid 的 .image-grid-container）
  let scrollable: Element | null = null;
  let current: Element | null = e.target as Element;
  
  while (current && current !== container) {
    // 检查元素是否可滚动
    if (current.scrollHeight > current.clientHeight) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scrollable = current;
        break;
      }
    }
    current = current.parentElement;
  }
  
  // 如果找到了滚动容器且不在顶部，不触发下拉刷新
  if (scrollable) {
    const scrollTop = (scrollable as HTMLElement).scrollTop || 0;
    if (scrollTop > 1) return; // 使用 > 1 阈值避免子像素误判
  } else {
    // 回退：如果没有找到嵌套滚动容器，检查下拉检测容器 .pull-to-refresh-body
    // （用于没有嵌套滚动的页面，如 Settings、TaskDetail）
    const bodyEl = container.querySelector(".pull-to-refresh-body") as HTMLElement;
    if (bodyEl) {
      const scrollTop = bodyEl.scrollTop || 0;
      if (scrollTop > 1) return;
    }
  }
  
  startY.value = touch.clientY;
  currentY.value = touch.clientY;
  isDragging.value = true;
  isPulling.value = false;
};

const handleTouchMove = (e: TouchEvent) => {
  if (!isDragging.value || props.disabled || isRefreshing.value) return;
  
  const touch = e.touches[0];
  if (!touch) return;
  
  currentY.value = touch.clientY;
  const deltaY = currentY.value - startY.value;
  
  // 只允许向下拉
  if (deltaY > 0) {
    e.preventDefault(); // 阻止默认滚动行为
    
    // 计算下拉距离（带阻尼效果）
    const rawDistance = deltaY;
    // 阻尼：超过阈值后增加阻力
    let distance = rawDistance;
    if (rawDistance > props.threshold) {
      const excess = rawDistance - props.threshold;
      distance = props.threshold + excess * 0.3; // 超过阈值后阻力增加
    }
    
    pullDistance.value = Math.min(distance, props.maxDistance);
    isPulling.value = pullDistance.value > 10; // 超过 10px 才显示指示器
  }
};

const handleTouchEnd = () => {
  if (!isDragging.value) return;
  
  isDragging.value = false;
  
  // 如果下拉距离超过阈值，触发刷新
  if (pullDistance.value >= props.threshold && !isRefreshing.value) {
    emit("refresh");
    // 保持下拉状态，等待外部设置 refreshing 为 true
  } else {
    // 否则回弹
    resetPull();
  }
};

const resetPull = () => {
  pullDistance.value = 0;
  isPulling.value = false;
};

// 监听 refreshing 状态变化，刷新完成后回弹
watch(() => props.refreshing, (newVal) => {
  if (!newVal) {
    // 刷新完成，延迟回弹以显示完成状态
    setTimeout(() => {
      resetPull();
    }, 300);
  }
});

// 清理
onUnmounted(() => {
  resetPull();
});
</script>

<style scoped lang="scss">
.pull-to-refresh {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: pan-y;
  display: flex;
  flex-direction: column;
}

/* 出现容器：圆圈从该区域顶部向下移动；绝对定位不占布局空间，避免把页面 header 顶下去 */
.pull-to-refresh-head {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 80px;
  z-index: 10;
  pointer-events: none;
}

.pull-to-refresh-indicator {
  position: absolute;
  top: 0;
  left: 50%;
  width: 100%;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  transition: transform 0.3s ease;
  pointer-events: none;
}

.spinner-wrapper {
  width: 5vw;
  height: 5vw;
  min-width: 24px;
  min-height: 24px;
  max-width: 40px;
  max-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  width: 100%;
  height: 100%;
  transition: transform 0.3s ease;
  
  &.is-spinning {
    animation: spin 1s linear infinite;
  }
}

.spinner-svg {
  width: 100%;
  height: 100%;
  color: var(--anime-primary);
  filter: drop-shadow(0 2px 4px rgba(255, 107, 157, 0.3));
}

.spinner-circle {
  transition: stroke-dashoffset 0.3s ease;
  stroke: var(--anime-primary);
}

/* 下拉检测容器：不位移、不 bouncing，仅用于触顶与下拉检测 */
.pull-to-refresh-body {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  /* 让 slot 内容填满剩余高度（如 ImageGrid） */
  & > * {
    flex: 1;
    min-height: 0;
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

// 刷新中的状态
.is-refreshing {
  .spinner {
    animation: spin 1s linear infinite;
  }
}
</style>
