<template>
  <div class="gallery-page">
    <!-- 顶部工具栏 -->
    <GalleryToolbar :filter-plugin-id="filterPluginId" :plugins="plugins" :plugin-icons="pluginIcons"
      :active-running-tasks-count="activeRunningTasksCount" :show-favorites-only="showFavoritesOnly"
      :dedupe-loading="dedupeLoading" :has-more="crawlerStore.hasMore" :is-loading-all="isLoadingAll"
      @update:filter-plugin-id="filterPluginId = $event" @toggle-favorites-only="showFavoritesOnly = !showFavoritesOnly"
      @refresh="loadImages(true, { forceReload: true })" @dedupe-by-hash="handleDedupeByHash"
      @show-quick-settings="openQuickSettingsDrawer" @show-tasks-drawer="showTasksDrawer = true"
      @show-crawler-dialog="showCrawlerDialog = true" @load-all="loadAllImages" />

    <GalleryView ref="galleryViewRef" class="gallery-container" mode="gallery" :images="displayedImages"
      :image-url-map="imageSrcMap" :image-click-action="imageClickAction" :columns="galleryColumns"
      :aspect-ratio-match-window="!!galleryImageAspectRatio" :window-aspect-ratio="effectiveAspectRatio"
      :allow-select="true" :enable-context-menu="true" :show-load-more-button="true" :has-more="crawlerStore.hasMore"
      :loading-more="isLoadingMore" :is-blocked="isBlockingOverlayOpen" :loading="dedupeLoading"
      @container-mounted="(...args: any[]) => setGalleryContainerEl(args[0])"
      @adjust-columns="(...args: any[]) => throttledAdjustColumns(args[0])" @scroll-stable="loadImageUrls()"
      @load-more="loadMoreImages" @image-dbl-click="(...args: any[]) => handleImageDblClick(args[0])"
      @context-command="(...args: any[]) => handleGridContextCommand(args[0])"
      @reorder="(...args: any[]) => handleImageReorder(args[0])">
      <template #before-grid>
        <div v-if="showSkeleton" class="loading-skeleton">
          <div class="skeleton-grid">
            <div v-for="i in 20" :key="i" class="skeleton-item">
              <el-skeleton :rows="0" animated>
                <template #template>
                  <el-skeleton-item variant="image" style="width: 100%; height: 200px;" />
                </template>
              </el-skeleton>
            </div>
          </div>
        </div>

        <div v-else-if="displayedImages.length === 0 && !crawlerStore.hasMore && !isRefreshing"
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

      <template #overlays>
        <!-- 任务列表抽屉 -->
        <TaskDrawer v-model="showTasksDrawer" :tasks="runningTasks" />

        <!-- 图片详情对话框 -->
        <ImageDetailDialog v-model="showImageDetail" :image="selectedImage" />

        <!-- 加入画册对话框 -->
        <el-dialog v-model="showAlbumDialog" title="加入画册" width="420px">
          <el-form label-width="80px">
            <el-form-item label="选择画册">
              <el-select v-model="selectedAlbumId" placeholder="选择一个心仪的画册吧" style="width: 100%">
                <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
                <el-option value="__create_new__" label="+ 新建画册">
                  <span style="color: var(--el-color-primary); font-weight: 500;">+ 新建画册</span>
                </el-option>
              </el-select>
            </el-form-item>
            <el-form-item v-if="isCreatingNewAlbum" label="画册名称" required>
              <el-input v-model="newAlbumName" placeholder="请输入画册名称" maxlength="50" show-word-limit
                @keyup.enter="handleCreateAndAddAlbum" ref="newAlbumNameInputRef" />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="showAlbumDialog = false">取消</el-button>
            <el-button v-if="isCreatingNewAlbum" type="primary" :disabled="!newAlbumName.trim()"
              @click="handleCreateAndAddAlbum">确定</el-button>
            <el-button v-else type="primary" :disabled="!selectedAlbumId" @click="confirmAddToAlbum">确定</el-button>
          </template>
        </el-dialog>

        <!-- 收集对话框 -->
        <CrawlerDialog v-model="showCrawlerDialog" :plugin-icons="pluginIcons" />

        <!-- 去重确认对话框 -->
        <el-dialog v-model="showDedupeDialog" title="确认去重" width="420px" destroy-on-close>
          <div style="margin-bottom: 16px;">
            <p style="margin-bottom: 8px;">去掉所有重复图片</p>
            <el-checkbox v-model="dedupeDeleteFiles" label="同时从磁盘删除源文件（慎用）" />
            <p class="var-description" :style="{ color: dedupeDeleteFiles ? 'var(--el-color-danger)' : '' }">
              {{ dedupeDeleteFiles ? '警告：该操作将永久删除重复的磁盘文件，不可恢复！' : '不勾选仅从画廊移除记录，保留磁盘文件。' }}
            </p>
          </div>
          <template #footer>
            <el-button @click="showDedupeDialog = false">取消</el-button>
            <el-button type="primary" @click="confirmDedupeByHash" :loading="dedupeProcessing">确定</el-button>
          </template>
        </el-dialog>
      </template>
    </GalleryView>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox, ElCheckbox } from "element-plus";
