<template>
  <!-- 样式与项目其他 el-dialog 保持一致：标题 / 关闭叉号 / 遮罩 / 圆角均用自带的，不自绘 -->
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    append-to-body
    destroy-on-close
    :title="$t('settings.title')"
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    class="settings-dialog-shell"
    @update:model-value="onModelValue"
  >
    <Settings embedded />
  </el-dialog>
</template>

<script setup lang="ts">
import Settings from "@/views/Settings.vue";

defineProps<{
  open: boolean;
  zIndex: number;
}>();

const emit = defineEmits<{
  close: [];
}>();

function onModelValue(value: boolean) {
  if (!value) emit("close");
}
</script>

<style lang="scss">
.settings-dialog-shell.el-dialog {
  width: min(1040px, calc(100vw - 80px));
  overflow: hidden;

  // 设置是「左导航 + 右面板」的整体布局，需要贴边，故取消 dialogs.css 给 body 的通用内边距
  .el-dialog__body {
    padding: 0 !important;
  }
}
</style>
