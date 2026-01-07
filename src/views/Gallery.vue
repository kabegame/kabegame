<template>
  <div class="gallery-page">
    <!-- 顶部工具栏 -->
    <GalleryToolbar :dedupe-loading="dedupeLoading" :has-more="crawlerStore.hasMore" :is-loading-all="isLoadingAll"
      :load-all-progress="loadAllProgress" :load-all-loaded="loadAllLoaded" :load-all-total="loadAllTotal"
      :dedupe-progress="dedupeProgress" :dedupe-processed="dedupeProcessed" :dedupe-total="dedupeTotal"
      :dedupe-removed="dedupeRemoved" :total-count="totalImagesCount" :loaded-count="displayedImages.length"
      @refresh="loadImages(true, { forceReload: true })" @dedupe-by-hash="handleDedupeByHash"
      @show-quick-settings="openQuickSettingsDrawer" @show-crawler-dialog="showCrawlerDialog = true"
      @load-all="loadAllImages" @cancel-load-all="handleCancelLoadAll" @cancel-dedupe="cancelDedupe" />

    <div class="gallery-container" v-loading="showLoading">
      <ImageGrid v-if="!loading" ref="galleryViewRef" :images="displayedImages" :image-url-map="imageSrcMap"
        enable-ctrl-wheel-adjust-columns enable-ctrl-key-adjust-columns hide-scrollbar enable-virtual-scroll
        :context-menu-component="GalleryContextMenu" :on-context-command="handleGridContextCommand"
        @scroll-stable="loadImageUrls()" @reorder="(...args: any[]) => handleImageReorder(args[0])">
        <template #before-grid>
          <div v-if="displayedImages.length === 0 && !crawlerStore.hasMore && !isRefreshing"
            :key="'empty-' + refreshKey" class="empty fade-in">
            <EmptyState />
            <el-button type="primary" class="empty-action-btn" @click="showCrawlerDialog = true">
              <el-icon>
                <Plus />
              </el-icon>
              开始导入
            </el-button>
          </div>
        </template>

        <!-- 加载更多：仅 Gallery 注入到 ImageGrid 容器尾部 -->
        <template #footer>
          <!-- 加载全部时显示加载圆圈 -->
          <div v-if="isLoadingAll" class="load-more-container">
            <el-icon class="is-loading" :size="24">
              <Loading />
            </el-icon>
          </div>
          <!-- 非加载全部时显示加载更多按钮 -->
          <LoadMoreButton v-else-if="displayedImages.length > 0 || crawlerStore.hasMore"
            :has-more="crawlerStore.hasMore" :loading="isLoadingMore" @load-more="loadMoreImages" />
        </template>
      </ImageGrid>
    </div>

    <!-- 收集对话框（无需放在 ImageGrid 插槽里） -->
    <CrawlerDialog v-model="showCrawlerDialog" :plugin-icons="pluginIcons"
      :initial-config="crawlerDialogInitialConfig" />

    <!-- 去重确认对话框（无需放在 ImageGrid 插槽里） -->
    <el-dialog v-model="showDedupeDialog" title="确认去重" width="420px" destroy-on-close>
      <div style="margin-bottom: 16px;">
        <p style="margin-bottom: 8px;">去掉所有重复图片</p>
        <el-checkbox v-model="dedupeDeleteFiles" label="同时从电脑删除源文件（慎用）" />
        <p class="var-description" :style="{ color: dedupeDeleteFiles ? 'var(--el-color-danger)' : '' }">
          {{ dedupeDeleteFiles ? '警告：该操作将永久删除重复的电脑文件，不可恢复！' : '不勾选仅从画廊移除记录，保留电脑文件。' }}
        </p>
      </div>
      <template #footer>
        <el-button @click="showDedupeDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmDedupeByHash" :loading="dedupeLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 移除/删除确认对话框（抽成组件复用） -->
    <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
      :message="removeDialogMessage" title="确认删除" @confirm="confirmRemoveImages" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus, Loading } from "@element-plus/icons-vue";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useUiStore } from "@/stores/ui";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import GalleryContextMenu from "@/components/contextMenu/GalleryContextMenu.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import RemoveImagesConfirmDialog from "@/components/common/RemoveImagesConfirmDialog.vue";
import { useGalleryImages } from "@/composables/useGalleryImages";
import { useGallerySettings } from "@/composables/useGallerySettings";
import { useImageOperations } from "@/composables/useImageOperations";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import LoadMoreButton from "@/components/LoadMoreButton.vue";
import { storeToRefs } from "pinia";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