import { Plus } from "@element-plus/icons-vue";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { usePluginStore } from "@/stores/plugins";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import TaskDrawer from "@/components/TaskDrawer.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import GalleryView from "@/components/GalleryView.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { useGalleryImages } from "@/composables/useGalleryImages";
import { useGallerySettings } from "@/composables/useGallerySettings";
import { useImageOperations, type FavoriteStatusChangedDetail } from "@/composables/useImageOperations";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useSettingsStore } from "@/stores/settings";
import { useLoadingDelay } from "@/utils/useLoadingDelay";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

const crawlerStore = useCrawlerStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettingsDrawer = () => quickSettingsDrawer.open("gallery");
const pluginStore = usePluginStore();
const albumStore = useAlbumStore();
const settingsStore = useSettingsStore();

const dedupeProcessing = ref(false); // 正在执行"按哈希去重"本体
const { showContent: dedupeDelayShowContent, startLoading: startDedupeDelay, finishLoading: finishDedupeDelay } = useLoadingDelay(300);
const dedupeLoading = computed(() => dedupeProcessing.value || !dedupeDelayShowContent.value);
const filterPluginId = ref<string | null>(null);
const showFavoritesOnly = ref(false);
const showCrawlerDialog = ref(false);
const showDedupeDialog = ref(false); // 去重确认对话框
const dedupeDeleteFiles = ref(false); // 是否删除本地文件
const showTasksDrawer = ref(false);
const showImageDetail = ref(false);
const galleryContainerRef = ref<HTMLElement | null>(null);
const galleryViewRef = ref<any>(null);
const showAlbumDialog = ref(false);
const currentWallpaperImageId = ref<string | null>(null);

// 状态变量（用于 composables）
const showSkeleton = ref(false);
const skeletonTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const isLoadingMore = ref(false);
const isLoadingAll = ref(false);
const isRefreshing = ref(false); // 刷新中状态，用于阻止刷新时 EmptyState 闪烁
// 刷新计数器，用于强制空占位符重新挂载以触发动画
const refreshKey = ref(0);

const setGalleryContainerEl = (el: HTMLElement) => {
  galleryContainerRef.value = el;
};
const selectedAlbumId = ref<string>("");
const newAlbumName = ref<string>("");
const pendingAlbumImages = ref<ImageInfo[]>([]);
const newAlbumNameInputRef = ref<any>(null);

// 是否正在创建新画册
const isCreatingNewAlbum = computed(() => selectedAlbumId.value === "__create_new__");
const selectedImage = ref<ImageInfo | null>(null);
// 使用画廊设置 composable
const {
  imageClickAction,
  galleryColumns,
  windowAspectRatio,
  loadSettings,
  updateWindowAspectRatio,
  handleResize,
  throttledAdjustColumns,
} = useGallerySettings();

const galleryImageAspectRatio = ref<string | null>(null); // 设置的图片宽高比（保留用于兼容）

