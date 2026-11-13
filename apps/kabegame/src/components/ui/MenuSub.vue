<template>
  <DropdownMenuSub v-model:open="open">
    <DropdownMenuSubTrigger ref="triggerRef" :disabled="disabled" class="kb-menu-item data-[state=open]:bg-kb-hover">
      <slot name="trigger">{{ label }}</slot>
      <ChevronRight class="ml-auto !size-3.5" />
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal :to="portalTo">
      <DropdownMenuSubContent
        :side-offset="4"
        :align-offset="-4"
        :collision-padding="8"
        class="kb-menu-panel"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
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
import { computed, ref } from "vue";
import { DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "reka-ui";
import { ChevronRight } from "@lucide/vue";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex } from "./compat";

defineProps<{ label?: string; disabled?: boolean }>();

const open = ref(false);
const zIndex = useLayerZIndex(open);
// TODO:[REF_UI] P9 删：与父菜单挂在同一处（父菜单在 EP 对话框里时，子菜单也得在里面）
const triggerRef = ref<{ $el?: Element } | null>(null);
const portalTo = computed(() => (open.value ? foreignPortalTarget(triggerRef.value?.$el) : undefined));
</script>
