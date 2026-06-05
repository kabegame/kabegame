<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('gallery.imageDetailTitle')"
    width="600px"
    class="image-detail-dialog"
    align-center
    append-to-body
    @update:model-value="(v: boolean) => { if (!v) emit('close') }"
  >
    <ImageDetailContent
      :image="image"
      :plugins="plugins"
      @open-task="emit('open-task', $event)"
      @open-gallery-filter="emit('open-gallery-filter', $event)"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import ImageDetailContent, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailLike,
} from "./ImageDetailContent.vue";
import { Plugin } from "@kabegame/core/stores/plugins";

const { t } = useI18n();

interface Props {
  open: boolean;
  zIndex: number;
  image: ImageDetailLike | null;
  plugins?: Array<Plugin>;
}

interface Emits {
  (e: "open-task", taskId: string): void;
  (e: "open-gallery-filter", target: ImageDetailGalleryFilterTarget): void;
  (e: "close"): void;
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<style lang="scss">
/* 与 apps/kabegame CrawlerDialog 一致：限制整窗高度，仅 body 内滚动（teleport 到 body，需非 scoped） */
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
