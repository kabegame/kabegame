<template>
  <Teleport to="body">
    <!-- Main action sheet -->
    <Transition name="action-sheet-slide">
      <div v-if="visible && resolvedActions.length > 0 && !expandedItem" class="action-sheet">
        <button
          v-for="item in resolvedActions"
          :key="item.key"
          class="action-sheet-button"
          :class="item.className"
          @click.stop="handleClick(item)">
          <el-icon class="action-sheet-icon">
            <component :is="getIcon(item)" />
          </el-icon>
          <span class="action-sheet-label">
            {{ getLabel(item) }}
          </span>
        </button>
      </div>
    </Transition>

    <!-- Submenu overlay (when expandedItem has children) -->
    <Transition name="submenu-slide">
      <div v-if="visible && expandedItem && expandedChildren.length > 0" class="submenu-overlay" @click.stop="closeSubmenu">
        <div class="submenu-panel" @click.stop>
          <div
            v-for="child in expandedChildren"
            :key="child.key">
            <div
              v-if="child.type === 'divider' || (typeof child.dividerBefore === 'function' ? child.dividerBefore(props.context) : child.dividerBefore)"
              class="submenu-divider"></div>
            <button
              v-if="child.type !== 'divider'"
              class="submenu-item"
              :class="child.className"
              @click.stop="handleChildClick(child)">
              <el-icon v-if="child.icon" class="submenu-icon">
                <component :is="getChildIcon(child)" />
              </el-icon>
              <span class="submenu-label">
                {{ getChildLabel(child) }}
              </span>
              <span v-if="getChildSuffix(child)" class="submenu-suffix">
                {{ getChildSuffix(child) }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import type { ActionItem, ActionContext } from "../actions/types";
import { IS_ANDROID } from "../env";
import { useModalStackStore } from "../stores/modalStack";

interface Props {
  visible: boolean;
  actions: ActionItem[];
  context: ActionContext;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  command: [command: string];
  close: [];
}>();

// Track which item's submenu is expanded
const expandedItem = ref<ActionItem | null>(null);

const modalStack = useModalStackStore();
const stackEntryId = ref<string | null>(null);

// Android: register with modal back stack so system back closes submenu first, then action bar
watch(
  () => props.visible,
  (newVal) => {
    if (!newVal) {
      expandedItem.value = null;
      if (IS_ANDROID && stackEntryId.value) {
        modalStack.remove(stackEntryId.value);
        stackEntryId.value = null;
      }
      return;
    }
    if (IS_ANDROID) {
      stackEntryId.value = modalStack.push(() => {
        if (expandedItem.value) {
          expandedItem.value = null;
        } else {
          emit("close");
        }
      });
    }
  },
  { immediate: true }
);

// Resolve actions with visibility filtering
const resolvedActions = computed(() => {
  return props.actions.filter((item) => {
    if (item.visible === undefined) return true;
    return item.visible(props.context);
  });
});

// Get visible children for expanded item
const expandedChildren = computed(() => {
  if (!expandedItem.value || !expandedItem.value.children) return [];
  
  const children: Array<ActionItem & { type?: "divider" }> = [];
  
  for (const child of expandedItem.value.children) {
    // Check visibility
    if (child.visible !== undefined && !child.visible(props.context)) {
      continue;
    }
    
    // Add divider before if needed
    const shouldShowDivider =
      typeof child.dividerBefore === "function"
        ? child.dividerBefore(props.context)
        : child.dividerBefore ?? false;
    if (shouldShowDivider && children.length > 0) {
      children.push({ key: `${child.key}_divider`, type: "divider" } as ActionItem & { type: "divider" });
    }
    
    children.push(child);
  }
  
  return children;
});

const getIcon = (item: ActionItem): Component => {
  const icon = item.icon;
  if (!icon) {
    // Return a placeholder component if no icon
    return {} as Component;
  }
  if (typeof icon === "function") {
    return (icon as (ctx: ActionContext) => Component)(props.context);
  }
  return icon;
};

const getLabel = (item: ActionItem): string => {
  const label = item.label;
  if (typeof label === "function") {
    return label(props.context);
  }
  return label;
};

const getChildIcon = (child: ActionItem): Component => {
  const icon = child.icon;
  if (!icon) {
    // Return a placeholder component if no icon
    return {} as Component;
  }
  if (typeof icon === "function") {
    return (icon as (ctx: ActionContext) => Component)(props.context);
  }
  return icon;
};

const getChildLabel = (child: ActionItem): string => {
  const label = child.label;
  if (typeof label === "function") {
    return label(props.context);
  }
  return label;
};

const getChildSuffix = (child: ActionItem): string => {
  const suffix = child.suffix;
  if (!suffix) return "";
  if (typeof suffix === "function") {
    return suffix(props.context);
  }
  return suffix;
};

const handleClick = (item: ActionItem) => {
  // If item has children, expand submenu instead of emitting command
  if (item.children && item.children.length > 0) {
    const visibleChildren = item.children.filter((child) => {
      if (child.visible === undefined) return true;
      return child.visible(props.context);
    });
    
    if (visibleChildren.length > 0) {
      expandedItem.value = item;
      return;
    }
  }
  
  // Otherwise, emit command as usual
  if (item.command) {
    emit("command", item.command);
  }
  emit("close");
};

const handleChildClick = (child: ActionItem) => {
  if (child.command) {
    emit("command", child.command);
  }
  expandedItem.value = null;
  emit("close");
};

const closeSubmenu = () => {
  expandedItem.value = null;
};
</script>

<style scoped lang="scss">
.action-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 12px 8px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
  background: var(--anime-bg-card);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 2100; /* 高于图片预览 modal（.image-preview-fullscreen 为 2000） */
  border-top: 1px solid var(--anime-border);
  box-shadow: 0 -4px 20px rgba(255, 107, 157, 0.12);
}