const crawlerStore = useCrawlerStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettingsDrawer = () => quickSettingsDrawer.open("gallery");
const pluginStore = usePluginStore();
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);
const preferOriginalInGrid = computed(() => imageGridColumns.value <= 2);

const dedupeLoading = ref(false); // 正在执行"按哈希去重"本体
const { startLoading: startDedupeDelay, finishLoading: finishDedupeDelay } = useLoadingDelay();
const dedupeProcessed = ref(0);
const dedupeTotal = ref(0);
const dedupeRemoved = ref(0);
const dedupeProgress = computed(() => {
  if (!dedupeLoading.value) return 0;
  if (!dedupeTotal.value) return 0;
  const pct = Math.round((dedupeProcessed.value / dedupeTotal.value) * 100);
  return Math.max(0, Math.min(100, pct));
});
const showCrawlerDialog = ref(false);
const crawlerDialogInitialConfig = ref<{
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
} | undefined>(undefined);
const router = useRouter();
const showDedupeDialog = ref(false); // 去重确认对话框
const dedupeDeleteFiles = ref(false); // 是否删除本地文件
// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);
// 详情/加入画册对话框已下沉到 ImageGrid
const galleryContainerRef = ref<HTMLElement | null>(null);
const galleryViewRef = ref<any>(null);
// const showAlbumDialog = ref(false);
const currentWallpaperImageId = ref<string | null>(null);
const totalImagesCount = ref<number>(0); // 总图片数（不受过滤器影响）

// 状态变量（用于 composables）
// const showSkeleton = ref(false);

// 整个页面的loading状态
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();

const isLoadingMore = ref(false);
const isLoadingAll = ref(false);

// “加载全部”进度（小进度条）：已加载数量 / 总数量
// - total 优先使用后端 range 返回的 crawlerStore.totalImages；兜底用 get_images_count 的 totalImagesCount
const loadAllProgress = computed(() => {
  if (!isLoadingAll.value) return 0;
  const total = crawlerStore.totalImages || totalImagesCount.value;
  if (!total) return 0;
  const loaded = displayedImages.value.length;
  const pct = Math.round((loaded / total) * 100);
  return Math.max(0, Math.min(100, pct));
});

const loadAllLoaded = computed(() => {
  if (!isLoadingAll.value) return 0;
  return displayedImages.value.length;
});

const loadAllTotal = computed(() => {
  if (!isLoadingAll.value) return 0;
  return crawlerStore.totalImages || totalImagesCount.value;
});
// TODO:
const isRefreshing = ref(false); // 刷新中状态，用于阻止刷新时 EmptyState 闪烁
// 刷新计数器，用于强制空占位符重新挂载以触发动画
const refreshKey = ref(0);
// dragScroll 拖拽滚动期间：暂停实时 loadImageUrls，优先保证滚动帧率
const isInteracting = ref(false);
// const pendingAlbumImages = ref<ImageInfo[]>([]);
// const pendingAlbumImageIds = computed(() => pendingAlbumImages.value.map(img => img.id));
// const selectedImage = ref<ImageInfo | null>(null);
// 使用画廊设置 composable
const {
  loadSettings
} = useGallerySettings();

// effectiveAspectRatio 已移除，ImageGrid 现在始终使用窗口宽高比
const plugins = computed(() => pluginStore.plugins);
const tasks = computed(() => crawlerStore.tasks);

// 插件配置相关的变量和函数已移至 CrawlerDialog 组件

// 使用画廊图片 composable
const {
  displayedImages,
  imageSrcMap,
  loadImageUrls,
  refreshImagesPreserveCache,
  refreshLatestIncremental,
  loadMoreImages: loadMoreImagesFromComposable,
  loadAllImages: loadAllImagesFromComposable,
  cancelLoadAll,
  removeFromUiCacheByIds,
} = useGalleryImages(
  galleryContainerRef,
  isLoadingMore,
  preferOriginalInGrid,
  imageGridColumns,
  isInteracting
);

watch(
  () => galleryViewRef.value,
  async () => {
    await nextTick();
    galleryContainerRef.value = galleryViewRef.value?.getContainerEl?.() ?? null;
    // 初次挂载/切换回来时：确保“仅视口内加载”能触发一次
    // （避免 refreshImagesPreserveCache 发生在 container 绑定之前导致 visibleIds 为空）
    if (galleryContainerRef.value && displayedImages.value.length > 0) {
      requestAnimationFrame(() => void loadImageUrls());
    }
  },
  { immediate: true }
);

const { isInteracting: autoIsInteracting } = useImageGridAutoLoad({
  containerRef: galleryContainerRef,
  onLoad: () => void loadImageUrls(),
});

