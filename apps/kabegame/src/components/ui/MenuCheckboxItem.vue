<template>
  <DropdownMenuCheckboxItem v-model="checked" :disabled="disabled" class="kb-menu-item pl-8" @select="onSelect">
    <span class="absolute left-2.5 inline-flex size-4 items-center justify-center">
      <DropdownMenuItemIndicator>
        <Check class="!text-kb-fg" />
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuCheckboxItem>
</template>

<script setup lang="ts">
/**
 * 可勾选的菜单项（v-model 布尔）。keepOpen 时勾选后菜单不关（连续勾多项）。
 * 下拉菜单与右键菜单共用。
 */
import { DropdownMenuCheckboxItem, DropdownMenuItemIndicator } from "reka-ui";
import { Check } from "@lucide/vue";

const props = defineProps<{ disabled?: boolean; keepOpen?: boolean }>();
const checked = defineModel<boolean>({ default: false });

function onSelect(e: Event) {
  if (props.keepOpen) e.preventDefault();
}
</script>
