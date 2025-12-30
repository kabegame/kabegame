<template>
  <div v-if="visible" class="context-menu-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')">
    <div 
      ref="menuRef"
      class="context-menu" 
      :style="menuStyle"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, type CSSProperties } from "vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
}

const props = defineProps<Props>();

defineEmits<{
  close: [];
}>();

const menuRef = ref<HTMLElement | null>(null);
const adjustedPosition = ref({ x: props.position.x, y: props.position.y });

const menuStyle = computed<CSSProperties>(() => ({
  position: "fixed",
  left: `${adjustedPosition.value.x}px`,
  top: `${adjustedPosition.value.y}px`,
  zIndex: 9999,
}));

const adjustPosition = () => {
  // 使用双重 nextTick 确保 DOM 完全渲染
  nextTick(() => {
    nextTick(() => {
      if (!menuRef.value) return;

      const menuRect = menuRef.value.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      
      let x = props.position.x;
      let y = props.position.y;

      // 检查右边界
      if (x + menuRect.width > windowWidth) {
        x = windowWidth - menuRect.width - 10; // 留10px边距
        if (x < 10) x = 10; // 确保不会超出左边界
      }

      // 检查下边界 - 如果菜单会超出底部，则向上调整
      const spaceBelow = windowHeight - y;
      const spaceAbove = y;
      
      if (menuRect.height > spaceBelow) {
        // 如果下方空间不足，尝试向上显示
        if (spaceAbove >= menuRect.height) {
          // 如果上方空间足够，以鼠标位置为菜单底部
          y = props.position.y - menuRect.height;
        } else {
          // 如果上方空间也不够，则贴底显示，但确保能看到
          y = Math.max(10, windowHeight - menuRect.height - 10);
        }
      }

      // 检查左边界
      if (x < 10) {
        x = 10;
      }

      // 检查上边界
      if (y < 10) {
        y = 10;
      }

      adjustedPosition.value = { x, y };
    });
  });
};

watch(() => props.visible, (newVal) => {
  if (newVal) {
    // 先设置初始位置
    adjustedPosition.value = { x: props.position.x, y: props.position.y };
    // 然后调整位置
    adjustPosition();
  }
});

watch(() => props.position, () => {
  if (props.visible) {
    // 先设置初始位置
    adjustedPosition.value = { x: props.position.x, y: props.position.y };
    // 然后调整位置
    adjustPosition();
  }
}, { deep: true });
</script>

<style scoped lang="scss">
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9998;
  background: transparent;
}

.context-menu {
  background: var(--anime-bg-card);
  border: 1px solid var(--anime-border);
  border-radius: 8px;
  box-shadow: var(--anime-shadow-hover);
  padding: 8px 0;
  min-width: 150px;
  z-index: 9999;

  :deep(.context-menu-item) {
    display: flex;
    align-items: center;
    padding: 8px 16px;
    cursor: pointer;
    transition: background-color 0.2s;
    color: var(--anime-text-primary);

    &:hover {
      background: var(--anime-bg-hover);
    }
  }

  :deep(.context-menu-divider) {
    height: 1px;
    background: var(--anime-border);
    margin: 4px 0;
  }
}
</style>