watch(
  () => autoIsInteracting.value,
  (v) => {
    isInteracting.value = v;
  },
  { immediate: true }
);

// 兼容旧调用：保留原函数名
const loadImages = async (reset?: boolean, opts?: { forceReload?: boolean }) => {
  // 如果正在加载全部，先取消
  if (isLoadingAll.value) {
    cancelLoadAll();
    isLoadingAll.value = false;
  }
  // 如果强制刷新，递增刷新计数器以触发空占位符重新挂载
  if (opts?.forceReload) {
    refreshKey.value++;
    isRefreshing.value = true; // 标记为刷新中，阻止 EmptyState 闪烁
  }
  try {
    await refreshImagesPreserveCache(reset, opts);
  } finally {
    isRefreshing.value = false;
  }
};

const loadMoreImages = loadMoreImagesFromComposable;
const loadAllImages = async () => {
  if (isLoadingAll.value) return;
  isLoadingAll.value = true;
  try {
    await loadAllImagesFromComposable();
  } finally {
    isLoadingAll.value = false;
  }
};

const handleCancelLoadAll = () => {
  if (!isLoadingAll.value) return;
  cancelLoadAll();
  isLoadingAll.value = false;
};

// 使用图片操作 composable
const {
  handleBatchDeleteImages,
} = useImageOperations(
  displayedImages,
  imageSrcMap,
  currentWallpaperImageId,
  galleryViewRef,
  removeFromUiCacheByIds,
  loadImages,
  loadMoreImages
);

// 插件图标映射，存储每个插件的图标 URL
const pluginIcons = ref<Record<string, string>>({});
// getImageUrl 和 loadImageUrls 已移至 useGalleryImages composable

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

// 获取总图片数（不受过滤器影响）
const loadTotalImagesCount = async () => {
  try {
    const count = await invoke<number>("get_images_count");
    totalImagesCount.value = count;
  } catch (error) {
    console.error("获取总图片数失败:", error);
  }
};

// 加载插件图标
const loadPluginIcons = async () => {
  for (const plugin of plugins.value) {
    if (pluginIcons.value[plugin.id]) {
      continue; // 已经加载过
    }
    try {
      const iconData = await invoke<number[] | null>("get_plugin_icon", {
        pluginId: plugin.id,
      });
      if (iconData && iconData.length > 0) {
        // 将数组转换为 Uint8Array，然后转换为 base64 data URL
        const bytes = new Uint8Array(iconData);
        const binaryString = Array.from(bytes)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        const base64 = btoa(binaryString);
        pluginIcons.value[plugin.id] = `data:image/png;base64,${base64}`;
      }
    } catch (error) {
      // 图标加载失败，忽略（插件可能没有图标）
      console.debug(`插件 ${plugin.id} 没有图标或加载失败`);
    }
  }
};

const handleGridContextCommand = async (
  payload: ContextCommandPayload
): Promise<import("@/components/ImageGrid.vue").ContextCommand | null> => {
  const command = payload.command;
  const image = payload.image;
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? displayedImages.value.filter(img => selectedSet.has(img.id))
    : [image];

  switch (command) {
    // 这些命令已下沉到 ImageGrid 的默认处理
    case "copy":
    case "open":
    case "openFolder":
    case "wallpaper":
    case "exportToWE":
    case "addToAlbum":
    case "detail":
      return command;

    // 画廊特有：删除/移除确认对话框
    case "remove":
      // 显示删除对话框，让用户选择是否删除文件
      pendingRemoveImages.value = imagesToProcess;
      const count = imagesToProcess.length;
      removeDialogMessage.value = `将从画廊${count > 1 ? `移除这 ${count} 张图片` : "移除这张图片"}。`;
      removeDeleteFiles.value = false; // 默认不删除文件
      showRemoveDialog.value = true;
      return null;
    default:
      return command;
  }
};

// removeFromUiCacheByIds 已移至 useGalleryImages composable

// 画廊按 hash 去重（打开对话框）
const handleDedupeByHash = () => {
  if (dedupeLoading.value) return;
  dedupeDeleteFiles.value = false; // 默认不删除文件
  showDedupeDialog.value = true;
};

