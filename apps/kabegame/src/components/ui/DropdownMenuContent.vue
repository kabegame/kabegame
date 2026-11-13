<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :collision-padding="8"
      :reference="root.triggerElement.value"
      class="z-[var(--kb-z-popover)] box-border min-w-[184px] overflow-hidden rounded-kb-lg bg-kb-surface-raised p-1 shadow-kb-pop outline-none origin-[var(--reka-popper-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>

<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal, injectDropdownMenuRootContext } from "reka-ui";

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
</script>
