<template>
  <DropdownMenuSub v-model:open="open">
    <DropdownMenuSubTrigger :disabled="disabled" class="kb-menu-item data-[state=open]:bg-kb-hover">
      <slot name="trigger">{{ label }}</slot>
      <ChevronRight class="ml-auto !size-3.5" />
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent
        :side-offset="4"
        :align-offset="-4"
        :collision-padding="8"
        class="kb-menu-panel"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
      >
        <slot />
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>
</template>

<script setup lang="ts">
/**
 * 子菜单：触发行（label 或 #trigger）+ 子项（默认插槽）。悬停或方向键右展开。
 * 下拉菜单与右键菜单共用。
 */
import { ref } from "vue";
import { DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "reka-ui";
import { ChevronRight } from "@lucide/vue";
import { useLayerZIndex, keepOpenOnToast } from "./layer";

defineProps<{ label?: string; disabled?: boolean }>();

const open = ref(false);
const zIndex = useLayerZIndex(open);
</script>
