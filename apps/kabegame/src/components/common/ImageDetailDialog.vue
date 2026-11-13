<template>
  <!-- 只在 Android 用（桌面的详情在预览两侧栏里）。宽度按布局给；正文区自己滚动 -->
  <Dialog
    :open="open"
    :title="t('gallery.imageDetailTitle')"
    :width="stacked ? '95vw' : 'min(1180px, 96vw)'"
    body-class="image-detail-body"
    @update:open="(v: boolean) => !v && emit('close')"
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
          @open-color-sort="emit('open-color-sort', $event)"
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
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { Dialog } from "@/components/ui";
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
  image: ImageInfo | null;
  plugins?: Array<Plugin>;
}

interface Emits {
  (e: "open-task", taskId: string): void;
  (e: "open-gallery-filter", target: ImageDetailGalleryFilterTarget): void;
  (e: "open-color-sort", hex: string): void;
  (e: "open-surf-record", target: ImageDetailSurfRecordTarget): void;
  (e: "close"): void;
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<style lang="scss">
/* 对话框本身由 ui/Dialog 限高（视口减去上下边距），这里只排列四个面板；teleport 到 body，需非 scoped。
   堆叠时插件详情展开后要有一屏的阅读高度，用的就是对话框的最大高度。 */
.image-detail-body {
  --image-detail-max-height: min(85vh, calc(100vh - 32px));
  padding-top: 8px;
  padding-bottom: 20px;
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
