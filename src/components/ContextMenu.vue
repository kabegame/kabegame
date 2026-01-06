<template>
  <div v-if="visible" class="context-menu-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')">
    <div ref="menuRef" class="context-menu" :style="menuStyle">
      <!-- 如果提供了 items，渲染菜单项 -->
      <template v-if="items">
        <template v-for="(item, index) in items" :key="index">
          <!-- 分隔符 -->
          <div v-if="item.type === 'divider'" class="context-menu-divider"></div>
          <!-- 菜单项 -->
          <template v-else-if="getItemVisible(item)">
            <!-- 有子菜单的项 -->
            <div v-if="item.children && item.children.length > 0" class="context-menu-item submenu-trigger"
              :class="item.className" @mouseenter="activeSubmenuIndex = index" @mouseleave="activeSubmenuIndex = null">
              <el-icon v-if="item.icon">
                <component :is="item.icon" />
              </el-icon>
              <span style="margin-left: 8px;">{{ item.label }}</span>
              <span v-if="item.suffix" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                {{ item.suffix }}
              </span>
              <el-icon class="submenu-arrow">
                <ArrowRight />
              </el-icon>
              <!-- 子菜单 -->
              <div v-if="activeSubmenuIndex === index"
                :ref="(el) => { if (el) setSubmenuRef(el as HTMLElement, index); }" class="submenu"
                :style="getSubmenuStyle(index)" @mouseenter="activeSubmenuIndex = index"
                @mouseleave="activeSubmenuIndex = null">
                <template v-for="(child, childIndex) in item.children" :key="childIndex">
                  <div v-if="child.type !== 'divider' && getItemVisible(child)" class="context-menu-item"
                    :class="child.className" @click.stop="handleItemClick(child)">
                    <el-icon v-if="child.icon">
                      <component :is="child.icon" />
                    </el-icon>
                    <span style="margin-left: 8px;">{{ child.label }}</span>
                    <span v-if="child.suffix"
                      style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                      {{ child.suffix }}
                    </span>
                  </div>
                  <div v-else-if="child.type === 'divider'" class="context-menu-divider"></div>
                </template>
              </div>
            </div>
            <!-- 普通菜单项 -->
            <div v-else class="context-menu-item" :class="item.className" @click.stop="handleItemClick(item)">
              <el-icon v-if="item.icon">
                <component :is="item.icon" />
              </el-icon>
              <span style="margin-left: 8px;">{{ item.label }}</span>
              <span v-if="item.suffix" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                {{ item.suffix }}
              </span>
            </div>
          </template>
        </template>
      </template>
      <!-- 否则使用 slot -->
      <slot v-else />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, type CSSProperties } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import type { Component } from "vue";

export interface MenuItem {
  key?: string; // 菜单项的唯一标识，用于隐藏控制
  type?: "item" | "divider";
  label?: string;
  icon?: Component;
  command?: string;
  visible?: boolean | (() => boolean);
  className?: string;
  suffix?: string;
  children?: MenuItem[];
  onClick?: () => void;
}

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  items?: MenuItem[]; // 可选的菜单项列表，如果提供则渲染 items，否则使用 slot
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  command: [command: string];
}>();

const menuRef = ref<HTMLElement | null>(null);
const adjustedPosition = ref({ x: props.position.x, y: props.position.y });

// 子菜单相关状态
const activeSubmenuIndex = ref<number | null>(null);
const submenuRefs = new Map<number, HTMLElement>(); // 非响应式，避免触发重新渲染
const submenuStyles = ref<Map<number, CSSProperties>>(new Map());
// 记录已经调整过位置的子菜单索引，避免重复调整导致死循环
const adjustedSubmenuIndexes = new Set<number>();

const menuStyle = computed<CSSProperties>(() => ({
  position: "fixed",
  left: `${adjustedPosition.value.x}px`,
  top: `${adjustedPosition.value.y}px`,
  zIndex: 9999,
}));

/**
 * 计算菜单位置，确保不会超出屏幕边界
 * @param element 菜单元素
 * @param position 初始位置 { x, y }
 * @returns 调整后的位置 { x, y }
 */
const calculateMenuPosition = (
  element: HTMLElement,
  position: { x: number; y: number }
): { x: number; y: number } => {
  const menuRect = element.getBoundingClientRect();
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;
  const margin = 10; // 边距

  // 如果菜单尺寸为0，返回原始位置
  if (menuRect.width === 0 || menuRect.height === 0) {
    return position;
  }

  let x = position.x;
  let y = position.y;

  // 检查右边界
  if (x + menuRect.width > windowWidth) {
    x = windowWidth - menuRect.width - margin;
    if (x < margin) x = margin; // 确保不会超出左边界
  }

  // 检查下边界 - 如果菜单会超出底部，则向上调整
  const spaceBelow = windowHeight - y;
  const spaceAbove = y;

  if (menuRect.height > spaceBelow) {
    // 如果下方空间不足，尝试向上显示
    if (spaceAbove >= menuRect.height) {
      // 如果上方空间足够，以鼠标位置为菜单底部
      y = position.y - menuRect.height;
    } else {
      // 如果上方空间也不够，则贴底显示，但确保能看到
      y = Math.max(margin, windowHeight - menuRect.height - margin);
    }
  }

  // 检查左边界
  if (x < margin) {
    x = margin;
  }

  // 检查上边界
  if (y < margin) {
    y = margin;
  }

  return { x, y };
};