.action-sheet-button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 4px;
  border: none;
  background: transparent;
  color: var(--anime-text-primary);
  cursor: pointer;
  transition: opacity 0.2s ease, background 0.2s ease;
  min-width: 0;
  -webkit-tap-highlight-color: transparent;
}

.action-sheet-button:active {
  opacity: 0.85;
  background: rgba(255, 107, 157, 0.12);
}

.action-sheet-icon {
  font-size: 24px;
  margin-bottom: 2px;
}

.action-sheet-label {
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.action-sheet-slide-enter-active,
.action-sheet-slide-leave-active {
  transition: transform 0.2s ease-out, opacity 0.2s ease-out;
}

.action-sheet-slide-enter-from,
.action-sheet-slide-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* Submenu overlay */
.submenu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(74, 21, 75, 0.25);
  z-index: 2101; /* 高于主 action sheet (2100) */
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.submenu-panel {
  width: 100%;
  max-width: 100%;
  background: var(--anime-bg-card);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 8px 0;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  max-height: 60vh;
  overflow-y: auto;
  border-top: 1px solid var(--anime-border);
  box-shadow: var(--anime-shadow);
}

.submenu-item {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 14px 20px;
  border: none;
  background: transparent;
  color: var(--anime-text-primary);
  cursor: pointer;
  transition: background 0.15s ease;
  text-align: left;
  gap: 12px;
  -webkit-tap-highlight-color: transparent;
}

.submenu-item:active {
  background: rgba(255, 107, 157, 0.12);
}

.submenu-icon {
  font-size: 20px;
  flex-shrink: 0;
  color: var(--anime-text-secondary);
}

.submenu-label {
  flex: 1;
  font-size: 15px;
  line-height: 1.4;
}

.submenu-suffix {
  font-size: 13px;
  color: var(--anime-text-muted);
  margin-left: auto;
}

.submenu-divider {
  height: 1px;
  background: var(--anime-border);
  margin: 6px 20px;
}

.submenu-slide-enter-active,
.submenu-slide-leave-active {
  transition: opacity 0.2s ease-out;
}

.submenu-slide-enter-active .submenu-panel,
.submenu-slide-leave-active .submenu-panel {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.submenu-slide-enter-from {
  opacity: 0;
}

.submenu-slide-enter-from .submenu-panel {
  transform: translateY(100%);
}

.submenu-slide-leave-to {
  opacity: 0;
}

.submenu-slide-leave-to .submenu-panel {
  transform: translateY(100%);
}
</style>
