<template>
  <el-dialog
    v-model="visible"
    :title="t('gallery.imageDetailTitle')"
    width="600px"
    class="image-detail-dialog"
    align-center
  >
    <ImageDetailContent
      :image="image"
      :plugins="plugins"
      @open-task="emit('open-task', $event)"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "../../composables/useModalBack";
import ImageDetailContent, { type ImageDetailLike } from "./ImageDetailContent.vue";

const { t } = useI18n();

interface Props {
  modelValue: boolean;
  image: ImageDetailLike | null;
  plugins?: Array<{ id: string; name?: string }>;
}

interface Emits {
  (e: "update:modelValue", value: boolean): void;
  (e: "open-task", taskId: string): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

useModalBack(visible);
</script>

<style lang="scss">
/* 与 apps/main CrawlerDialog 一致：限制整窗高度，仅 body 内滚动（teleport 到 body，需非 scoped） */
.image-detail-dialog.el-dialog {
  height: auto !important;
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin: 5vh auto !important;
  overflow: hidden !important;
}

.image-detail-dialog .el-dialog__header {
  flex-shrink: 0 !important;
  padding: 16px 20px 10px !important;
}

.image-detail-dialog .el-dialog__body {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  padding: 8px 20px 20px !important;
}
</style>
