<template>
  <CoreImageGrid
    ref="coreRef"
    v-bind="coreGridBind"
    :window-aspect-ratio="props.windowAspectRatio"
    :on-context-command="handleContextCommand"
    @open-task="handleOpenTask"
    @image-dblclick="handleImageDblclick"
    @preview-open="handlePreviewOpen"
    @preview-navigate="handlePreviewNavigate"
    @preview-page-boundary="handlePreviewPageBoundary"
    @preview-detail-toggle="handlePreviewDetailToggle"
    @preview-close="handlePreviewClose"
    @open-gallery-filter="handleOpenGalleryFilter"
    @open-surf-record="handleOpenSurfRecord"
  >
    <!-- header / aside 必须按需透传：无条件声明会让 core 误判 $slots.aside 存在而切换多栏布局 -->
    <template v-if="$slots.header" #header>
      <slot name="header" v-bind="beforeGridSlotProps" />
    </template>
    <template v-if="$slots.aside" #aside>
      <slot name="aside" />
    </template>
    <template v-if="$slots['aside-right']" #aside-right>
      <slot name="aside-right" />
    </template>
    <template #before-grid>
      <slot name="before-grid" v-bind="beforeGridSlotProps" />
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

  <!-- 详情弹窗：view 层 onContextCommand return 'detail' 或未拦截时由本层打开 -->
  <ImageDetailDialog
    :open="imageDetailDialog.isOpen.value"
    :z-index="imageDetailDialog.zIndex.value"
    :image="detailImage"
    :plugins="plugins"
    @close="imageDetailDialog.close()"
    @open-task="handleOpenTask"
    @open-gallery-filter="handleOpenGalleryFilter"
    @open-surf-record="handleOpenSurfRecord"
  />

  <!-- remove / deleteFile 确认框：文案与执行语义由 adapter 决定 -->
  <RemoveImagesConfirmDialog
    :open="removeDialog.isOpen.value"
    :z-index="removeDialog.zIndex.value"
    :message="removeDialogText?.message ?? ''"
    :title="removeDialogText?.title"
    :confirm-text="removeDialogText?.confirmText"
    hide-checkbox
    @close="removeDialog.close()"
    @confirm="confirmRemoveImages"
  />

  <!-- 加入画册（右键菜单 imageIds / header 一键加入 taskId） -->
  <AddToAlbumDialog
    :open="addToAlbumDialog.isOpen.value"
    :z-index="addToAlbumDialog.zIndex.value"
    :image-ids="addToAlbumImageIds"
    :task-id="addToAlbumTaskId"
    :exclude-album-ids="addToAlbumExcludeIds"
    @close="addToAlbumDialog.close()"
    @added="handleAddedToAlbum"
  />
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, ref, shallowRef, useAttrs, watch } from "vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useRoute, useRouter } from "vue-router";
import CoreImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import type { ImageInfo as CoreImageInfo } from "@kabegame/core/types/image";
import ImageDetailDialog from "@kabegame/core/components/common/ImageDetailDialog.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import type {
  ImageDetailGalleryFilterTarget,
  ImageDetailSurfRecordTarget,
} from "@kabegame/core/components/common/ImageBasicInfoPanel.vue";
import { usePluginStore } from "@/stores/plugins";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import {
  singleFilterToSet,
  queryFromFilterSet,
  type GalleryFilter,
  type GalleryQuery,
} from "@/utils/galleryPath";
import EmptyState from "@/components/common/EmptyState.vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { pathqlFetch } from "@/services/pathql";
import { rowToImageInfo } from "@/utils/imageRow";
import { withGalleryPrefix } from "@/utils/path";
import { diffById } from "@/utils/listDiff";
import { createImageActions } from "@/actions/imageActions";
import { useImageOperations } from "@/composables/useImageOperations";
import { usePagedGallery } from "@/composables/usePagedGallery";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { useAlbumStore, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useI18n } from "@kabegame/i18n";
// #region DEBUG-gallery-refresh
import { sendDebugEvent } from "@kabegame/core/debugIngest";
// #endregion
import type {
  GridRefreshContext,
  GridRemoveDialogText,
  GridAdapter,
} from "@/components/imageGrid/types";

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

// 本组件是 fragment root（含多个弹窗），需要显式透传 attrs（class/style 等）到 CoreImageGrid
defineOptions({ inheritAttrs: false });