const adjustPosition = () => {
  // 使用多重 nextTick 确保 DOM 完全渲染，特别是针对 teleport 的情况
  nextTick(() => {
    nextTick(() => {
      nextTick(() => {
        if (!menuRef.value) return;

        const menuRect = menuRef.value.getBoundingClientRect();

        // 如果菜单尺寸为0，说明还未完全渲染，延迟执行
        if (menuRect.width === 0 || menuRect.height === 0) {
          setTimeout(adjustPosition, 10);
          return;
        }

        adjustedPosition.value = calculateMenuPosition(menuRef.value, props.position);
      });
    });
  });
};

watch(() => props.visible, (newVal) => {
  if (newVal) {
    // 先设置初始位置
    adjustedPosition.value = { x: props.position.x, y: props.position.y };
    // 然后调整位置
    adjustPosition();
  } else {
    // 菜单关闭时，清理子菜单状态
    activeSubmenuIndex.value = null;
    submenuRefs.clear();
    submenuStyles.value.clear();
    adjustedSubmenuIndexes.clear();
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

// 监听 activeSubmenuIndex 变化，清理之前子菜单的调整状态
watch(activeSubmenuIndex, (newIndex, oldIndex) => {
  if (oldIndex !== null && oldIndex !== newIndex) {
    // 清理旧子菜单的状态
    submenuRefs.delete(oldIndex);
    submenuStyles.value.delete(oldIndex);
    adjustedSubmenuIndexes.delete(oldIndex);
  }
});

// 子菜单相关方法
const setSubmenuRef = (el: HTMLElement, index: number) => {
  // 避免重复设置导致死循环
  if (submenuRefs.get(index) === el && adjustedSubmenuIndexes.has(index)) {
    return;
  }
  submenuRefs.set(index, el);
  adjustSubmenuPosition(index);
};

const adjustSubmenuPosition = (index: number) => {
  // 如果已经调整过，跳过
  if (adjustedSubmenuIndexes.has(index)) {
    return;
  }

  nextTick(() => {
    nextTick(() => {
      const submenuEl = submenuRefs.get(index);
      if (!submenuEl) return;

      // 再次检查，避免在 nextTick 期间重复触发
      if (adjustedSubmenuIndexes.has(index)) {
        return;
      }

      const submenuRect = submenuEl.getBoundingClientRect();
      if (submenuRect.width === 0 || submenuRect.height === 0) {
        setTimeout(() => adjustSubmenuPosition(index), 10);
        return;
      }

      // 获取父菜单项的位置
      const parentItem = submenuEl.parentElement;
      if (!parentItem) return;

      const parentRect = parentItem.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const margin = 10;

      // 默认显示在右侧
      let left = parentRect.width + 4; // margin-left: 4px
      let top = 0;

      // 检查右侧空间是否足够
      const spaceOnRight = windowWidth - parentRect.right;
      const spaceOnLeft = parentRect.left;

      if (spaceOnRight < submenuRect.width && spaceOnLeft >= submenuRect.width) {
        // 右侧空间不足，显示在左侧
        left = -submenuRect.width - 4;
      } else if (spaceOnRight < submenuRect.width && spaceOnLeft < submenuRect.width) {
        // 两侧空间都不足，选择空间较大的一侧
        if (spaceOnRight >= spaceOnLeft) {
          left = parentRect.width + 4;
        } else {
          left = -submenuRect.width - 4;
        }
      }

      // 检查垂直位置
      const spaceBelow = windowHeight - parentRect.top;
      const spaceAbove = parentRect.top;

      if (submenuRect.height > spaceBelow) {
        // 下方空间不足，向上调整
        if (spaceAbove >= submenuRect.height) {
          // 上方空间足够，以父菜单项顶部对齐
          top = -(submenuRect.height - parentRect.height);
        } else {
          // 上方空间也不够，贴顶显示
          top = -(parentRect.top - margin);
        }
      }

      // 确保子菜单不会超出屏幕顶部
      const finalTop = parentRect.top + top;
      if (finalTop < margin) {
        top = margin - parentRect.top;
      }

      // 确保子菜单不会超出屏幕底部
      const finalBottom = parentRect.top + top + submenuRect.height;
      if (finalBottom > windowHeight - margin) {
        top = windowHeight - margin - parentRect.top - submenuRect.height;
      }

      // 标记为已调整，避免重复触发
      adjustedSubmenuIndexes.add(index);

      submenuStyles.value.set(index, {
        left: `${left}px`,
        top: `${top}px`,
      });
    });
  });
};

const getSubmenuStyle = (index: number): CSSProperties => {
  return submenuStyles.value.get(index) || {};
};

const getItemVisible = (item: MenuItem): boolean => {
  if (item.visible === undefined) return true;
  if (typeof item.visible === "boolean") return item.visible;
  if (typeof item.visible === "function") return item.visible();
  return true;
};

const handleItemClick = (item: MenuItem) => {
  if (item.onClick) {
    item.onClick();
  } else if (item.command) {
    emit("command", item.command);
  }
};
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

  :deep(.submenu-trigger) {
    position: relative;

    .submenu-arrow {
      margin-left: auto;
      margin-right: 8px;
    }

    .submenu {
      position: absolute;
      background: var(--anime-bg-card);
      border: 1px solid var(--anime-border);
      border-radius: 8px;
      box-shadow: var(--anime-shadow-hover);
      padding: 8px 0;
      min-width: 180px;
      z-index: 10000;
    }
  }
}
</style>
