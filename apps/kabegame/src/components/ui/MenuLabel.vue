<template>
  <DropdownMenuLabel class="px-2.5 pb-1 pt-1.5 text-[11.5px] font-500 text-kb-fg-subtle">
    <slot />
  </DropdownMenuLabel>
</template>

<script setup lang="ts">
/** 菜单里的分组小标题（下拉菜单与右键菜单共用） */
import { DropdownMenuLabel } from "reka-ui";
</script>