interface Props {
  /**
   * per-page 适配器：数据加载 / URL 同步 / 事件刷新 / 菜单命令默认实现均由本组件
   * 按 adapter 接管。在组件生命周期内不变（view setup 中创建后传入）。
   */
  adapter: GridAdapter;
  /** Actions for context menu (desktop) / action sheet (Android). 缺省由 adapter.actionsOptions 生成 */
  actions?: ActionItem<ImageInfo>[];
  /**
   * 可选覆盖钩子：返回命令字符串 = 交给内置默认实现；返回 null/undefined = 已处理/抑制。
   * 不传时所有命令直接走内置默认实现。
   */
  onContextCommand?: (
    payload: ContextCommandPayload
  ) =>
    | ContextCommand
    | null
    | undefined
    | Promise<ContextCommand | null | undefined>;
  showEmptyState?: boolean;
  loading?: boolean; // 外部附加的加载状态（如手动刷新中）
  loadingOverlay?: boolean; // 外部附加的加载遮罩；不传则默认等同于 loading
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
  /** 内置默认命令执行完成后触发（view 可做追加处理） */
  action: [payload: { command: ContextCommand; images: ImageInfo[] }];
  addedToAlbum: [];
}>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();
const settingsStore = useSettingsStore();
const albumStore = useAlbumStore();

const adapter = props.adapter;
// #region DEBUG-gallery-refresh
let dbgSeq = 0;
const dbg = (name: string, payload: Record<string, unknown> = {}) =>
  void sendDebugEvent(name, { grid: adapter.id, seq: ++dbgSeq, ...payload }, { sessionId: "gallery-refresh" });
// #endregion

function handleOpenTask(taskId: string) {
  void router.push({ name: "TaskDetail", params: { taskId: taskId } });
}

async function handleOpenSurfRecord(target: ImageDetailSurfRecordTarget) {
  const host = target.host.trim();
  if (!host) return;
  await router.push({ name: "SurfImages", params: { host } });
  imageDetailDialog.close();
  coreRef.value?.closePreview?.();
}

function galleryFilterTargetToQuery(
  target: ImageDetailGalleryFilterTarget,
): GalleryQuery | null {
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
  return queryFromFilterSet(singleFilterToSet(filter));
}

async function handleOpenGalleryFilter(target: ImageDetailGalleryFilterTarget) {
  const query = galleryFilterTargetToQuery(target);
  if (!query) return;
  // 先在 gallery 内部导航（push 一条 history），导航完成后再关闭预览/详情：
  // 这是 gallery 内部跳转，预览的当前图片可能已不在新 filter 结果中，需要关闭；
  // 等导航 await 完成后再关闭，可保证 previewedId→null 引发的 pvwimgid 写入只
  // 基于已落定的目标 URL，不会与 push 在同一 tick 竞争而把 filter 覆盖回去。
  await galleryRouteStore.navigate({ query, page: 1 }, { push: true });
  imageDetailDialog.close();
  coreRef.value?.closePreview?.();
}

const attrs = useAttrs();
const pluginStore = usePluginStore();
const plugins = computed(() => pluginStore.plugins);

const coreRef = ref<any>(null);
const getContainerEl = (): HTMLElement | null => coreRef.value?.getContainerEl?.() ?? null;
const clearSelection = () => {
  coreRef.value?.clearSelection?.();
};

// keep-alive 守卫：本包装层在 Gallery/TaskDetail/Albums 等多个被 <keep-alive> 缓存的
// 视图里都有实例，停用后 watcher 仍会响应「全局」route 变化。pvwimgid / query.path 都是
// 全局 query，必须只有「当前激活视图」参与同步，否则后台缓存的视图会抢同一个 query
// （拿别的视图的 id 误开预览，或把 query 误写到当前其它路由）。非 keep-alive 场景下
// onActivated/onDeactivated 不触发，保持默认 true 即原行为。
const isRouteActive = ref(true);

/* ---------------- 数据层 ----------------
 * 本组件持有 images / loadedKey，接管路径加载、usePagedGallery 分页、
 * route.query.path 同步与 images-change / album-images-change 事件刷新。
 */
const images = shallowRef<ImageInfo[]>([]);
const loadedKey = ref("");

// metadata per-page 缓存：本组件是详情/预览的公共祖先，在此 provide
const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();

const { loading: internalLoading, showLoading: showInternalLoading, startLoading, finishLoading } =
  useLoadingDelay();

