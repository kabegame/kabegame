<template>
  <PopoverRoot v-model:open="open" :modal="modal">
    <slot :open="open" />
  </PopoverRoot>
</template>

<script setup lang="ts">
/**
 * 气泡卡片根：开关状态接进 Android 返回栈（useModalBack）。
 * 子组件：PopoverTrigger（as-child 包一个按钮）、PopoverContent；需要锚在别处时用 PopoverAnchor。
 * 默认非模态：工具箱、后台任务这类面板打开时页面其余部分照常可点，点外部即关。
 */
import { PopoverRoot } from "reka-ui";
import { useModalBack } from "@/composables/useModalBack";

withDefaults(defineProps<{ modal?: boolean }>(), { modal: false });

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
</script>
