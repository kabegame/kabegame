<template>
  <CoreImageGrid
    ref="coreRef"
    v-bind="coreGridBind"
    :window-aspect-ratio="props.windowAspectRatio"
    :on-context-command="handleContextCommand"
    @open-task="handleOpenTask"
    @image-dblclick="$emit('image-dblclick', $event)"
    @preview-open="handlePreviewOpen"
    @preview-navigate="handlePreviewNavigate"
    @preview-page-boundary="$emit('preview-page-boundary', $event)"
    @preview-detail-toggle="$emit('preview-detail-toggle', $event)"
    @preview-close="handlePreviewClose"
    @open-gallery-filter="handleOpenGalleryFilter"
  >
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
  <ImageDetailDialog
    :open="imageDetailDialog.isOpen.value"
    :z-index="imageDetailDialog.zIndex.value"
    :image="detailImage"
    :plugins="plugins"
    @close="imageDetailDialog.close()"
    @open-task="handleOpenTask"
    @open-gallery-filter="handleOpenGalleryFilter"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, useAttrs, watch } from "vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useRouter } from "vue-router";
import CoreImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import type { ImageInfo as CoreImageInfo } from "@kabegame/core/types/image";
import ImageDetailDialog from "@kabegame/core/components/common/ImageDetailDialog.vue";
import type { ImageDetailGalleryFilterTarget } from "@kabegame/core/components/common/ImageDetailContent.vue";
import { usePluginStore } from "@/stores/plugins";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { singleFilterToSet, type GalleryFilter, type GalleryFilterSet } from "@/utils/galleryPath";
import EmptyState from "@/components/common/EmptyState.vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

import type {
  ContextCommand as CoreContextCommand,
  ContextCommandPayload as CoreContextCommandPayload,
} from "@kabegame/core/components/image/ImageGrid.vue";
import type { ActionItem } from "@kabegame/core/actions/types";

// 扩展 ContextCommand 类型，添加 kabegame 特有的命令
export type ContextCommand = CoreContextCommand | "favorite" | "addToAlbum" | "addToHidden" | "share" | "deleteFile";
type ImageInfo = CoreImageInfo;

// 扩展 ContextCommandPayload 类型
// 对于扩展命令，payload 结构与 core 一致，只是 command 字段不同
export type ContextCommandPayload<T extends ContextCommand = ContextCommand> =
  T extends "favorite" | "addToAlbum" | "addToHidden" | "share" | "deleteFile"
  ? Omit<CoreContextCommandPayload, "command"> & { command: T }
  : CoreContextCommandPayload;

// 本组件是 fragment root（含详情弹窗），需要显式透传 attrs（class/style 等）到 CoreImageGrid
defineOptions({ inheritAttrs: false });

interface Props {
  images: ImageInfo[];
  /** Actions for context menu (desktop) / action sheet (Android). Uses ActionRenderer abstraction. */
  actions?: ActionItem<ImageInfo>[];
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
  scrollWholeContainer?: boolean;
}

const props = defineProps<Props>();
type PreviewNavigatePayload = {
  direction: "prev" | "next";
  fromIndex: number;
  toIndex: number;
  wrapped: boolean;
  image: ImageInfo;
};
type PreviewPageBoundaryPayload = {
  direction: "prev" | "next";
  index: number;
  image: ImageInfo;
};
const emit = defineEmits<{
  "image-dblclick": [payload: { action: "preview" | "open"; image: ImageInfo }];
  "preview-navigate": [payload: PreviewNavigatePayload];
  "preview-page-boundary": [payload: PreviewPageBoundaryPayload];
  "preview-detail-toggle": [payload: { open: boolean; image: ImageInfo | null }];
  "preview-close": [payload: { image: ImageInfo | null }];
  // 兼容旧 API：右键已移除加入画册，但保留事件名不破坏上层模板
  addedToAlbum: [];
}>();

const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();

function handleOpenTask(taskId: string) {
  void router.push({ name: "TaskDetail", params: { id: taskId } });
}

function galleryFilterTargetToRoute(
  target: ImageDetailGalleryFilterTarget,
): { filters: GalleryFilterSet; search: string } | null {
  if (target.type === "search") {
    const search = target.search.trim();
    return search ? { filters: {}, search } : null;
  }

  let filter: GalleryFilter;
  switch (target.type) {
    case "plugin":
      filter = { type: "plugin", pluginId: target.pluginId };
      break;
    case "media-type":
      filter = target.format
        ? { type: "media-type", kind: target.kind, format: target.format }
        : { type: "media-type", kind: target.kind };
      break;
    case "date":
      filter = { type: "date", segment: target.segment };
      break;
    case "size":
      filter = { type: "size", range: target.range };
      break;
    case "aspect":
      filter = { type: "aspect", range: target.range };
      break;
  }
  return { filters: singleFilterToSet(filter), search: "" };
}

async function handleOpenGalleryFilter(target: ImageDetailGalleryFilterTarget) {
  const routeState = galleryFilterTargetToRoute(target);
  if (!routeState) return;
  // 先在 gallery 内部导航（push 一条 history），导航完成后再关闭预览/详情：
  // 这是 gallery 内部跳转，预览的当前图片可能已不在新 filter 结果中，需要关闭；
  // 等导航 await 完成后再关闭，可保证 previewedId→null 引发的 pvwimgid 写入只
  // 基于已落定的目标 URL，不会与 push 在同一 tick 竞争而把 filter 覆盖回去。
  await galleryRouteStore.navigate(
    { ...routeState, page: 1 },
    { push: true },
  );
  imageDetailDialog.close();
  coreRef.value?.closePreview?.();
}