// 监听设置 store 中宽高比的变化，实时同步到本地 ref
watch(
  () => settingsStore.values.galleryImageAspectRatio,
  (newValue) => {
    galleryImageAspectRatio.value = (newValue as string | null) || null;
  },
  { immediate: true }
);

// 计算实际使用的宽高比
const effectiveAspectRatio = computed((): number => {
  // 如果设置了宽高比，使用设置的宽高比
  if (galleryImageAspectRatio.value) {
    const value = galleryImageAspectRatio.value;

    // 解析 "16:9" 格式
    if (value.includes(":") && !value.startsWith("custom:")) {
      const [w, h] = value.split(":").map(Number);
      if (w && h && !isNaN(w) && !isNaN(h)) {
        return w / h;
      }
    }

    // 解析 "custom:1920:1080" 格式
    if (value.startsWith("custom:")) {
      const parts = value.replace("custom:", "").split(":");
      const [w, h] = parts.map(Number);
      if (w && h && !isNaN(w) && !isNaN(h)) {
        return w / h;
      }
    }
  }

  // 如果没有设置或解析失败，使用窗口宽高比
  return windowAspectRatio.value;
});
const plugins = computed(() => pluginStore.plugins);
const tasks = computed(() => crawlerStore.tasks);

// 正在运行的任务（包括 running 和 failed 状态，不包括 pending，因为 pending 任务都是无效的）
const runningTasks = computed(() => {
  // 显示所有任务（包括运行中、失败和已完成的任务）
  return tasks.value.filter(task =>
    task.status === 'running' ||
    task.status === 'failed' ||
    task.status === 'completed'
  );
});

// 真正正在运行中的任务数量（仅用于右上角徽章显示）
const activeRunningTasksCount = computed(() => {
  return tasks.value.filter(task => task.status === 'running').length;
});

// 插件配置相关的变量和函数已移至 CrawlerDialog 组件
const albums = computed(() => albumStore.albums);

// 使用画廊图片 composable
const {
  displayedImages,
  imageSrcMap,
  loadImageUrls,
  refreshImagesPreserveCache,
  refreshLatestIncremental,
  loadMoreImages: loadMoreImagesFromComposable,
  loadAllImages: loadAllImagesFromComposable,
  removeFromUiCacheByIds,
} = useGalleryImages(
  galleryContainerRef,
  filterPluginId,
  showFavoritesOnly,
  isLoadingMore
);