const currentWallpaperImageId = computed<string | null>({
  get: () => settingsStore.values.currentWallpaperImageId ?? null,
  set: (value) => {
    settingsStore.values.currentWallpaperImageId = value;
  },
});

// 图片操作
const {
  handleOpenImagePath,
  handleDownloadImage,
  handleCopyImage,
  handleBatchDeleteImages,
  handleBatchHideImages,
  toggleFavoriteForImages,
  shareImage,
  openImageFolder,
  setWallpaper,
} = useImageOperations(images, currentWallpaperImageId, coreRef);

let loadImagesInFlight = false;
// 加载路径数据。调用点有三个：path变化、事件驱动、手动刷新
const loadImages = async (path?: string) => {
  const raw = path || adapter.routeStore.computedPath || adapter.rootPathFallback?.() || "";
  if (!raw) return;
  if (adapter.validatePath && !adapter.validatePath(raw)) return;
  loadImagesInFlight = true;
  dbg("loadImages_start", { raw, argPath: path ?? null, computedPath: adapter.routeStore.computedPath });
  try {
    clearImageMetadataCache();
    const rows = await pathqlFetch<Record<string, unknown>>(withGalleryPrefix(raw));
    images.value = rows.map(rowToImageInfo);
    loadedKey.value = raw;
    dbg("loadImages_done", { raw, rows: rows.length, firstIds: rows.slice(0, 3).map((x) => x.id) });
  } catch (e) {
    dbg("loadImages_error", { raw, error: String(e) });
    throw e;
  } finally {
    loadImagesInFlight = false;
  }
};

const paged = usePagedGallery({
  routeStore: adapter.routeStore,
  images,
  loadedKey,
  viewRef: coreRef,
  loading: { startLoading, finishLoading },
  // 数据
  load: (path) => loadImages(path),
  computeCountPath: adapter.computeCountPath,
  isActive: () => isRouteActive.value && adapter.isActive(),
  computeTargetPath: adapter.computeTargetPath,
  onCountError: (error) => adapter.onCountError?.(error, refreshCtx),
  onLoadError: adapter.onLoadError,
});

const {
  totalImagesCount,
  currentPage: gridCurrentPage,
  pageSize: gridPageSize,
  currentPath: gridCurrentPath,
  handleJumpToPage: jumpToPage,
  loadTotalImagesCount,
  ensureValidPageAfterMassRemoval,
} = paged;

/**
 * 事件驱动的当前页刷新：保留滚动位置，重算总数；对被移除的图片做
 * 选中清理、当前壁纸清理与页码越界回退。
 */
const refreshPage = async (): Promise<{ removedIds: string[] }> => {
  const prevList = images.value.slice();
  dbg("refreshPage_start", { path: gridCurrentPath.value, prevCount: prevList.length, isRouteActive: isRouteActive.value, adapterActive: adapter.isActive() });
  const container = getContainerEl();
  const prevScrollTop = container?.scrollTop ?? 0;
  try {
    await loadImages(gridCurrentPath.value);
  } catch (error) {
    await adapter.onLoadError?.(error, gridCurrentPath.value);
    return { removedIds: [] };
  }
  if (container) container.scrollTop = prevScrollTop;
  await loadTotalImagesCount();

  const { removedIds } = diffById(prevList, images.value);
  dbg("refreshPage_diff", { newCount: images.value.length, removedIds, total: totalImagesCount.value });
  if (removedIds.length > 0) {
    const selected = coreRef.value?.getSelectedIds?.() as Set<string> | undefined;
    if (selected && selected.size > 0 && removedIds.some((id) => selected.has(id))) {
      clearSelection();
    }
    if (
      currentWallpaperImageId.value &&
      removedIds.includes(currentWallpaperImageId.value)
    ) {
      currentWallpaperImageId.value = null;
    }
  }
  if (removedIds.length > 0 || images.value.length === 0) {
    await ensureValidPageAfterMassRemoval();
  }
  return { removedIds };
};

const refreshCtx: GridRefreshContext = {
  images,
  computedPath: gridCurrentPath,
  refreshPage,
  loadTotalImagesCount,
  ensureValidPageAfterMassRemoval,
  clearSelection,
};

const readRouteQueryPath = (): string => {
  const rawPath = route.query.path;
  return Array.isArray(rawPath)
    ? String(rawPath[0] ?? "")
    : String(rawPath ?? "");
};

