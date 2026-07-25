<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('gallery.imageDetailTitle')"
    width="min(1180px, 96vw)"
    class="image-detail-dialog"
    :class="{ 'is-compact': isCompact }"
    align-center
    append-to-body
    @update:model-value="(v: boolean) => { if (!v) emit('close') }"
  >
    <div class="image-detail-columns" :class="{ 'is-compact': isCompact }">
      <div class="detail-col-basic">
        <ImageBasicInfoPanel
          :image="image"
          :plugins="plugins"
          :collapsible="isCompact"
          :fill-when-expanded="!isCompact"
          @open-task="emit('open-task', $event)"
          @open-gallery-filter="emit('open-gallery-filter', $event)"
          @open-surf-record="emit('open-surf-record', $event)"
        />
      </div>
      <div
        v-if="isNativeMetadataEligible(image?.type)"
        class="detail-col-meta"
      >
        <ImageNativeMetadataPanel
          :image="image"
          :collapsible="isCompact"
          :fill-when-expanded="!isCompact"
        />
      </div>
      <!-- 面板壳恒定存在（无插件数据时内容区为空），列不随内容有无出现/消失 -->
      <div class="detail-col-plugin">
        <ImagePluginDescriptionPanel
          :image="image"
          :collapsible="isCompact"
          :fill-when-expanded="!isCompact"
        />
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import ImageBasicInfoPanel, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailLike,
  type ImageDetailSurfRecordTarget,
} from "./ImageBasicInfoPanel.vue";
import ImageNativeMetadataPanel from "./ImageNativeMetadataPanel.vue";
import ImagePluginDescriptionPanel from "./ImagePluginDescriptionPanel.vue";
import type { Plugin } from "@kabegame/core/stores/plugins";
import { useUiStore } from "../../stores/ui";
import { isNativeMetadataEligible } from "../../utils/mediaMime";

const { t } = useI18n();
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

interface Props {
  open: boolean;
  zIndex: number;
  image: ImageDetailLike | null;
  plugins?: Array<Plugin>;
}

interface Emits {
  (e: "open-task", taskId: string): void;
  (e: "open-gallery-filter", target: ImageDetailGalleryFilterTarget): void;
  (e: "open-surf-record", target: ImageDetailSurfRecordTarget): void;
  (e: "close"): void;
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<style lang="scss">
/* 与 apps/kabegame CrawlerDialog 一致：限制整窗高度，仅 body 内滚动（teleport 到 body，需非 scoped） */
.image-detail-dialog.el-dialog {
  width: min(1180px, 96vw) !important;
  height: auto !important;
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin: 5vh auto !important;
  overflow: hidden !important;
}

.image-detail-dialog.el-dialog.is-compact {
  width: 95vw !important;
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

.image-detail-columns {
  display: flex;
  min-width: 0;
  align-items: stretch;
  flex-direction: row;
  gap: 12px;
}

.image-detail-columns > .detail-col-basic,
.image-detail-columns > .detail-col-meta,
.image-detail-columns > .detail-col-plugin {
  display: flex;
  min-width: 0;
  flex: 1 1 0;
  flex-direction: column;
}

.image-detail-columns .detail-col-meta {
  min-width: 340px;
}

.image-detail-columns.is-compact {
  flex-direction: column;
}

.image-detail-columns.is-compact > .detail-col-basic,
.image-detail-columns.is-compact > .detail-col-meta,
.image-detail-columns.is-compact > .detail-col-plugin {
  min-width: 0;
  flex: 0 0 auto;
}
</style>