// 兼容旧调用：保留原函数名
const loadImages = async (reset?: boolean, opts?: { forceReload?: boolean }) => {
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
const loadAllImages = loadAllImagesFromComposable;

// 使用图片操作 composable
const {
  handleOpenImagePath,
  handleCopyImage,
  applyFavoriteChangeToGalleryCache,
  handleBatchRemove,
  handleBatchDelete,
  confirmDedupeByHash: confirmDedupeByHashFromComposable,
  toggleFavorite,
  setWallpaper,
  exportToWallpaperEngine,
} = useImageOperations(
  displayedImages,
  imageSrcMap,
  showFavoritesOnly,
  currentWallpaperImageId,
  galleryViewRef,
  removeFromUiCacheByIds,
  loadImages,
  loadMoreImages
);

// 插件图标映射，存储每个插件的图标 URL
const pluginIcons = ref<Record<string, string>>({});

// 当有弹窗/抽屉等覆盖层时，画廊不应接收鼠标/键盘事件
const isBlockingOverlayOpen = () => {
  // 本页面自身的弹窗/抽屉
  if (
    showCrawlerDialog.value ||
    showTasksDrawer.value ||
    showAlbumDialog.value ||
    showImageDetail.value
  ) {
    return true;
  }

  // Element Plus 的 Dialog/Drawer/MessageBox 等通常会创建 el-overlay（teleport 到 body）
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(".el-overlay"));
  return overlays.some((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
};

// getImageUrl 和 loadImageUrls 已移至 useGalleryImages composable

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

const openAddToAlbumDialog = async (images: ImageInfo[]) => {
  pendingAlbumImages.value = images;
  if (albums.value.length === 0) {
    await albumStore.loadAlbums();
  }
  // 重置状态
  selectedAlbumId.value = "";
  newAlbumName.value = "";
  showAlbumDialog.value = true;
};

// 配置兼容性检查相关的代码已移至 useConfigCompatibility composable 和 CrawlerDialog 组件
// 插件配置相关的函数和 watch 监听器已移至 CrawlerDialog 组件

// 打开导入对话框时，刷新插件列表（由 CrawlerDialog 组件处理兼容性检查）
watch(showCrawlerDialog, async (open) => {
  if (!open) return;
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
  }
});

// 处理新建画册并加入图片
const handleCreateAndAddAlbum = async () => {
  if (pendingAlbumImages.value.length === 0) {
    showAlbumDialog.value = false;
    return;
  }

  if (!newAlbumName.value.trim()) {
    ElMessage.warning("请输入画册名称");
    return;
  }

  try {
    // 创建新画册
    const created = await albumStore.createAlbum(newAlbumName.value.trim());

    // 添加图片到新画册（新画册为空，无需过滤）
    const allIds = pendingAlbumImages.value.map(img => img.id);
    await albumStore.addImagesToAlbum(created.id, allIds);

    // 成功后弹窗提示
    ElMessage.success(`已创建画册「${created.name}」并加入 ${allIds.length} 张图片`);

    // 关闭对话框并重置状态
    showAlbumDialog.value = false;
    pendingAlbumImages.value = [];
    selectedAlbumId.value = "";
    newAlbumName.value = "";
  } catch (error) {
    console.error("创建画册并加入图片失败:", error);
    ElMessage.error("操作失败");
  }
};

const confirmAddToAlbum = async () => {
  if (pendingAlbumImages.value.length === 0) {
    showAlbumDialog.value = false;
    return;
  }

  const albumId = selectedAlbumId.value;
  if (!albumId) {
    ElMessage.warning("请选择画册");
    return;
  }

  const allIds = pendingAlbumImages.value.map(img => img.id);

  // 过滤掉已经在画册中的图片
  let idsToAdd = allIds;
  try {
    const existingIds = await albumStore.getAlbumImageIds(albumId);
    const existingSet = new Set(existingIds);
    idsToAdd = allIds.filter(id => !existingSet.has(id));

    if (idsToAdd.length === 0) {
      ElMessage.info("所选图片已全部在画册中");
      showAlbumDialog.value = false;
      pendingAlbumImages.value = [];
      return;
    }

    if (idsToAdd.length < allIds.length) {
      const skippedCount = allIds.length - idsToAdd.length;
      ElMessage.warning(`已跳过 ${skippedCount} 张已在画册中的图片`);
    }
  } catch (error) {
    console.error("获取画册图片列表失败:", error);
    // 如果获取失败，仍然尝试添加（后端有 INSERT OR IGNORE 保护）
  }

  await albumStore.addImagesToAlbum(albumId, idsToAdd);
  ElMessage.success(`已加入画册（${idsToAdd.length} 张）`);
  showAlbumDialog.value = false;
  pendingAlbumImages.value = [];
  selectedAlbumId.value = "";
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




const handleImageDblClick = async (image: ImageInfo) => {
  // 预览功能已下沉到 ImageGrid，这里只处理 open 模式
  if (imageClickAction.value === 'open') {
    await handleOpenImagePath(image.localPath);
  }
  // preview 模式由 ImageGrid 内部处理
};

const handleGridContextCommand = async (payload: { command: string; image: ImageInfo; selectedImageIds: Set<string> }) => {
  const command = payload.command;
  const image = payload.image;
  const selectedSet = payload.selectedImageIds && payload.selectedImageIds.size > 0
    ? payload.selectedImageIds
    : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? displayedImages.value.filter(img => selectedSet.has(img.id))
    : [image];

  switch (command) {
    case 'detail':
      if (!isMultiSelect) {
        selectedImage.value = image;
        showImageDetail.value = true;
      }
      break;
    case 'favorite':
      // 仅支持普通（单张）收藏
      if (isMultiSelect) {
        ElMessage.warning("收藏仅支持单张图片");
        return;
      }
      await toggleFavorite(image);
      break;
    case 'copy':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }

      if (isMultiSelect) {
        // 批量复制（暂时只复制第一张，后续可以实现批量复制）
        await handleCopyImage(imagesToProcess[0]);
        ElMessage.success(`已复制 ${imagesToProcess.length} 张图片`);
      } else {
        await handleCopyImage(image);
      }
      break;
    case 'open':
      if (!isMultiSelect) {
        await handleOpenImagePath(image.localPath);
      }
      break;
    case 'openFolder':
      if (!isMultiSelect) {
        try {
          await invoke("open_file_folder", { filePath: image.localPath });
          ElMessage.success("已打开文件所在文件夹");
        } catch (error) {
          console.error("打开文件夹失败:", error);
          ElMessage.error("打开文件夹失败");
        }
      }
      break;
    case 'wallpaper':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }
      await setWallpaper(imagesToProcess);
      break;
    case 'exportToWEAuto':
      // 仅单选时支持
      if (isMultiSelect) {
        return;
      }
      await exportToWallpaperEngine(image);
      break;
    case 'addToAlbum':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }

      openAddToAlbumDialog(imagesToProcess);
      break;
    case 'remove':
      await handleBatchRemove(imagesToProcess);
      break;
    case 'delete':
      await handleBatchDelete(imagesToProcess);
      break;
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
  await confirmDedupeByHashFromComposable(
    dedupeProcessing,
    dedupeDeleteFiles.value,
    startDedupeDelay,
    finishDedupeDelay
  );
};