const syncActivePathFromUrl = () => {
  if (!isRouteActive.value || !adapter.isActive()) return;
  const qp = readRouteQueryPath().trim();
  if (!qp) {
    // URL 无 ?path=：gallery 语义是「回到默认画廊路径」。
    // 把当前默认 state 写回 URL（navigate 走 replace），让地址栏反映默认 path。
    // detail 路由无此语义（恒带 path），不 materialize。
    if (adapter.syncEmptyQueryPath) void adapter.routeStore.navigate({});
    return;
  }
  if (adapter.validatePath && !adapter.validatePath(qp)) return;
  if (qp !== gridCurrentPath.value) {
    adapter.routeStore.syncFromUrl(qp);
  }
};

/** 手动刷新：重拉当前页 + 总数（错误向上抛，由 view 决定提示文案） */
const refresh = async (opts?: { resetScroll?: boolean }) => {
  await loadImages(gridCurrentPath.value);
  void loadTotalImagesCount();
  if (opts?.resetScroll) {
    const el = getContainerEl();
    if (el) el.scrollTop = 0;
  }
};

// isActive 后置就绪（如 taskId/albumName 异步初始化）时 currentPath 不变，
// usePagedGallery 的 path watch 不会重发——在激活翻转时补一次加载。
watch(
  () => isRouteActive.value && adapter.isActive(),
  (active) => {
    if (!active || loadImagesInFlight) return;
    const path = adapter.routeStore.computedPath || adapter.rootPathFallback?.() || "";
    if (!path || loadedKey.value === path) return;
    startLoading();
    void (async () => {
      try {
        await loadImages(path);
      } catch (error) {
        await adapter.onLoadError?.(error, path);
        return;
      } finally {
        finishLoading();
      }
      void loadTotalImagesCount();
    })();
  }
);

// route.query.path → routeStore 同步（预览跨页 pendingPreviewBoundary 特判见下）
watch(
  () => route.query.path,
  () => {
    if (!isRouteActive.value || !adapter.isActive()) return;
    const qp = readRouteQueryPath();
    if (!qp.trim()) {
      // 见 syncActivePathFromUrl：gallery 空 path = 回默认，把默认 state
      // 写回 URL（replace）；其余 adapter 无 syncEmptyQueryPath，不处理。
      if (adapter.syncEmptyQueryPath) void adapter.routeStore.navigate({});
      return;
    }
    const pending = paged.pendingPreviewBoundary.value;
    if (
      pending?.targetPath &&
      gridCurrentPath.value === pending.targetPath &&
      qp !== pending.targetPath
    ) {
      void router.replace({
        path: route.path,
        query: { ...route.query, path: pending.targetPath },
      });
      return;
    }
    if (qp !== gridCurrentPath.value) {
      adapter.routeStore.syncFromUrl(qp);
    }
  },
  { immediate: true }
);

// 统一图片变更事件：不做增量同步，收到事件后刷新“当前页”（trailing 节流）。
// 始终启用（含 keep-alive 后台），保证返回页面时数据已反映删除/新增。
const defaultEventRefresh = async () => {
  const { removedIds } = await refreshPage();
  await adapter.onAfterRefresh?.(refreshCtx, { removedIds });
};
useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: adapter.imagesChange?.waitMs ?? 1000,
  filter: (p) => {
    const pass = adapter.imagesChange?.filter?.(p, refreshCtx) ?? true;
    dbg("imagesChange_recv", { payload: p, pass, currentIds: images.value.slice(0, 5).map((i) => i.id), count: images.value.length });
    return pass;
  },
  onRefresh: async (p) => {
    dbg("imagesChange_refresh_start", { reason: p.reason });
    try {
    if (adapter.imagesChange?.onRefresh) {
      await adapter.imagesChange.onRefresh(p, refreshCtx);
    } else {
      await defaultEventRefresh();
    }
    dbg("imagesChange_refresh_end", { reason: p.reason });
    } catch (e) {
      dbg("imagesChange_refresh_error", { error: String(e) });
      throw e;
    }
  },
});
// album_images 表变更：默认只关心 HIDDEN 画册（HideGate 影响可见性）
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: adapter.albumImagesChange?.waitMs ?? 500,
  filter: (p) => {
    const pass = adapter.albumImagesChange?.filter
      ? adapter.albumImagesChange.filter(p, refreshCtx)
      : (p.albumIds ?? []).includes(HIDDEN_ALBUM_ID);
    dbg("albumImagesChange_recv", { payload: p, pass });
    return pass;
  },
  onRefresh: async (p) => {
    dbg("albumImagesChange_refresh_start", { reason: p.reason, albumIds: p.albumIds });
    try {
    if (adapter.albumImagesChange?.onRefresh) {
      await adapter.albumImagesChange.onRefresh(p, refreshCtx);
    } else {
      await defaultEventRefresh();
    }
    dbg("albumImagesChange_refresh_end", {});
    } catch (e) {
      dbg("albumImagesChange_refresh_error", { error: String(e) });
      throw e;
    }
  },
});

