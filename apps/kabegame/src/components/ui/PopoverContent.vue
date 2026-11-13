<template>
  <PopoverPortal :to="portalTo">
    <PopoverContent
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :align-offset="alignOffset"
      :collision-padding="8"
      :reference="reference"
      class="box-border max-h-[var(--reka-popover-content-available-height)] overflow-y-auto rounded-kb-lg bg-kb-surface-raised p-1.5 text-kb-fg shadow-kb-pop outline-none origin-[var(--reka-popover-content-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]"
      :style="width ? { zIndex, width: `${width}px` } : { zIndex }"
      @focus-outside="keepOpenOnForeign"
      @interact-outside="keepOpenOnForeign"
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { PopoverContent, PopoverPortal, injectPopoverRootContext } from "reka-ui";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";

const props = withDefaults(
  defineProps<{
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
    alignOffset?: number;
    /** 固定宽度（px）；不给按内容 */
    width?: number;
    /** 锚在这个元素上（没有触发器的浮层，如锚在列表某一行的编辑浮层）；不给按触发器 / PopoverAnchor */
    anchor?: HTMLElement;
  }>(),
  { side: "bottom", align: "center", sideOffset: 6, alignOffset: 0 },
);

// 没有 PopoverAnchor 时显式按触发器元素定位：触发器外面常套一层 Tooltip，Tooltip 自己也是一个 Popper，
// 触发器默认的锚点登记会被就近的 Tooltip 收走，浮层就停在 (0,0) 不动。
const root = injectPopoverRootContext();
const reference = computed(() => props.anchor ?? (root.hasCustomAnchor.value ? undefined : root.triggerElement.value));
const zIndex = useLayerZIndex(root.open);
usePauseForeignTraps(root.open); // TODO:[REF_UI] P9 删
// TODO:[REF_UI] P9 删：触发器在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(
  root.open,
  (open) => {
    if (open) portalTo.value = foreignPortalTarget(props.anchor ?? root.triggerElement.value ?? document.activeElement);
  },
  { immediate: true },
);
</script>