// 确认去重（调用 composable 中的函数）
const confirmDedupeByHash = async () => {
  showDedupeDialog.value = false;
  if (dedupeLoading.value) return;
  try {
    dedupeLoading.value = true;
    dedupeProcessed.value = 0;
    dedupeTotal.value = 0;
    dedupeRemoved.value = 0;
    startDedupeDelay();

    // 启动后端分批去重任务：立即返回，进度/移除/完成通过事件回传
    await invoke("start_dedupe_gallery_by_hash_batched", {
      deleteFiles: dedupeDeleteFiles.value,
    });

    ElMessage.success("已开始去重（后台执行，可随时取消）");
  } catch (error) {
    console.error("启动去重失败:", error);
    ElMessage.error("启动去重失败");
    dedupeLoading.value = false;
    finishDedupeDelay();
  }
};

const cancelDedupe = async () => {
  try {
    const canceled = await invoke<boolean>("cancel_dedupe_gallery_by_hash_batched");
    if (canceled) {
      ElMessage.info("已发送取消请求，稍后停止");
    } else {
      ElMessage.info("当前没有进行中的去重任务");
    }
  } catch (error) {
    console.error("取消去重失败:", error);
    ElMessage.error("取消失败");
  }
};

// 确认移除图片（合并了原来的 remove 和 delete 逻辑）
const confirmRemoveImages = async () => {
  const imagesToRemove = pendingRemoveImages.value;
  if (imagesToRemove.length === 0) {
    showRemoveDialog.value = false;
    return;
  }

  const shouldDeleteFiles = removeDeleteFiles.value;

  showRemoveDialog.value = false;

  // 使用统一的删除函数
  await handleBatchDeleteImages(imagesToRemove, shouldDeleteFiles);
};

// 删除确认对话框的回车键逻辑已抽到 RemoveImagesConfirmDialog 内部


// refreshImagesPreserveCache, refreshLatestIncremental, loadMoreImages, loadAllImages 已移至 useGalleryImages composable
// 插件配置相关的函数和 watch 监听器已移至 CrawlerDialog 组件

// 监听 CrawlerDialog 关闭，清空初始配置
watch(showCrawlerDialog, (isOpen) => {
  if (!isOpen) {
    // 延迟清空，确保对话框已经处理完初始配置
    nextTick(() => {
      crawlerDialogInitialConfig.value = undefined;
    });
  }
});

// 处理图片拖拽排序：只交换两张图片的 order
const handleImageReorder = async (payload: { aId: string; aOrder: number; bId: string; bOrder: number }) => {
  try {
    const imageOrders: [string, number][] = [
      [payload.aId, payload.aOrder],
      [payload.bId, payload.bOrder],
    ];

    await invoke("update_images_order", { imageOrders });

    const idxA = displayedImages.value.findIndex((i) => i.id === payload.aId);
    const idxB = displayedImages.value.findIndex((i) => i.id === payload.bId);
    if (idxA !== -1 && idxB !== -1) {
      const next = displayedImages.value.slice();
      [next[idxA], next[idxB]] = [next[idxB], next[idxA]];
      displayedImages.value = next.map((img) => {
        if (img.id === payload.aId) return { ...img, order: payload.aOrder } as ImageInfo;
        if (img.id === payload.bId) return { ...img, order: payload.bOrder } as ImageInfo;
        return img;
      });
      crawlerStore.images = displayedImages.value.slice();
    }
  } catch (error) {
    console.error("更新图片顺序失败:", error);
    ElMessage.error("更新顺序失败");
  }
};


// 监听图片列表变化，加载图片 URL
// 监听整个数组，但使用 shallow 模式减少深度追踪
// 当图片列表变化时（包括 filter 等情况），自动加载新图片的 URL
let imageListWatch: (() => void) | null = null;

// 可控 immediate，避免加载更多后立刻对全量列表触发 loadImageUrls
const setupImageListWatch = (immediate = true) => {
  if (imageListWatch) {
    imageListWatch(); // 停止之前的 watch
  }
  imageListWatch = watch(() => displayedImages.value, () => {
    // 如果正在加载更多，不触发 loadImageUrls（由 loadMoreImages 自己处理）
    if (isLoadingMore.value || isLoadingAll.value) {
      return;
    }

    // 图片列表变化时，加载新图片的 URL
    // loadImageUrls 内部会检查并跳过已加载的图片，所以可以安全地重复调用
    loadImageUrls();
  }, { immediate });
};

setupImageListWatch();

// 监听插件列表变化，加载新插件的图标
watch(plugins, () => {
  loadPluginIcons();
}, { deep: true });

// 记录已经显示过弹窗的任务ID，避免重复弹窗
const shownErrorTasks = new Set<string>();