// 传 core 时需将 actions 断言为 ActionItem<CoreImageInfo>[]，避免泛型不兼容
const effectiveActions = computed(() => {
  if (props.actions) return props.actions;
  if (adapter.actionsOptions) return createImageActions(adapter.actionsOptions());
  return undefined;
});

const coreGridBind = computed(() => {
  const {
    actions: _actions,
    adapter: _adapter,
    onContextCommand: _onContextCommand,
    loading: _loading,
    loadingOverlay: _loadingOverlay,
    ...rest
  } = props;
  return {
    ...attrs,
    ...rest,
    images: images.value,
    loading: (props.loading ?? false) || internalLoading.value,
    loadingOverlay:
      (props.loadingOverlay ?? props.loading ?? false) || showInternalLoading.value,
    actions: effectiveActions.value as ActionItem<CoreImageInfo>[] | undefined,
    plugins: plugins.value,
  };
});

const beforeGridSlotProps = computed(() => ({
  images: images.value,
  totalCount: totalImagesCount.value,
  currentPage: gridCurrentPage.value,
  pageSize: gridPageSize.value,
  currentPath: gridCurrentPath.value,
  jumpToPage,
  refresh,
}));

/* ---------------- 预览图片 URL 参数 pvwimgid 双向同步 ----------------
 * router 由本（外层）组件持有，core 层保持 router-agnostic：core 仅
 * emit preview-open/navigate/close 并暴露 openPreviewById/closePreview。
 */
