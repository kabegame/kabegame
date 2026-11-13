<template>
  <DropdownMenuPortal :to="portalTo">
    <DropdownMenuContent
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :collision-padding="8"
      :reference="root.triggerElement.value"
      class="kb-menu-panel"
      :style="{ zIndex }"
      @focus-outside="keepOpenOnForeign"
      @interact-outside="keepOpenOnForeign"
      @close-auto-focus="(e: Event) => keepFocusForForeign(e, root.triggerElement.value)"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { DropdownMenuContent, DropdownMenuPortal, injectDropdownMenuRootContext } from "reka-ui";
import {
  foreignPortalTarget,
  keepFocusForForeign,
  keepOpenOnForeign,
  useLayerZIndex,
  usePauseForeignTraps,
} from "./compat";

withDefaults(
  defineProps<{
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
  }>(),
  { side: "bottom", align: "end", sideOffset: 6 },
);

// 显式按触发器元素定位：触发器外面常套一层 Tooltip，而 Tooltip 自己也是一个 Popper，
// 触发器默认的锚点登记会被就近的 Tooltip 收走，菜单就停在 (0,0) 不动。
const root = injectDropdownMenuRootContext();
const zIndex = useLayerZIndex(root.open);
usePauseForeignTraps(root.open); // TODO:[REF_UI] P9 删
// TODO:[REF_UI] P9 删：触发器在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(
  root.open,
  (open) => {
    if (open) portalTo.value = foreignPortalTarget(root.triggerElement.value ?? document.activeElement);
  },
  { immediate: true },
);
</script>