// 监听任务状态变化，在失败时弹窗显示错误（仅作为兜底，主要通过事件触发）
watch(tasks, (newTasks, oldTasks) => {
  if (!oldTasks || oldTasks.length === 0) return;

  // 检查是否有新失败的任务
  newTasks.forEach(task => {
    const oldTask = oldTasks.find(t => t.id === task.id);
    if (oldTask && oldTask.status !== 'failed' && task.status === 'failed') {
      // 如果已经通过事件显示过弹窗，不再显示
      if (shownErrorTasks.has(task.id)) {
        return;
      }

      // 标记为已显示
      shownErrorTasks.add(task.id);

      // 任务失败，弹窗显示错误（仅作为兜底，如果事件没有触发）
      const pluginName = getPluginName(task.pluginId);

      // 如果进度为0%或错误信息包含"Script execution error"，说明脚本执行出错，使用弹窗显示详细错误信息
      if (task.progress === 0 || (task.error && task.error.includes("Script execution error"))) {
        // 使用 nextTick 确保在下一个事件循环中显示弹窗，避免阻塞
        nextTick(() => {
          ElMessageBox.alert(
            `脚本执行出错：\n${task.error || '未知错误'}`,
            `${pluginName} 执行失败`,
            {
              type: 'error',
              confirmButtonText: '确定',
            }
          ).catch(() => {
            // 用户可能关闭了弹窗，忽略错误
          });
        });
      } else {
        // 其他错误使用消息提示
        ElMessage.error(`${pluginName} 执行失败: ${task.error || '未知错误'}`);
      }
    }
  });
}, { deep: true });

