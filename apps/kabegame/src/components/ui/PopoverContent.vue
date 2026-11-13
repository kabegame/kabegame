<template>
  <PopoverPortal>
    <PopoverContent
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :align-offset="alignOffset"
      :collision-padding="8"
      :reference="reference"
      class="z-[var(--kb-z-popover)] box-border max-h-[var(--reka-popover-content-available-height)] overflow-y-auto rounded-kb-lg bg-kb-surface-raised p-1.5 text-kb-fg shadow-kb-pop outline-none origin-[var(--reka-popover-content-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]"
      :style="width ? { width: `${width}px` } : undefined"
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { PopoverContent, PopoverPortal, injectPopoverRootContext } from "reka-ui";

withDefaults(
  defineProps<{
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
    alignOffset?: number;
    /** 固定宽度（px）；不给按内容 */
    width?: number;
  }>(),
  { side: "bottom", align: "center", sideOffset: 6, alignOffset: 0 },
);

// 没有 PopoverAnchor 时显式按触发器元素定位：触发器外面常套一层 Tooltip，Tooltip 自己也是一个 Popper，
// 触发器默认的锚点登记会被就近的 Tooltip 收走，浮层就停在 (0,0) 不动。
const root = injectPopoverRootContext();
const reference = computed(() => (root.hasCustomAnchor.value ? undefined : root.triggerElement.value));
</script>