const { settingValue: previewImageId, set: setPreviewImageId } = useSettingKeyState("previewImageId");
/** 当前预览中的图片 id（未预览为 null） */
const previewedId = ref<string | null>(null);

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
    if (readPreviewId() !== id || previewedId.value != null || !isRouteActive.value) return;
    coreRef.value?.openPreviewById?.(id); // id 不在当前列表时为 no-op
  } else if (previewedId.value != null) {
    coreRef.value?.closePreview?.();
  }
};
onMounted(applyPreviewFromUrl);
onActivated(() => {
  isRouteActive.value = true;
  console.log('grid reactivate');
  syncActivePathFromUrl();
  void applyPreviewFromUrl();
  // keep-alive 重新激活：路径已变或列表为空时按当前路由 path 刷新，
  // 保证从其它页面返回后顺序与路由、header 一致。
  const pathToLoad = gridCurrentPath.value;
  if (
    !loadImagesInFlight &&
    pathToLoad &&
    adapter.isActive() &&
    (images.value.length === 0 || loadedKey.value !== pathToLoad)
  ) {
    void (async () => {
      try {
        await loadImages(pathToLoad);
        await loadTotalImagesCount();
      } catch (error) {
        await adapter.onLoadError?.(error, pathToLoad);
      }
    })();
  }
});
onDeactivated(() => {
  isRouteActive.value = false;
  clearSelection();
});
watch(() => previewImageId.value, applyPreviewFromUrl); // 前进/后退、外部改动
watch(images, () => {
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
  adapter.analytics?.trackPreviewNavigate(payload);
  emit("preview-navigate", payload);
}
function handlePreviewClose(payload: { image: ImageInfo | null }) {
  previewedId.value = null;
  adapter.analytics?.trackPreviewClose(payload);
  emit("preview-close", payload);
}
function handlePreviewDetailToggle(payload: { open: boolean; image: ImageInfo | null }) {
  adapter.analytics?.trackPreviewDetailToggle(payload);
  emit("preview-detail-toggle", payload);
}
function handleImageDblclick(payload: { action: "preview" | "open"; image: ImageInfo }) {
  adapter.analytics?.trackDoubleOpen(payload);
  emit("image-dblclick", payload);
}
function handlePreviewPageBoundary(payload: PreviewPageBoundaryPayload) {
  void paged.handlePreviewPageBoundary(payload);
  emit("preview-page-boundary", payload);
}

/* ---------------- 菜单命令默认实现与对话框 ---------------- */
const imageDetailDialog = useModal();
const detailImage = ref<CoreImageInfo | null>(null);

const removeDialog = useModal();
const removeDialogText = ref<GridRemoveDialogText | null>(null);
const pendingRemove = ref<{ mode: "remove" | "deleteFile"; images: ImageInfo[] } | null>(null);

const addToAlbumDialog = useModal();
const addToAlbumImageIds = ref<string[]>([]);
const addToAlbumTaskId = ref<string | undefined>(undefined);
const pendingAddToAlbumImages = ref<ImageInfo[]>([]);
const addToAlbumExcludeIds = computed(() => adapter.addToAlbumExcludeIds?.() ?? []);

/** header「一键加入画册」等场景由 view 通过 ref 调用 */
const openAddToAlbum = (opts: { imageIds?: string[]; taskId?: string }) => {
  addToAlbumImageIds.value = opts.imageIds ?? [];
  addToAlbumTaskId.value = opts.taskId;
  addToAlbumDialog.open();
};

const handleAddedToAlbum = async () => {
  if (pendingAddToAlbumImages.value.length > 0) {
    adapter.analytics?.trackAction("addToAlbum", pendingAddToAlbumImages.value);
  }
  pendingAddToAlbumImages.value = [];
  addToAlbumTaskId.value = undefined;
  clearSelection();
  await adapter.onAddedToAlbum?.();
  emit("addedToAlbum");
};

/** 从当前列表解析命令目标：单选回退 payload.image（预览等场景图片可能不在列表中） */
const resolveCommandTargets = (payload: CoreContextCommandPayload) => {
  const list = images.value;
  const image: ImageInfo | undefined =
    list.find((i) => i.id === payload.image?.id) ?? (payload.image as ImageInfo | undefined);
  if (!image) {
    return { image: undefined, imagesToProcess: [] as ImageInfo[], isMultiSelect: false };
  }
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);
  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess: ImageInfo[] = isMultiSelect
    ? list.filter((img) => selectedSet.has(img.id))
    : [image];
  return { image, imagesToProcess, isMultiSelect };
};

const openRemoveDialog = (mode: "remove" | "deleteFile", images: ImageInfo[]) => {
  const cfg = mode === "remove" ? adapter.remove : adapter.deleteFile;
  if (!cfg) return;
  if (cfg.guard?.()) return;
  const includesCurrentWallpaper =
    !!currentWallpaperImageId.value &&
    images.some((img) => img.id === currentWallpaperImageId.value);
  pendingRemove.value = { mode, images };
  removeDialogText.value = cfg.dialogText(images.length, { includesCurrentWallpaper });
  removeDialog.open();
};

const confirmRemoveImages = async () => {
  const pending = pendingRemove.value;
  dbg("confirmRemove", { mode: pending?.mode, ids: pending?.images.map((i) => i.id) });
  removeDialog.close();
  if (!pending || pending.images.length === 0) return;
  pendingRemove.value = null;
  const cfg = pending.mode === "remove" ? adapter.remove : adapter.deleteFile;
  if (cfg?.confirm) {
    await cfg.confirm(pending.images, refreshCtx);
  } else {
    await handleBatchDeleteImages(pending.images);
  }
  adapter.analytics?.trackAction(pending.mode, pending.images);
};