onMounted(async () => {
  loadSettings();
  invoke<string | null>("get_current_wallpaper_image_id").then(id => {
    currentWallpaperImageId.value = id;
  }).catch(() => {
    currentWallpaperImageId.value = null;
  });
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）
  pluginStore.loadPlugins().then(() => {
    loadPluginIcons();
  });
  crawlerStore.loadRunConfigs();
  loadTotalImagesCount(); // 加载总图片数

  startLoading();
  loadImages(true).then(() => {
    finishLoading();
  });

  // 记录已经显示过弹窗的任务ID，避免重复弹窗
  const shownErrorTasks = new Set<string>();

  // 监听任务错误显示事件
  const errorDisplayHandler = ((event: CustomEvent<{ taskId: string; pluginId: string; error: string }>) => {
    const { taskId, pluginId, error } = event.detail;

    // 如果已经显示过弹窗，不再显示
    if (shownErrorTasks.has(taskId)) {
      return;
    }

    // 标记为已显示
    shownErrorTasks.add(taskId);

    const pluginName = getPluginName(pluginId);

    // 使用 nextTick 确保在下一个事件循环中显示弹窗
    nextTick(() => {
      ElMessageBox.alert(
        `脚本执行出错：\n${error || '未知错误'}`,
        `${pluginName} 执行失败`,
        {
          type: 'error',
          confirmButtonText: '确定',
        }
      ).catch(() => {
        // 用户可能关闭了弹窗，忽略错误
      });
    });
  }) as EventListener;

  // 不卸载取消监听。因为是keep-alive。并且不是web
  window.addEventListener('task-error-display', errorDisplayHandler);

  // 监听图片添加事件，实时同步画廊（仅增量刷新，避免全量图片重新加载）
  // 使用防抖机制，避免短时间内多次调用导致重复添加
  const refreshDebounceTimerRef = ref<ReturnType<typeof setTimeout> | null>(null);
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ taskId: string; imageId: string }>(
    "image-added",
    async () => {
      // 清除之前的定时器
      if (refreshDebounceTimerRef.value) {
        clearTimeout(refreshDebounceTimerRef.value);
      }
      // 设置新的防抖定时器（300ms 延迟，批量处理多个连续的 image-added 事件）
      refreshDebounceTimerRef.value = setTimeout(async () => {
        await refreshLatestIncremental();
        // 图片添加后更新总数
        await loadTotalImagesCount();
        refreshDebounceTimerRef.value = null;
      }, 300);
    }
  );

  // 监听后端分批去重事件：批量移除/删除
  await listen<{ imageIds: string[] }>("images-removed", async (event) => {
    const imageIds = event.payload?.imageIds ?? [];
    if (!imageIds || imageIds.length === 0) return;

    // 删除触发“后续图片顶上来”的 move 过渡（仅短暂开启）
    galleryViewRef.value?.startDeleteMoveAnimation?.();

    // 避免极端情况下对超大数组频繁 filter 导致卡顿：太大时只在结束时刷新
    if (displayedImages.value.length <= 200_000) {
      removeFromUiCacheByIds(imageIds);
    }
    if (
      currentWallpaperImageId.value &&
      imageIds.includes(currentWallpaperImageId.value)
    ) {
      currentWallpaperImageId.value = null;
    }

    // 通知其他页面同步（AlbumDetail/Albums 等依赖 window 事件）
    window.dispatchEvent(
      new CustomEvent("images-removed", { detail: { imageIds } })
    );
  });

  await listen<{ imageIds: string[] }>("images-deleted", async (event) => {
    const imageIds = event.payload?.imageIds ?? [];
    if (!imageIds || imageIds.length === 0) return;

    galleryViewRef.value?.startDeleteMoveAnimation?.();
    if (displayedImages.value.length <= 200_000) {
      removeFromUiCacheByIds(imageIds);
    }
    if (
      currentWallpaperImageId.value &&
      imageIds.includes(currentWallpaperImageId.value)
    ) {
      currentWallpaperImageId.value = null;
    }
    window.dispatchEvent(
      new CustomEvent("images-deleted", { detail: { imageIds } })
    );
  });

  // 去重进度 / 完成
  await listen<{
    processed: number;
    total: number;
    removed: number;
    batchIndex: number;
  }>("dedupe-progress", (event) => {
    const p = event.payload;
    if (!p) return;
    dedupeProcessed.value = p.processed ?? 0;
    dedupeTotal.value = p.total ?? 0;
    dedupeRemoved.value = p.removed ?? 0;
  });

  await listen<{
    processed: number;
    total: number;
    removed: number;
    canceled: boolean;
  }>("dedupe-finished", async (event) => {
    const p = event.payload;
    dedupeProcessed.value = p?.processed ?? dedupeProcessed.value;
    dedupeTotal.value = p?.total ?? dedupeTotal.value;
    dedupeRemoved.value = p?.removed ?? dedupeRemoved.value;

    dedupeLoading.value = false;
    finishDedupeDelay();

    await loadTotalImagesCount();

    if (p?.canceled) {
      ElMessage.info("去重已取消");
      return;
    }

    ElMessage.success(`去重完成：已移除 ${p?.removed ?? 0} 个重复项`);

    // 若为了避免卡顿没有实时移除（displayedImages 很大），则这里强制刷新一次
    if (displayedImages.value.length > 200_000) {
      await loadImages(true, { forceReload: true });
    }
  });

  // 监听图片移除/删除事件，更新总数并刷新显示列表
  // 注意：如果图片已经在 displayedImages 中不存在（已通过 handleBatchDeleteImages 手动更新），则不需要刷新
  const imagesRemovedHandler = ((event: Event) => {
    const customEvent = event as CustomEvent<{ imageIds?: string[] }>;
    const imageIds = customEvent.detail?.imageIds;

    loadTotalImagesCount();

    // 如果提供了 imageIds，检查这些图片是否还在 displayedImages 中
    // 如果都不在，说明已经通过 handleBatchDeleteImages 手动更新了，不需要刷新
    if (imageIds && imageIds.length > 0) {
      const stillExists = imageIds.some(id =>
        displayedImages.value.some(img => img.id === id)
      );
      if (!stillExists) {
        // 图片已经被手动移除，不需要刷新
        return;
      }
    }

    // 刷新画廊显示的图片列表（用于从其他视图删除图片的情况）
    // preserveScroll：避免把用户滚动位置拉回顶部
    refreshImagesPreserveCache(true, { preserveScroll: true });
  }) as EventListener;
  window.addEventListener("images-removed", imagesRemovedHandler);
  (window as any).__imagesRemovedHandler = imagesRemovedHandler;

  const imagesDeletedHandler = ((event: Event) => {
    const customEvent = event as CustomEvent<{ imageIds?: string[] }>;
    const imageIds = customEvent.detail?.imageIds;

    loadTotalImagesCount();

    // 如果提供了 imageIds，检查这些图片是否还在 displayedImages 中
    // 如果都不在，说明已经通过 handleBatchDeleteImages 手动更新了，不需要刷新
    if (imageIds && imageIds.length > 0) {
      const stillExists = imageIds.some(id =>
        displayedImages.value.some(img => img.id === id)
      );
      if (!stillExists) {
        // 图片已经被手动移除，不需要刷新
        return;
      }
    }

    // 刷新画廊显示的图片列表（用于从其他视图删除图片的情况）
    // preserveScroll：避免把用户滚动位置拉回顶部
    refreshImagesPreserveCache(true, { preserveScroll: true });
  }) as EventListener;
  window.addEventListener("images-deleted", imagesDeletedHandler);

  // 监听 App.vue 发送的文件拖拽事件
  const handleFileDrop = async (event: Event) => {
    const customEvent = event as CustomEvent<{
      path: string;
      isDirectory: boolean;
      outputDir: string;
    }>;

    const { path, isDirectory, outputDir } = customEvent.detail;
    console.log('[Gallery] 收到文件拖拽事件:', { path, isDirectory, outputDir });

    try {
      // 确保在画廊页面（App.vue 已经处理了路由跳转，这里只是双重保险）
      const currentPath = router.currentRoute.value.path;
      if (currentPath !== '/gallery') {
        console.log('[Gallery] 当前不在画廊页面，等待路由切换...');
        await router.push('/gallery');
        await nextTick();
        // 再等待一下确保组件已激活
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (isDirectory) {
        // 文件夹：使用 local-import 插件
        console.log('[Gallery] 设置文件夹导入配置，路径:', path);
        crawlerDialogInitialConfig.value = {
          pluginId: 'local-import',
          outputDir: path,
          vars: {
            folder_path: path,
          },
        };
        ElMessage.success('文件夹已准备导入');
      } else {
        // 文件：使用 local-import 插件
        console.log('[Gallery] 设置文件导入配置，路径:', path, '目录:', outputDir);
        crawlerDialogInitialConfig.value = {
          pluginId: 'local-import',
          outputDir: outputDir,
          vars: {
            file_path: path,
          },
        };
        ElMessage.success('文件已准备导入');
      }

      // 打开对话框
      console.log('[Gallery] 打开对话框，showCrawlerDialog 当前值:', showCrawlerDialog.value);
      showCrawlerDialog.value = true;
      await nextTick();
      console.log('[Gallery] 对话框状态:', showCrawlerDialog.value);
    } catch (error) {
      console.error('[Gallery] 处理文件拖拽事件失败:', error);
      ElMessage.error('处理文件拖拽失败: ' + (error instanceof Error ? error.message : String(error)));
    }
  };
  window.addEventListener('file-drop', handleFileDrop);
});

