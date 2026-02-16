<template>
  <!-- Desktop: Context Menu -->
  <ContextMenu
    v-if="renderMode === 'contextmenu'"
    :visible="visible"
    :position="position"
    :items="menuItems"
    @close="$emit('close')"
    @command="handleCommand" />

  <!-- Android: Action Sheet -->
  <ActionSheet
    v-else-if="renderMode === 'actionsheet'"
    :visible="visible"
    :actions="actions"
    :context="context"
    @close="$emit('close')"
    @command="handleCommand" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";
import ActionSheet from "./ActionSheet.vue";
import type { ActionItem, ActionContext } from "../actions/types";
import { IS_ANDROID } from "../env";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  /** Accept any ActionItem<T>[] so callers can pass ActionItem<ImageInfo>[], ActionItem<Album>[], etc. */
  actions: ActionItem<any>[];
  context: ActionContext<any>;
  /** Override render mode: 'auto' uses platform detection, 'contextmenu' forces context menu, 'actionsheet' forces action sheet */
  mode?: "auto" | "contextmenu" | "actionsheet";
}

const props = withDefaults(defineProps<Props>(), {
  mode: "auto",
});

const emit = defineEmits<{
  close: [];
  command: [command: string];
}>();

const renderMode = computed<"contextmenu" | "actionsheet">(() => {
  if (props.mode === "contextmenu") return "contextmenu";
  if (props.mode === "actionsheet") return "actionsheet";
  // Auto mode: Android uses action sheet, desktop uses context menu
  return IS_ANDROID ? "actionsheet" : "contextmenu";
});

// Convert ActionItem[] to MenuItem[] for ContextMenu compatibility
const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];
  
  for (const action of props.actions) {
    // Check visibility
    if (action.visible !== undefined && !action.visible(props.context)) {
      continue;
    }

    // Add divider if needed
    const shouldShowDivider =
      typeof action.dividerBefore === "function"
        ? action.dividerBefore(props.context)
        : action.dividerBefore ?? false;
    if (shouldShowDivider && items.length > 0) {
      items.push({
        key: `${action.key}_divider`,
        type: "divider",
      });
    }

    // Resolve label
    const label = typeof action.label === "function" ? action.label(props.context) : action.label;
    
    //@ts-expect-error Resolve icon
    const icon = typeof action.icon === "function" ? action.icon(props.context) : action.icon;
    
    // Resolve suffix
    const suffix = typeof action.suffix === "function" ? action.suffix(props.context) : action.suffix;

    // Convert children if present
    const children: MenuItem[] | undefined = action.children
      ? action.children
          .filter((child) => child.visible === undefined || child.visible(props.context))
          .map((child) => ({
            key: child.key,
            type: "item" as const,
            label: typeof child.label === "function" ? child.label(props.context) : child.label,
            //@ts-expect-error Resolve icon
            icon: typeof child.icon === "function" ? child.icon(props.context) : child.icon,
            command: child.command,
            className: child.className,
            suffix: typeof child.suffix === "function" ? child.suffix(props.context) : child.suffix,
          }))
      : undefined;

    items.push({
      key: action.key,
      type: "item",
      label,
      icon,
      command: action.command,
      className: action.className,
      suffix,
      children,
    });
  }

  return items;
});

const handleCommand = (command: string) => {
  emit("command", command);
};
</script>

<style scoped lang="scss">
// Styles are handled by child components
</style>