const runDefaultCommand = async (
  command: ContextCommand,
  payload: CoreContextCommandPayload,
): Promise<void> => {
  if (command === "detail") {
    detailImage.value = payload.image;
    imageDetailDialog.open();
    if (payload.image) {
      adapter.analytics?.trackAction("detail", [payload.image as ImageInfo]);
    }
    return;
  }

  const { image, imagesToProcess, isMultiSelect } = resolveCommandTargets(payload);
  if (!image || imagesToProcess.length === 0) return;
  const track = (
    cmd: string,
    targets: ImageInfo[] = imagesToProcess,
    data?: Record<string, unknown>,
  ) => adapter.analytics?.trackAction(cmd, targets, data);

  switch (command) {
    case "download":
      for (const img of imagesToProcess) {
        await handleDownloadImage(img);
      }
      track("download");
      break;
    case "copy":
      if (imagesToProcess[0]) {
        await handleCopyImage(imagesToProcess[0]);
        track("copy", imagesToProcess.slice(0, 1));
      }
      break;
    case "favorite": {
      if (await guardDesktopOnly("favoriteImage", { needSuper: true })) break;
      const result = await toggleFavoriteForImages(imagesToProcess);
      if (result) track("favorite", result.images, { value: result.favorite });
      break;
    }
    case "open":
      if (!isMultiSelect && imagesToProcess[0]?.localPath) {
        await handleOpenImagePath(imagesToProcess[0].localPath);
        track("open", imagesToProcess.slice(0, 1));
      }
      break;
    case "openFolder":
      if (await guardDesktopOnly("openLocal")) break;
      if (!isMultiSelect && imagesToProcess[0]) {
        await openImageFolder(imagesToProcess[0]);
        track("openFolder", imagesToProcess.slice(0, 1));
      }
      break;
    case "wallpaper":
      await setWallpaper(imagesToProcess);
      track("wallpaper");
      break;
    case "share":
      if (await guardDesktopOnly("share")) break;
      if (!isMultiSelect && imagesToProcess[0]) {
        await shareImage(imagesToProcess[0]);
        track("share", imagesToProcess.slice(0, 1));
      }
      break;
    case "addToAlbum":
      pendingAddToAlbumImages.value = imagesToProcess.slice();
      openAddToAlbum({ imageIds: imagesToProcess.map((img) => img.id) });
      break;
    case "addToHidden": {
      if (await guardDesktopOnly("hideImage", { needSuper: true })) break;
      const ids = imagesToProcess.map((img) => img.id);
      const isUnhide = !!image.isHidden || (adapter.forceUnhide?.() ?? false);
      try {
        if (isUnhide) {
          await albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(t("contextMenu.unhideSuccess"));
        } else {
          await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(
            ids.length > 1
              ? t("contextMenu.hiddenCount", { count: ids.length })
              : t("contextMenu.hiddenOne"),
          );
        }
        clearSelection();
        track(isUnhide ? "removeFromHidden" : "addToHidden");
      } catch (e) {
        console.error(isUnhide ? "取消隐藏失败:" : "隐藏失败:", e);
        ElMessage.error(t(isUnhide ? "contextMenu.unhideFailed" : "contextMenu.hideFailed"));
      }
      break;
    }
    case "remove":
    case "deleteFile":
      openRemoveDialog(command, imagesToProcess);
      break;
    case "swipe-remove":
      if (adapter.swipeRemove) {
        await adapter.swipeRemove(imagesToProcess, refreshCtx);
      } else {
        await handleBatchHideImages(imagesToProcess);
      }
      track("swipe-remove");
      break;
  }

  // 对话框类命令（remove/deleteFile/addToAlbum）在确认后才算完成，不在此上报
  if (command !== "remove" && command !== "deleteFile" && command !== "addToAlbum") {
    emit("action", { command, images: imagesToProcess });
  }
};

async function handleContextCommand(payload: CoreContextCommandPayload): Promise<CoreContextCommand | null | undefined> {
  dbg("contextCommand", { command: payload.command, imageId: payload.image?.id });
  // view 的覆盖钩子先执行：返回命令 = 委托内置默认实现；返回 null = 已处理/抑制
  const res = props.onContextCommand
    ? await props.onContextCommand(payload as ContextCommandPayload)
    : (payload.command as ContextCommand);
  if (res == null) return null;
  await runDefaultCommand(res as ContextCommand, payload);
  return null;
}

defineExpose({
  getContainerEl,
  getSelectedIds: () => coreRef.value?.getSelectedIds?.(),
  clearSelection,
  exitAndroidSelectionMode: () => coreRef.value?.exitAndroidSelectionMode?.(),
  openPreviewById: (id: string) => coreRef.value?.openPreviewById?.(id),
  closePreview: () => coreRef.value?.closePreview?.(),
  refresh,
  refreshPage,
  loadTotalImagesCount,
  ensureValidPageAfterMassRemoval,
  jumpToPage,
  openAddToAlbum,
  totalImagesCount,
  currentPage: gridCurrentPage,
  pageSize: gridPageSize,
  currentPath: gridCurrentPath,
  images,
  loadedKey,
});
</script>
