<template>
  <Teleport to="body" :disabled="!teleport">
    <!-- Main action sheet -->
    <Transition :name="noTransition ? '' : 'action-sheet-slide'">
      <div v-if="visible && resolvedActions.length > 0 && !expandedItem" class="action-sheet" :style="actionSheetStyle">
        <button
          v-for="item in resolvedActions"
          :key="item.key"
          class="action-sheet-button"
          :class="[item.className, disabledClass(item)]"
          :disabled="isDisabled(item)"
          @click.stop="handleClick(item)"
        >
          <span class="action-sheet-icon">
            <component :is="getIcon(item)" />
          </span>
          <span class="action-sheet-label">
            {{ getLabel(item) }}
          </span>
          <span v-if="getSuffix(item)" class="max-w-full truncate text-[10px] leading-tight text-kb-fg-subtle">
            {{ getSuffix(item) }}
          </span>
        </button>
        <!-- Android: 全选/取消全选（写死在最右侧，不关闭 sheet） -->
        <button
          v-if="showSelectAllButton"
          type="button"
          class="action-sheet-button action-sheet-select-all"
          @click.stop="handleSelectAllClick"
        >
          <span class="action-sheet-icon">
            <component :is="selectAllButtonIcon" />
          </span>
          <span class="action-sheet-label">
            {{ selectAllButtonLabel }}
          </span>
        </button>
      </div>
    </Transition>

    <!-- Submenu overlay (when expandedItem has children) -->
    <Transition :name="noTransition ? '' : 'submenu-slide'">
      <div
        v-if="visible && expandedItem && expandedChildren.length > 0"
        class="submenu-overlay"
        :style="submenuOverlayStyle"
        @click.stop="closeSubmenu"
      >
        <div class="submenu-panel" @click.stop>
          <div v-for="child in expandedChildren" :key="child.key">
            <div
              v-if="
                child.type === 'divider' ||
                (typeof child.dividerBefore === 'function' ? child.dividerBefore(props.context) : child.dividerBefore)
              "
              class="submenu-divider"
            ></div>
            <button
              v-if="child.type !== 'divider'"
              class="submenu-item"
              :class="[child.className, disabledClass(child)]"
              :disabled="isDisabled(child)"
              @click.stop="handleChildClick(child)"
            >
              <span v-if="child.icon" class="submenu-icon">
                <component :is="getChildIcon(child)" />
              </span>
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
import { computed, markRaw, ref, toRaw, watch, type Component, type CSSProperties } from "vue";
import { CheckCheck, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { resolveActionIcon, type ActionItem, type ActionContext } from "../actions/types";
import { useModal } from "../composables/useModal";
import { useUiStore } from "../stores/ui";

interface Props {
  visible: boolean;
  actions: ActionItem[];
  context: ActionContext;
  /** Whether to teleport to body. Default true. */
  teleport?: boolean;
  /** Whether to disable transition animations. Default false. */
  noTransition?: boolean;
  modalBack?: boolean;
  /** Override z-index of the action sheet. Defaults to the modal counter. */
  zIndex?: number;
}

const props = withDefaults(defineProps<Props>(), {
  teleport: true,
  noTransition: false,
  modalBack: true,
});

const emit = defineEmits<{
  command: [command: string];
  close: [];
}>();

const { t } = useI18n();

// Track which item's submenu is expanded
const expandedItem = ref<ActionItem | null>(null);

// Android: sheet is parent-controlled; submenu uses useModal for back-stack ordering.
const sheetModal = useModal({
  onClose: () => {
    expandedItem.value = null;
    if (props.modalBack) emit("close");
  },
});
watch(
  () => props.visible && (props.modalBack || props.zIndex == null),
  (v) => (v ? sheetModal.open() : sheetModal.close()),
  { immediate: true },
);
const submenuModal = useModal({
  onClose: () => {
    expandedItem.value = null;
  },
});
watch(
  () => !!expandedItem.value,
  (v) => (v ? submenuModal.open() : submenuModal.close()),
);
const actionSheetZIndex = computed(() => props.zIndex ?? sheetModal.zIndex.value);
const submenuOverlayZIndex = computed(() => submenuModal.zIndex.value || actionSheetZIndex.value + 10);
const actionSheetStyle = computed<CSSProperties>(() => ({
  zIndex: actionSheetZIndex.value,
}));
const submenuOverlayStyle = computed<CSSProperties>(() => ({
  zIndex: submenuOverlayZIndex.value,
}));

// Resolve actions with visibility filtering
const resolvedActions = computed(() => {
  return props.actions.filter((item) => {
    if (item.visible === undefined) return true;
    return item.visible(props.context);
  });
});

const uiStore = useUiStore();
// 紧凑模式（Android/web 窄屏）：全选/取消全选按钮（仅当 totalCount 有值且已有选中时显示）
const showSelectAllButton = computed(
  () => uiStore.isCompact && props.context.totalCount != null && props.context.selectedCount >= 1,
);

const isAllSelected = computed(
  () => props.context.totalCount != null && props.context.selectedCount >= props.context.totalCount,
);

const selectAllButtonLabel = computed(() => (isAllSelected.value ? t("common.deselectAll") : t("common.selectAll")));

const selectAllButtonIcon = computed<Component>(() => (isAllSelected.value ? X : CheckCheck));

const handleSelectAllClick = () => {
  emit("command", isAllSelected.value ? "deselectAll" : "selectAll");
  // 不 emit("close")，保持 ActionSheet 打开
};

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
      typeof child.dividerBefore === "function" ? child.dividerBefore(props.context) : (child.dividerBefore ?? false);
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
  // 不能按 typeof === "function" 判解析器：lucide 图标本身是函数式组件（见 actions/types.ts 的 iconBy）
  const comp = resolveActionIcon(icon, props.context) ?? ({} as Component);
  // toRaw: item may come from reactive props.actions, so icon can be a reactive proxy
  return markRaw(toRaw(comp));
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
  // 不能按 typeof === "function" 判解析器：lucide 图标本身是函数式组件（见 actions/types.ts 的 iconBy）
  const comp = resolveActionIcon(icon, props.context) ?? ({} as Component);
  // toRaw: child may come from reactive props.actions, so icon can be a reactive proxy
  return markRaw(toRaw(comp));
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

const getSuffix = (item: ActionItem): string => getChildSuffix(item);

const isDisabled = (item: ActionItem): boolean =>
  typeof item.disabled === "function" ? item.disabled(props.context) : (item.disabled ?? false);

const disabledClass = (item: ActionItem): string =>
  isDisabled(item) ? "!cursor-not-allowed !opacity-45 active:!bg-transparent" : "";

const handleClick = (item: ActionItem) => {
  if (isDisabled(item)) return;
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
  if (isDisabled(child)) return;
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
  padding: 10px 8px;
  padding-bottom: calc(10px + var(--sab, env(safe-area-inset-bottom, 0px)));
  background: var(--kb-surface);
  backdrop-filter: blur(16px) saturate(1.5);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  border-top: 1px solid var(--kb-line);
  box-shadow: 0 -8px 24px -12px rgba(16, 14, 20, 0.18);
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
  border-radius: var(--kb-radius-md);
  background: transparent;
  color: var(--kb-fg);
  font: inherit;
  cursor: pointer;
  transition: background 0.15s ease;
  min-width: 0;
  -webkit-tap-highlight-color: transparent;
}

.action-sheet-button:active {
  background: var(--kb-pressed);
}

.action-sheet-icon {
  display: inline-flex;
  margin-bottom: 2px;
  color: var(--kb-fg-muted);

  :deep(svg) {
    width: 22px;
    height: 22px;
  }
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
  transition:
    transform 0.22s var(--kb-ease-out),
    opacity 0.2s ease-out;
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
  background: var(--kb-overlay);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.submenu-panel {
  width: 100%;
  max-width: 100%;
  background: var(--kb-surface-raised);
  border-top-left-radius: var(--kb-radius-lg);
  border-top-right-radius: var(--kb-radius-lg);
  padding: 6px;
  padding-bottom: calc(6px + var(--sab, env(safe-area-inset-bottom, 0px)));
  max-height: 60vh;
  overflow-y: auto;
  box-shadow: var(--kb-shadow-lg);
}

.submenu-item {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 12px 14px;
  border: none;
  border-radius: var(--kb-radius-md);
  background: transparent;
  color: var(--kb-fg);
  font: inherit;
  cursor: pointer;
  transition: background 0.15s ease;
  text-align: left;
  gap: 12px;
  -webkit-tap-highlight-color: transparent;
}

.submenu-item:active {
  background: var(--kb-pressed);
}

.submenu-icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--kb-fg-muted);

  :deep(svg) {
    width: 20px;
    height: 20px;
  }
}

.submenu-label {
  flex: 1;
  font-size: 15px;
  line-height: 1.4;
}

.submenu-suffix {
  font-size: 13px;
  color: var(--kb-fg-subtle);
  margin-left: auto;
}

.submenu-divider {
  height: 1px;
  background: var(--kb-line);
  margin: 4px 14px;
}

.submenu-slide-enter-active,
.submenu-slide-leave-active {
  transition: opacity 0.2s ease-out;
}

.submenu-slide-enter-active .submenu-panel,
.submenu-slide-leave-active .submenu-panel {
  transition: transform 0.26s var(--kb-ease-out);
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
