<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :collision-padding="8"
      :reference="root.triggerElement.value"
      class="kb-menu-panel"
      :style="{ zIndex }"
      @focus-outside="keepOpenOnToast"
      @interact-outside="keepOpenOnToast"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>

<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal, injectDropdownMenuRootContext } from "reka-ui";
import { useLayerZIndex, keepOpenOnToast } from "./layer";

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
</script>