// 在开发环境中监控组件更新，帮助调试重新渲染问题
// 开发期调试日志已移除，保持生产干净输出

// 组件激活时（keep-alive 缓存后重新显示）
onActivated(async () => {
  // 重新加载设置，确保使用最新的 pageSize 等配置
  const previousPageSize = crawlerStore.pageSize;
  loadSettings();
  const newPageSize = crawlerStore.pageSize;

  // 如果图片列表为空，需要重新加载
  if (displayedImages.value.length === 0) {
    await loadImages(true);
    return;
  }

  // 检查 pageSize 是否发生变化，如果变化了需要重新加载图片
  if (previousPageSize !== newPageSize) {
    // pageSize 已变化，重新加载图片以使用新的 pageSize
    await loadImages(true);
    return;
  }

  // 检查并重新加载缺失的图片 URL
  // 统计缺失 URL 的图片数量
  let missingCount = 0;
  const imagesToReload: ImageInfo[] = [];

  for (const img of displayedImages.value) {
    const imageData = imageSrcMap.value[img.id];
    if (!imageData || (!imageData.thumbnail && !imageData.original)) {
      missingCount++;
      imagesToReload.push(img);
    } else {
      // 检查 Blob URL 是否仍然有效（通过尝试访问 URL）
      // 注意：blobUrls 在 composable 内部，这里通过检查 URL 是否可访问来判断
      const hasValidThumbnail = imageData.thumbnail && imageData.thumbnail.startsWith('blob:');
      const hasValidOriginal = imageData.original && imageData.original.startsWith('blob:');

      if (!hasValidThumbnail && !hasValidOriginal) {
        // Blob URL 已失效，需要重新加载
        missingCount++;
        imagesToReload.push(img);
        // 清理无效的条目
        delete imageSrcMap.value[img.id];
      }
    }
  }

  // 如果缺失的图片数量较多（超过 10%），重新加载所有缺失的 URL
  if (missingCount > 0) {
    if (missingCount > displayedImages.value.length * 0.1) {
      // 缺失较多，重新加载所有缺失的图片 URL
      loadImageUrls(imagesToReload);
    } else {
      // 缺失较少，只加载缺失的部分
      loadImageUrls(imagesToReload);
    }
  }

});

// 组件停用时（keep-alive 缓存，但不清理 Blob URL）
onDeactivated(() => {
  // keep-alive 缓存时不清理 Blob URL，保持图片 URL 有效
  // 退出调整模式（如果处于调整模式）
  galleryViewRef.value?.exitReorderMode?.();
});
</script>

<style lang="scss">
.gallery-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 0;
}

