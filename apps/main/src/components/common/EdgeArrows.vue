<template>
  <div class="edge-arrows-container" ref="containerRef" @mouseenter="handleMouseEnter" @mouseleave="handleMouseLeave"
    @mousemove="handleMouseMove">
    <slot />
    <transition name="fade">
      <div v-if="showArrows" class="edge-arrows">
        <transition name="fade">
          <button v-if="showUp && onMove" class="arrow-btn arrow-up" @click.stop="handleArrowClick('up')" title="向上移动">
            <el-icon>
              <ArrowUp />
            </el-icon>
          </button>
        </transition>
        <transition name="fade">
          <button v-if="showDown && onMove" class="arrow-btn arrow-down" @click.stop="handleArrowClick('down')"
            title="向下移动">
            <el-icon>
              <ArrowDown />
            </el-icon>
          </button>
        </transition>
        <transition name="fade">
          <button v-if="showLeft && onMove" class="arrow-btn arrow-left" @click.stop="handleArrowClick('left')"
            title="向左移动">
            <el-icon>
              <ArrowLeft />
            </el-icon>
          </button>
        </transition>
        <transition name="fade">
          <button v-if="showRight && onMove" class="arrow-btn arrow-right" @click.stop="handleArrowClick('right')"
            title="向右移动">
            <el-icon>
              <ArrowRight />
            </el-icon>
          </button>
        </transition>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from "@element-plus/icons-vue";

interface Props {
  showUp?: boolean;
  showDown?: boolean;
  showLeft?: boolean;
  showRight?: boolean;
  edgeThreshold?: number; // 边缘检测阈值（像素），默认 50
  onMove?: (direction: "up" | "down" | "left" | "right") => void;
}

const props = withDefaults(defineProps<Props>(), {
  showUp: false,
  showDown: false,
  showLeft: false,
  showRight: false,
  edgeThreshold: 50,
  onMove: undefined,
});

const containerRef = ref<HTMLElement | null>(null);
const isHovering = ref(false);
const mouseX = ref(0);
const mouseY = ref(0);

// 计算是否显示箭头
const showArrows = computed(() => isHovering.value && props.onMove);

// 计算各方向箭头是否显示（基于鼠标位置）
const showUpArrow = computed(() => {
  if (!isHovering.value || !props.showUp) return false;
  return mouseY.value < props.edgeThreshold;
});

const showDownArrow = computed(() => {
  if (!isHovering.value || !props.showDown) return false;
  if (!containerRef.value) return false;
  const rect = containerRef.value.getBoundingClientRect();
  return mouseY.value > rect.height - props.edgeThreshold;
});

const showLeftArrow = computed(() => {
  if (!isHovering.value || !props.showLeft) return false;
  return mouseX.value < props.edgeThreshold;
});

const showRightArrow = computed(() => {
  if (!isHovering.value || !props.showRight) return false;
  if (!containerRef.value) return false;
  const rect = containerRef.value.getBoundingClientRect();
  return mouseX.value > rect.width - props.edgeThreshold;
});

// 使用计算属性，但只在对应方向启用时显示
const showUp = computed(() => props.showUp && showUpArrow.value);
const showDown = computed(() => props.showDown && showDownArrow.value);
const showLeft = computed(() => props.showLeft && showLeftArrow.value);
const showRight = computed(() => props.showRight && showRightArrow.value);

function handleMouseEnter() {
  isHovering.value = true;
}

function handleMouseLeave() {
  isHovering.value = false;
  mouseX.value = 0;
  mouseY.value = 0;
}

function handleMouseMove(event: MouseEvent) {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  mouseX.value = event.clientX - rect.left;
  mouseY.value = event.clientY - rect.top;
}

function handleArrowClick(direction: "up" | "down" | "left" | "right") {
  if (props.onMove) {
    props.onMove(direction);
  }
}
</script>

<style scoped lang="scss">
.edge-arrows-container {
  position: relative;
  width: 100%;
  height: 100%;
}

.edge-arrows {
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
  background: rgba(255, 107, 157, 0.85);
  border: none;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: all;
  transition: opacity 0.2s ease, background 0.2s ease;
  box-shadow: none;

  &:hover {
    opacity: 0.9;
    background: rgba(255, 77, 138, 0.95);
  }

  .el-icon {
    font-size: 16px;
  }
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-enter-to,
.fade-leave-from {
  opacity: 1;
}

.arrow-up {
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  // 上边缘：半圆向下凸出（底部两个角是圆角）
  border-radius: 0 0 50% 50%;
}

.arrow-down {
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  // 下边缘：半圆向上凸出（顶部两个角是圆角）
  border-radius: 50% 50% 0 0;
}

.arrow-left {
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  // 左边缘：半圆向右凸出（右侧两个角是圆角）
  border-radius: 0 50% 50% 0;
}

.arrow-right {
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  // 右边缘：半圆向左凸出（左侧两个角是圆角）
  border-radius: 50% 0 0 50%;
}
</style>

