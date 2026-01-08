<template>
  <CoreImageGrid
    ref="coreRef"
    v-bind="props"
    :on-context-command="handleContextCommand"
    @scroll-stable="$emit('scroll-stable')"
    @reorder="(p) => $emit('reorder', p)"
  >
    <template #before-grid><slot name="before-grid" /></template>
    <template #footer><slot name="footer" /></template>
  </CoreImageGrid>

  <!-- 详情弹窗：保持 main 旧行为（view 层仍可 return 'detail'） -->
  <ImageDetailDialog v-model="showImageDetail" :image="detailImage" />
</template>

<script setup lang="ts">
import { ref } from "vue";
import CoreImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import type { ImageInfo } from "@/stores/crawler";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";

export type { ContextCommand, ContextCommandPayload } from "@kabegame/core/components/image/ImageGrid.vue";

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
  contextMenuComponent?: any;
  onContextCommand?: (
    payload: import("@kabegame/core/components/image/ImageGrid.vue").ContextCommandPayload
  ) =>
    | import("@kabegame/core/components/image/ImageGrid.vue").ContextCommand
    | null
    | undefined
    | Promise<
        import("@kabegame/core/components/image/ImageGrid.vue").ContextCommand | null | undefined
      >;
  showEmptyState?: boolean;
  canReorder?: boolean;
  enableCtrlWheelAdjustColumns?: boolean;
  enableCtrlKeyAdjustColumns?: boolean;
  hideScrollbar?: boolean;
  scrollStableDelay?: number;
  enableScrollStableEmit?: boolean;
  enableVirtualScroll?: boolean;
  virtualOverscan?: number;
}

const props = defineProps<Props>();
defineEmits<{
  "scroll-stable": [];
  // 兼容旧 API：右键已移除加入画册，但保留事件名不破坏上层模板
  addedToAlbum: [];
  reorder: [payload: { aId: string; aOrder: number; bId: string; bOrder: number }];
}>();

const coreRef = ref<any>(null);

// 旧 ImageGrid 的“内置详情弹窗”改为 wrapper 层实现
const showImageDetail = ref(false);
const detailImage = ref<ImageInfo | null>(null);

async function handleContextCommand(payload: any) {
  const res = await props.onContextCommand?.(payload);
  // 兼容：view 层如果 return 'detail'，则在 wrapper 内打开详情弹窗
  if (res === "detail") {
    detailImage.value = payload.image;
    showImageDetail.value = true;
  }
  return res;
}

defineExpose({
  getContainerEl: () => coreRef.value?.getContainerEl?.(),
  getSelectedIds: () => coreRef.value?.getSelectedIds?.(),
  clearSelection: () => coreRef.value?.clearSelection?.(),
  exitReorderMode: () => coreRef.value?.exitReorderMode?.(),
});
</script>


