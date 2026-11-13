<template>
  <DropdownMenuRadioGroup v-model="value">
    <DropdownMenuRadioItem
      v-for="item in items"
      :key="String(item.value)"
      :value="item.value"
      :disabled="item.disabled"
      class="kb-menu-item pl-8"
    >
      <span class="absolute left-2.5 inline-flex size-4 items-center justify-center">
        <DropdownMenuItemIndicator>
          <Check class="!text-kb-fg" />
        </DropdownMenuItemIndicator>
      </span>
      <slot name="item" :item="item">{{ item.label }}</slot>
    </DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>
</template>

<script setup lang="ts" generic="T extends string | number">
/** 菜单里的单选组（排序方式这类）：items 给选项，v-model 是选中的值。下拉菜单与右键菜单共用。 */
import { DropdownMenuItemIndicator, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "reka-ui";
import { Check } from "@lucide/vue";

defineProps<{ items: { label: string; value: T; disabled?: boolean }[] }>();
const value = defineModel<T>();
</script>
