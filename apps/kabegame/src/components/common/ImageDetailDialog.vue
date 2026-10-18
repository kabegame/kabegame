<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('gallery.imageDetailTitle')"
    width="min(1180px, 96vw)"
    class="image-detail-dialog"
    :class="{ 'is-stacked': stacked }"
    align-center
    append-to-body
    @update:model-value="
      (v: boolean) => {
        if (!v) emit('close');
      }
    "
  >
    <div class="image-detail-columns" :class="`is-${layout}`">
      <div class="detail-col-basic">
        <ImageBasicInfoPanel
          :image="image"
          :plugins="plugins"
          :collapsible="stacked"
          :fill-when-expanded="!stacked"
          @open-task="emit('open-task', $event)"
          @open-gallery-filter="emit('open-gallery-filter', $event)"
          @open-surf-record="emit('open-surf-record', $event)"
        />
      </div>
      <div v-if="image" class="detail-col-labels">
        <ImageLabelsPanel :image="image" @navigate="emit('close')" />
      </div>
      <!-- 面板壳恒定存在（无插件数据时显示空态），列不随内容有无出现/消失 -->
      <div class="detail-col-plugin">
        <ImagePluginDescriptionPanel :image="image" :collapsible="stacked" fill-when-expanded />
      </div>
      <div v-if="isNativeMetadataEligible(image?.type)" class="detail-col-meta">
        <ImageNativeMetadataPanel :image="image" :collapsible="stacked" :fill-when-expanded="!stacked" />
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import ImageBasicInfoPanel, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailSurfRecordTarget,
} from "./ImageBasicInfoPanel.vue";
import ImageNativeMetadataPanel from "./ImageNativeMetadataPanel.vue";
import ImagePluginDescriptionPanel from "./ImagePluginDescriptionPanel.vue";
import ImageLabelsPanel from "../image/ImageLabelsPanel.vue";
import type { ImageInfo } from "@/types/image";
import type { Plugin } from "@/stores/plugins";
import { useUiStore } from "../../stores/ui";
import { isNativeMetadataEligible } from "../../utils/mediaMime";

const { t } = useI18n();
const uiStore = useUiStore();
const { width: viewportWidth, height: viewportHeight } = useWindowSize();

/** 低于此视口高度（横屏手机）时并排放不下，退回可折叠的竖向堆叠，弹窗内滚动。 */
const STACK_MAX_VIEWPORT_HEIGHT = 560;
/** 四列并排的最小视口宽度：原生元数据列至少 340px，其余三列各需约 220px。 */
const ROW_MIN_VIEWPORT_WIDTH = 1200;

/**
 * 布局按可用空间决定，而不是只看 isCompact：横屏手机与竖屏平板都不紧凑，
 * 但四列等分后每列只剩一百多像素。
 * - stack：紧凑或矮屏，竖向堆叠、面板可折叠
 * - grid：中等宽度，2×2
 * - row：足够宽，四列并排
 */
const layout = computed<"stack" | "grid" | "row">(() => {
  if (uiStore.isCompact || viewportHeight.value < STACK_MAX_VIEWPORT_HEIGHT) return "stack";
  return viewportWidth.value >= ROW_MIN_VIEWPORT_WIDTH ? "row" : "grid";
});
const stacked = computed(() => layout.value === "stack");

interface Props {
  open: boolean;
  zIndex: number;
  image: ImageInfo | null;
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
/* 与 apps/kabegame CrawlerDialog 一致：限制整窗高度，仅 body 内滚动（teleport 到 body，需非 scoped）。
   上下边距让开状态栏 / 导航栏安全区，横屏手机上状态栏不再压住弹窗顶部。 */
.image-detail-dialog.el-dialog {
  --image-detail-gap: 2.5vh;
  --image-detail-max-height: calc(
    100vh - var(--sat, env(safe-area-inset-top, 0px)) - var(--sab, env(safe-area-inset-bottom, 0px)) -
      2 * var(--image-detail-gap)
  );
  width: min(1180px, 96vw) !important;
  height: auto !important;
  max-height: var(--image-detail-max-height) !important;
  display: flex !important;
  flex-direction: column !important;
  margin: calc(var(--sat, env(safe-area-inset-top, 0px)) + var(--image-detail-gap)) auto
    calc(var(--sab, env(safe-area-inset-bottom, 0px)) + var(--image-detail-gap)) !important;
  overflow: hidden !important;
}

.image-detail-dialog.el-dialog.is-stacked {
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
.image-detail-columns > .detail-col-labels,
.image-detail-columns > .detail-col-meta,
.image-detail-columns > .detail-col-plugin {
  display: flex;
  min-width: 0;
  flex: 1 1 0;
  flex-direction: column;
}

.image-detail-columns.is-row .detail-col-meta {
  min-width: 340px;
}

/* 中等宽度：基本信息 | 标签，插件详情 | 原生元数据；没有元数据列时插件详情占满整行。 */
.image-detail-columns.is-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* 并排时行高由最高的一列决定；给插件详情保底高度，避免被基本信息的行高压扁、弹窗下方却留白。 */
.image-detail-columns.is-row > .detail-col-plugin,
.image-detail-columns.is-grid > .detail-col-plugin {
  min-height: 60vh;
}

.image-detail-columns.is-grid > .detail-col-plugin:last-child {
  grid-column: 1 / -1;
}

.image-detail-columns.is-stack {
  flex-direction: column;
}

.image-detail-columns.is-stack > .detail-col-basic,
.image-detail-columns.is-stack > .detail-col-labels,
.image-detail-columns.is-stack > .detail-col-meta,
.image-detail-columns.is-stack > .detail-col-plugin {
  min-width: 0;
  flex: 0 0 auto;
}

/* 堆叠时滚到插件详情后，展开态拥有与整个弹窗相同的阅读高度；收起时不留下空白。 */
.image-detail-columns.is-stack .image-plugin-description-panel:not(.kb-collapsible-panel--collapsed) {
  height: var(--image-detail-max-height);
  flex: 0 0 var(--image-detail-max-height);
}
</style>
