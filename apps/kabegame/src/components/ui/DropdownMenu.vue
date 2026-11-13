<template>
  <DropdownMenuRoot v-model:open="open" :modal="modal">
    <slot :open="open" />
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
/**
 * 下拉菜单根：开关状态接进 Android 返回栈（useModalBack），调用方不用再各自接。
 * 子组件：DropdownMenuTrigger（as-child 包一个 Button）、DropdownMenuContent、DropdownMenuItem、
 * DropdownMenuSeparator，从 "@/components/ui" 导入。
 */
import { DropdownMenuRoot } from "reka-ui";
import { useModalBack } from "@/composables/useModalBack";

withDefaults(
  defineProps<{
    /** 模态：打开期间外部不可点、第一次点外部只关菜单（不会顺带点中底下的图） */
    modal?: boolean;
  }>(),
  { modal: true },
);

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
</script>