const attrs = useAttrs();
// 传 core 时需将 actions 断言为 ActionItem<CoreImageInfo>[]，避免泛型不兼容
const pluginStore = usePluginStore();
const plugins = computed(() => pluginStore.plugins);

const coreGridBind = computed(() => {
  const { actions, ...rest } = props;
  return {
    ...attrs,
    ...rest,
    actions: actions as ActionItem<CoreImageInfo>[] | undefined,
    plugins: plugins.value,
  };
});

const coreRef = ref<any>(null);

/* ---------------- 预览图片 URL 参数 pvwimgid 双向同步 ----------------
 * router 由本（外层）组件持有，core 层保持 router-agnostic：core 仅
 * emit preview-open/navigate/close 并暴露 openPreviewById/closePreview。
 */
const { settingValue: previewImageId, set: setPreviewImageId } = useSettingKeyState("previewImageId");
/** 当前预览中的图片 id（未预览为 null） */
const previewedId = ref<string | null>(null);

// keep-alive 守卫：本包装层在 Gallery/TaskDetail/Albums 等多个被 <keep-alive> 缓存的
// 视图里都有实例，停用后 watcher 仍会响应「全局」route 变化。pvwimgid 是全局 query，
// 必须只有「当前激活视图」参与同步，否则后台缓存的视图会抢同一个 pvwimgid（拿别的
// 视图的 id 误开预览，或把 pvwimgid 误写到当前其它路由）。非 keep-alive 场景下
// onActivated/onDeactivated 不触发，保持默认 true 即原行为。
const isRouteActive = ref(true);

const readPreviewId = (): string | null => {
  const v = previewImageId.value;
  return v ? String(v) : null;
};

// state -> URL：用 replace（不污染 history），只更新 pvwimgid 这一项并合并进当前 query。
// 不需要延迟对账：会触发同步导航(push)的关闭路径（open-gallery-filter）已改为「导航
// 完成后再关闭预览」，故 previewedId 变化时 URL 已落定，这里的 replace 不会与 push 竞争。
watch(previewedId, (id) => {
  if (!isRouteActive.value) return; // 非激活视图不写 URL
  if ((id ?? null) === readPreviewId()) return; // 已一致，避免回环
  void setPreviewImageId(id ?? "", { history: "replace" });
});

// URL -> state
const applyPreviewFromUrl = async () => {
  if (!isRouteActive.value) return; // 仅激活视图响应全局 pvwimgid
  const id = readPreviewId();
  if (id) {
    if (id === previewedId.value) return;
    // 等待 CoreImageGrid 接收最新的 images prop：父→子传播滞后一帧（本 watch 是 pre
    // flush，先于子组件重渲染）。若不等，刚加载进列表的目标图片在子组件里仍是旧列表 →
    // openPreviewById 的 findIndex 返回 -1，而本组件 watch 是一次性的 → 预览再也无法恢复。
    // await nextTick();
    if (readPreviewId() !== id || previewedId.value != null || !isRouteActive.value) return;
    coreRef.value?.openPreviewById?.(id); // id 不在当前列表时为 no-op
  } else if (previewedId.value != null) {
    coreRef.value?.closePreview?.();
  }
};
onMounted(applyPreviewFromUrl);
onActivated(() => { isRouteActive.value = true; void applyPreviewFromUrl(); });
onDeactivated(() => { isRouteActive.value = false; });
watch(() => previewImageId.value, applyPreviewFromUrl); // 前进/后退、外部改动
watch(() => props.images, () => {
  // 列表异步加载完成后再尝试一次（仅在仍有待打开 id 且未预览时）
  if (readPreviewId() && previewedId.value == null) void applyPreviewFromUrl();
}, {
  flush: 'post'
});

function handlePreviewOpen(payload: { image: ImageInfo }) {
  previewedId.value = payload.image.id;
}
function handlePreviewNavigate(payload: PreviewNavigatePayload) {
  previewedId.value = payload.image.id;
  emit("preview-navigate", payload);
}
function handlePreviewClose(payload: { image: ImageInfo | null }) {
  previewedId.value = null;
  emit("preview-close", payload);
}

// 旧 ImageGrid 的"内置详情弹窗"改为 wrapper 层实现
const imageDetailDialog = useModal();
const detailImage = ref<CoreImageInfo | null>(null);

async function handleContextCommand(payload: CoreContextCommandPayload): Promise<CoreContextCommand | null | undefined> {
  // 先调用 kabegame 的 handler（可能处理扩展命令或 core 命令）
  const res = await props.onContextCommand?.(payload as ContextCommandPayload);

  // 如果是扩展命令（favorite/addToAlbum），不传递给 core，直接返回
  if (res === "favorite" || res === "addToAlbum") {
    return null; // core 不处理扩展命令
  }

  // 兼容：view 层如果 return 'detail'，则在 wrapper 内打开详情弹窗
  if (res === "detail") {
    // payload.image 是 CoreImageInfo（url 可选），直接赋值即可
    detailImage.value = payload.image;
    imageDetailDialog.open();
  }

  // 将 core 命令的结果返回给 core
  return res as CoreContextCommand | null | undefined;
}

defineExpose({
  getContainerEl: () => coreRef.value?.getContainerEl?.(),
  getSelectedIds: () => coreRef.value?.getSelectedIds?.(),
  clearSelection: () => coreRef.value?.clearSelection?.(),
  exitAndroidSelectionMode: () => coreRef.value?.exitAndroidSelectionMode?.(),
  openPreviewById: (id: string) => coreRef.value?.openPreviewById?.(id),
  closePreview: () => coreRef.value?.closePreview?.(),
});
</script>