.gallery-container {
  width: 100%;
  flex: 1;
  /* 避免外层与 ImageGrid 内层双重滚动导致出现“多一条滚动条” */
  overflow: hidden;

  /* 按住空格进入“拖拽滚动模式” */
  &.drag-scroll-ready {
    cursor: grab;
  }

  /* 正在拖拽滚动 */
  &.drag-scroll-active {
    cursor: grabbing;
    user-select: none;
  }

  .load-more-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 32px 0;
    margin-top: 24px;
  }

  .context-menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9998;
  }

  .context-menu {
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--el-border-radius-base);
    box-shadow: var(--el-box-shadow-light);
    padding: 4px 0;
    min-width: 120px;

    .context-menu-item {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--el-text-color-primary);
      font-size: 14px;
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--el-fill-color-light);
      }

      .el-icon {
        margin-right: 8px;
      }
    }

    .context-menu-divider {
      height: 1px;
      background-color: var(--el-border-color-lighter);
      margin: 4px 0;
    }
  }

  /* 图片路径 tooltip 样式 */
  :deep(.image-path-tooltip) {
    max-width: 400px;
    padding: 8px 12px;
  }

  .tooltip-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    line-height: 1.4;
  }

  .tooltip-line {
    word-break: break-all;
    font-size: 12px;
  }

  .loading-skeleton {
    padding: 20px;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px;
    width: 100%;
  }

  .skeleton-item {
    border: 2px solid var(--anime-border);
    border-radius: 16px;
    overflow: hidden;
    background: var(--anime-bg-card);
    box-shadow: var(--anime-shadow);
    padding: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px;
    text-align: center;

    .empty-action-btn {
      margin-top: -16px; // EmptyState 自带 padding，调整按钮位置
    }
  }

  .fade-in {
    animation: fadeIn 0.4s ease-in-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .crawl-form {
    margin-bottom: 20px;

    :deep(.el-form-item__label) {
      color: var(--anime-text-primary);
      font-weight: 500;
    }
  }

  .progress-text {
    font-size: 12px;
    color: var(--anime-text-secondary);
    margin-top: 5px;
    display: block;
    font-weight: 500;
  }

  h3 {
    color: var(--anime-text-primary);
    font-weight: 600;
    margin-bottom: 16px;
  }

  .var-description {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .plugin-option-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .plugin-option-icon-placeholder {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    color: var(--anime-text-secondary);
  }

  /* 图片预览样式 */
  .image-preview-wrapper {
    width: 100%;
    height: 100%;
    cursor: pointer;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }

  /* 滚动条隐藏下沉到 ImageGrid（通过 :hide-scrollbar 控制），这里不再重复写 :deep 规则 */
}

/* Dialog 样式需要全局作用域才能正确应用 */
</style>

<style lang="scss">
.crawl-dialog.el-dialog {
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin-top: 5vh !important;
  margin-bottom: 5vh !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    max-height: none !important;
  }

  .el-dialog__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);
  }
}

/* "开始导入图片"->"选择导入源"下拉框：下拉面板是 teleport 到 body 的，所以必须用全局样式 */
.crawl-plugin-select-dropdown {
  .el-select-dropdown__item {
    padding: 8px 12px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .plugin-option-icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 4px;
  }

  .plugin-option-icon-placeholder {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    font-size: 18px;
    /* 控制 el-icon 的 svg 大小 */
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--anime-text-secondary);
  }

  .plugin-option span {
    line-height: 1.2;
    color: var(--anime-text-primary);
  }
}

.run-config-select-dropdown {
  .el-select-dropdown__item {
    padding: 6px 12px;
    min-height: 40px;
  }

  .run-config-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 32px;
    width: 100%;
  }

  .run-config-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;

    .name {
      font-weight: 600;
      color: var(--el-text-color-primary);
      line-height: 1.4;
      display: flex;
      align-items: center;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .incompatible-badge {
        color: var(--el-color-warning);
        font-weight: 600;
        margin-right: 4px;
      }

      .incompatible-reason {
        margin-top: 4px;
        font-size: 12px;
      }

      .error-text {
        color: var(--el-color-error);
      }

      .warning-text {
        color: var(--el-color-warning);
      }

      .desc {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        font-weight: normal;
        margin-left: 4px;
      }
    }
  }

  .run-config-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    align-self: flex-start;
    padding-top: 2px;
  }
}

/* 图片路径 tooltip 样式 */
:deep(.image-path-tooltip) {
  max-width: 400px;
  padding: 8px 12px;
}

.tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.4;
}

.tooltip-line {
  word-break: break-all;
  font-size: 12px;
}
</style>