// refreshImagesPreserveCache, refreshLatestIncremental, loadMoreImages, loadAllImages 已移至 useGalleryImages composable
// 插件配置相关的函数和 watch 监听器已移至 CrawlerDialog 组件

// 监听筛选插件ID变化，重新加载图片
watch(filterPluginId, () => {
  loadImages(true);
});

// 监听仅显示收藏变化，重新加载图片
watch(showFavoritesOnly, () => {
  loadImages(true);
  galleryViewRef.value?.clearSelection?.();
});

// 监听画册选择变化，当选择"新建"时自动聚焦输入框
watch(selectedAlbumId, (newValue) => {
  if (newValue === "__create_new__") {
    // 等待 DOM 更新后聚焦输入框
    nextTick(() => {
      if (newAlbumNameInputRef.value) {
        newAlbumNameInputRef.value.focus();
      }
    });
  } else {
    // 选择已有画册时清空新建名称
    newAlbumName.value = "";
  }
});

// 监听对话框关闭，重置状态
watch(showAlbumDialog, (isOpen) => {
  if (!isOpen) {
    selectedAlbumId.value = "";
    newAlbumName.value = "";
  }
});

// 处理图片拖拽排序
const handleImageReorder = async (newOrder: ImageInfo[]) => {
  try {
    // 计算新的 order 值（间隔 1000）
    const imageOrders: [string, number][] = newOrder.map((img, index) => [
      img.id,
      (index + 1) * 1000,
    ]);

    await invoke("update_images_order", { imageOrders });

    // 更新本地显示顺序
    displayedImages.value = newOrder;

    // 同时更新 store 中的顺序
    const newStoreOrder = newOrder.map(img =>
      crawlerStore.images.find(i => i.id === img.id) || img
    );
    crawlerStore.images = newStoreOrder;

    ElMessage.success("顺序已更新");
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
    if (isLoadingMore.value) {
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
// loadSettings, updateWindowAspectRatio, handleResize, adjustColumns, throttledAdjustColumns 已移至 useGallerySettings composable
// 但需要扩展 loadSettings 以支持 galleryImageAspectRatio
const loadSettingsExtended = async () => {
  await loadSettings();
  try {
    const settings = await invoke<{
      galleryImageAspectRatio?: string | null;
    }>("get_settings");
    const aspectRatio = settings.galleryImageAspectRatio || null;
    // 同时更新 store 和本地 ref（watch 会监听 store 的变化，但这里直接设置可以确保初始化时正确）
    settingsStore.values.galleryImageAspectRatio = aspectRatio as any;
    galleryImageAspectRatio.value = aspectRatio;
  } catch (error) {
    console.error("加载宽高比设置失败:", error);
  }
};

onMounted(async () => {
  finishDedupeDelay(); // 初始化为不加载状态
  await loadSettingsExtended();
  try {
    currentWallpaperImageId.value = await invoke<string | null>("get_current_wallpaper_image_id");
  } catch {
    currentWallpaperImageId.value = null;
  }
  // 加载任务
  await crawlerStore.loadTasks();
  await pluginStore.loadPlugins();
  await crawlerStore.loadRunConfigs();
  await loadPluginIcons(); // 加载插件图标
  await loadImages(true);

  // 初始化窗口宽高比
  updateWindowAspectRatio();

  // 添加窗口大小变化监听
  window.addEventListener('resize', handleResize);

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

  window.addEventListener('task-error-display', errorDisplayHandler);

  // 保存处理器引用以便在卸载时移除
  (window as any).__taskErrorDisplayHandler = errorDisplayHandler;

  // 监听图片添加事件，实时同步画廊（仅增量刷新，避免全量图片重新加载）
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenImageAdded = await listen<{ taskId: string; imageId: string }>(
    "image-added",
    async () => {
      await refreshLatestIncremental();
    }
  );

  // 保存监听器引用以便在卸载时移除
  (window as any).__imageAddedUnlisten = unlistenImageAdded;


  // 监听“收藏状态变化”（来自画册/其它页面对收藏画册的增删）
  const favoriteChangedHandler = ((event: Event) => {
    const ce = event as CustomEvent<FavoriteStatusChangedDetail>;
    const detail = ce.detail;
    if (!detail || !Array.isArray(detail.imageIds)) return;
    applyFavoriteChangeToGalleryCache(detail.imageIds, !!detail.favorite);
  }) as EventListener;
  window.addEventListener("favorite-status-changed", favoriteChangedHandler);
  (window as any).__favoriteStatusChangedHandler = favoriteChangedHandler;
});

// 在开发环境中监控组件更新，帮助调试重新渲染问题
// 开发期调试日志已移除，保持生产干净输出

// 组件激活时（keep-alive 缓存后重新显示）
onActivated(async () => {
  // 重新加载设置，确保使用最新的 pageSize 等配置
  const previousPageSize = crawlerStore.pageSize;
  await loadSettingsExtended();
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

// 组件真正卸载时（不是 keep-alive 缓存）
onUnmounted(() => {
  // 清理骨架屏定时器
  if (skeletonTimer.value) {
    clearTimeout(skeletonTimer.value);
    skeletonTimer.value = null;
  }
  // 移除窗口大小变化监听
  window.removeEventListener('resize', handleResize);

  // 释放所有 Blob URL，避免内存泄漏（只在真正卸载时清理）
  // blobUrls 清理由 useGalleryImages composable 的 cleanup 函数处理
  // 这里只需要清理 imageSrcMap
  imageSrcMap.value = {};

  // 移除任务错误显示事件监听
  const handler = (window as any).__taskErrorDisplayHandler;
  if (handler) {
    window.removeEventListener('task-error-display', handler);
    delete (window as any).__taskErrorDisplayHandler;
  }

  // 移除图片添加事件监听
  const imageAddedUnlisten = (window as any).__imageAddedUnlisten;
  if (imageAddedUnlisten) {
    imageAddedUnlisten();
    delete (window as any).__imageAddedUnlisten;
  }


  // 移除收藏状态变化监听
  const favoriteChangedHandler = (window as any).__favoriteStatusChangedHandler;
  if (favoriteChangedHandler) {
    window.removeEventListener("favorite-status-changed", favoriteChangedHandler);
    delete (window as any).__favoriteStatusChangedHandler;
  }
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
  overflow-y: auto;

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
