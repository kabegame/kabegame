<template>
  <!-- 设置是「左导航 + 右面板」的整体布局，正文贴边（去掉 Dialog 正文的内边距，滚动交给右面板） -->
  <Dialog
    v-model:open="open"
    :title="$t('settings.title')"
    width="min(1040px, calc(100vw - 80px))"
    body-class="!p-0 !overflow-hidden"
  >
    <Settings embedded />
  </Dialog>
</template>

<script setup lang="ts">
import Dialog from "@/components/ui/Dialog.vue";
import Settings from "@/views/Settings.vue";

/** 关闭时内容随 Reka 的 DialogContent 卸载（同原 destroy-on-close） */
const open = defineModel<boolean>("open", { default: false });
</script>
