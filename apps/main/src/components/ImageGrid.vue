<template>
  <CoreImageGrid ref="coreRef" v-bind="coreGridBind" :window-aspect-ratio="props.windowAspectRatio"
    :on-context-command="handleContextCommand" @scroll-stable="$emit('scroll-stable')"
    @retry-download="(p) => $emit('retry-download', p)">
    <template #before-grid>
      <slot name="before-grid" />
    </template>
    <template #footer>
      <slot name="footer" />
    </template>
    <template #empty>
      <slot name="empty">
        <EmptyState />
      </slot>
    </template>
  </CoreImageGrid>

  <!-- 详情弹窗：保持 main 旧行为（view 层仍可 return 'detail'） -->
  <ImageDetailDialog v-model="showImageDetail" :image="detailImage" :plugins="plugins" />
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";
import CoreImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import type { ImageInfo } from "@/stores/crawler";
import type { ImageInfo as CoreImageInfo } from "@kabegame/core/types/image";
import ImageDetailDialog from "@kabegame/core/components/common/ImageDetailDialog.vue";
import { usePluginStore } from "@/stores/plugins";
import EmptyState from "@/components/common/EmptyState.vue";

import type {
  ContextCommand as CoreContextCommand,
  ContextCommandPayload as CoreContextCommandPayload,
} from "@kabegame/core/components/image/ImageGrid.vue";

// 扩展 ContextCommand 类型，添加 app-main 特有的命令
export type ContextCommand = CoreContextCommand | "favorite" | "addToAlbum";

// 扩展 ContextCommandPayload 类型
// 对于扩展命令，payload 结构与 core 一致，只是 command 字段不同
export type ContextCommandPayload<T extends ContextCommand = ContextCommand> =
  T extends "favorite" | "addToAlbum"
  ? Omit<CoreContextCommandPayload, "command"> & { command: T }
  : CoreContextCommandPayload;

// 本组件是 fragment root（含详情弹窗），需要显式透传 attrs（class/style 等）到 CoreImageGrid
defineOptions({ inheritAttrs: false });

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
  contextMenuComponent?: any;
  onContextCommand?: (
    payload: ContextCommandPayload
  ) =>
    | ContextCommand
    | null
    | undefined
    | Promise<ContextCommand | null | undefined>;
  showEmptyState?: boolean;
  loading?: boolean; // 加载状态：为 true 时不显示空状态
  loadingOverlay?: boolean; // 加载遮罩：仅覆盖 grid 区域；不传则默认等同于 loading
  enableCtrlWheelAdjustColumns?: boolean;
  enableCtrlKeyAdjustColumns?: boolean;
  hideScrollbar?: boolean;
  scrollStableDelay?: number;
  enableScrollStableEmit?: boolean;
  enableVirtualScroll?: boolean;
  virtualOverscan?: number;
  windowAspectRatio?: number; // 外部传入的窗口宽高比（可选）
}

const props = defineProps<Props>();
defineEmits<{
  "scroll-stable": [];
  // 兼容旧 API：右键已移除加入画册，但保留事件名不破坏上层模板
  addedToAlbum: [];
  // 注意：事件来自 core ImageGrid，因此 image 类型应与 core 对齐（url 在 core 为可选）
  "retry-download": [payload: { image: CoreImageInfo }];
}>();

const attrs = useAttrs();
const coreGridBind = computed(() => ({ ...attrs, ...props }));

const coreRef = ref<any>(null);

// 旧 ImageGrid 的"内置详情弹窗"改为 wrapper 层实现
const showImageDetail = ref(false);
const detailImage = ref<CoreImageInfo | null>(null);

const pluginStore = usePluginStore();
const plugins = computed(() => pluginStore.plugins);

async function handleContextCommand(payload: CoreContextCommandPayload): Promise<CoreContextCommand | null | undefined> {
  // 先调用 app-main 的 handler（可能处理扩展命令或 core 命令）
  const res = await props.onContextCommand?.(payload as ContextCommandPayload);

  // 如果是扩展命令（favorite/addToAlbum），不传递给 core，直接返回
  if (res === "favorite" || res === "addToAlbum") {
    return null; // core 不处理扩展命令
  }

  // 兼容：view 层如果 return 'detail'，则在 wrapper 内打开详情弹窗
  if (res === "detail") {
    // payload.image 是 CoreImageInfo（url 可选），直接赋值即可
    detailImage.value = payload.image;
    showImageDetail.value = true;
  }

  // 将 core 命令的结果返回给 core
  return res as CoreContextCommand | null | undefined;
}

defineExpose({
  getContainerEl: () => coreRef.value?.getContainerEl?.(),
  getSelectedIds: () => coreRef.value?.getSelectedIds?.(),
  clearSelection: () => coreRef.value?.clearSelection?.(),
});
</script>
