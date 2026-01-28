<template>
  <div class="album-detail">
    <!-- 关键：不要用 v-if 在 loading 时卸载 ImageGrid，否则 before-grid 里的 header 会闪烁 -->
    <ImageGrid ref="albumViewRef" class="detail-body" :images="images" :image-url-map="imageSrcMap"
      enable-virtual-scroll :enable-ctrl-wheel-adjust-columns="true" :show-empty-state="true"
      :loading="loading || isRefreshing" :loading-overlay="loading || isRefreshing"
      :context-menu-component="AlbumImageContextMenu" :on-context-command="handleImageMenuCommand"
      :hide-scrollbar="false" @added-to-album="handleAddedToAlbum" @scroll-stable="loadImageUrls()">

      <template #before-grid>
        <PageHeader :title="albumName || '画册'"
          :subtitle="totalImagesCount ? `共 ${totalImagesCount} 张` : (images.length ? `共 ${images.length} 张` : '')"
          show-back @back="goBack">
          <template #title>
            <div class="album-title-wrapper">
              <input v-if="isRenaming" v-model="editingName" ref="renameInputRef" class="album-name-input"
                @blur="handleRenameConfirm" @keyup.enter="handleRenameConfirm" @keyup.esc="handleRenameCancel" />
              <span v-else class="album-name" @dblclick.stop="handleStartRename" @click.stop :title="'双击改名'">{{
                albumName ||
                '画册' }}</span>
            </div>
          </template>
          <el-button v-if="albumDriveEnabled" type="primary" plain @click="openVirtualDriveAlbumFolder">
            去VD查看
          </el-button>
          <el-button @click="handleRefresh" :loading="isRefreshing" :disabled="loading || !albumId">
            <el-icon>
              <Refresh />
            </el-icon>
            刷新
          </el-button>
          <el-button type="primary" @click="handleSetAsWallpaperCarousel">
            <el-icon>
              <Picture />
            </el-icon>
            <span style="margin-left: 4px;">设为轮播壁纸</span>
          </el-button>
          <el-button type="danger" @click="handleDeleteAlbum">
            <el-icon>
              <Delete />
            </el-icon>
            <span style="margin-left: 4px;">删除画册</span>
          </el-button>
          <TaskDrawerButton />
          <el-button @click="openHelpDrawer" circle title="帮助">
            <el-icon>
              <QuestionFilled />
            </el-icon>
          </el-button>
          <el-button @click="openQuickSettings" circle>
            <el-icon>
              <Setting />
            </el-icon>
          </el-button>
        </PageHeader>

        <!-- 画册图片数量上限警告 -->
        <div v-if="showAlbumLimitWarning" :class="['album-limit-warning', { 'is-danger': isAtLimit }]">
          <el-icon>
            <Warning v-if="!isAtLimit" />
            <CircleClose v-else />
          </el-icon>
          <span>{{ warningMessage }}</span>
        </div>

        <!-- 分页器：每页 1000（leaf） -->
        <GalleryBigPaginator :total-count="totalImagesCount" :current-offset="currentOffset"
          :big-page-size="BIG_PAGE_SIZE" :is-sticky="true" @jump-to-page="handleJumpToPage" />
      </template>
    </ImageGrid>

    <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
      :message="removeDialogMessage" title="从画册移除" checkbox-label="同时删除图片（慎用）"
      danger-text="警告：将永久删除电脑文件，并从所有画册和画廊中移除，不可恢复！" safe-text="不勾选仅从当前画册移除，图片文件和其他画册中的记录将保留。"
      @confirm="confirmRemoveImages" />

    <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds"
      :exclude-album-ids="albumId ? [albumId] : []" @added="handleAddedToAlbum" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ElMessage, ElMessageBox } from "element-plus";
import { Picture, Delete, Setting, Refresh, QuestionFilled } from "@element-plus/icons-vue";
import { Warning, CircleClose } from "@element-plus/icons-vue";
import AlbumImageContextMenu from "@/components/contextMenu/AlbumImageContextMenu.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import { useAlbumStore } from "@/stores/albums";
import { useCrawlerStore, type ImageInfo as CrawlerImageInfo } from "@/stores/crawler";
import type { ImageInfo } from "@/stores/crawler";
import type { ImageInfo as CoreImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_WINDOWS, IS_LIGHT_MODE } from "@kabegame/core/env";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useGallerySettings } from "@/composables/useGallerySettings";
import { useImageOperations } from "@/composables/useImageOperations";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { useImageUrlLoader } from "@kabegame/core/composables/useImageUrlLoader";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";
import { useBigPageRoute } from "@/composables/useBigPageRoute";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { buildLeafProviderPathForPage } from "@/utils/gallery-provider-path";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";

const route = useRoute();
const router = useRouter();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);
const preferOriginalInGrid = computed(() => imageGridColumns.value <= 2);
const isAlbumDetailActive = ref(true);

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albumdetail");

// 虚拟磁盘
const isLightMode = IS_LIGHT_MODE;
const albumDriveEnabled = computed(() => !isLightMode && !!settingsStore.values.albumDriveEnabled);
const albumDriveMountPoint = computed(() => settingsStore.values.albumDriveMountPoint || "K:\\");

const openVirtualDriveAlbumFolder = async () => {
  if (!albumName.value) {
    ElMessage.warning("画册名称为空");
    return;
  }
  try {
    // 构建画册对应的虚拟磁盘文件夹路径
    console.log('albumName.value', albumName.value);
    const albumPath = `${albumDriveMountPoint.value}画册\\${albumName.value}`;
    console.log('albumPath', albumPath);
    await invoke("open_explorer", { path: albumPath });
  } catch (e) {
    console.error("打开虚拟磁盘文件夹失败:", e);
    ElMessage.error(String(e));
  }
};

// 使用画廊设置 composable
const {
  loadSettings,
} = useGallerySettings();

const albumId = ref<string>("");
const albumName = ref<string>("");
const loading = ref(false);
const isRefreshing = ref(false);
const currentWallpaperImageId = ref<string | null>(null);
const images = ref<ImageInfo[]>([]);
let leafAllImages: ImageInfo[] = [];
const totalImagesCount = ref<number>(0);
const albumViewRef = ref<any>(null);
const albumContainerRef = ref<HTMLElement | null>(null);

// leaf 分页：每页 1000 张（与后端 provider 对齐）
const BIG_PAGE_SIZE = 1000;
const { currentPage, currentOffset, jumpToPage } = useBigPageRoute({
  route,
  router,
  baseRouteName: "AlbumDetail",
  pagedRouteName: "AlbumDetailPaged",
  bigPageSize: BIG_PAGE_SIZE,
  getBaseParams: () => ({ id: albumId.value }),
  getPagedParams: (page) => ({ id: albumId.value, page: String(page) }),
});
const providerRootPath = computed(() => {
  if (!albumName.value) return "";
  // 与 VD 路径一致：画册/<albumName>
  return `画册/${albumName.value}`;
});

const handleJumpToPage = async (page: number) => {
  await jumpToPage(page);
};

// 跟随 page 变化重载当前 leaf（支持分页器跳转/浏览器前进后退）
watch(
  () => currentPage.value,
  (p, prev) => {
    if (!albumId.value) return;
    if (!albumName.value) return;
    if (p === prev) return;
    void loadAlbum({ reset: true });
  }
);

// dragScroll “太快且仍在加速”时的俏皮提示（画册开启）
const dragScrollTooFastMessages = [
  "慢慢滑嘛，人家要追不上啦 (；´д｀)ゞ",
  "你这手速开挂了吧？龟龟跟不上啦 (╥﹏╥)",
  "别飙车！龟龟晕滚动条了~ (＠_＠;)",
  "给人家留点帧率呀，慢一点点嘛 (´-﹏-`；)",
  "这速度像火箭！先等等我！ε=ε=ε=┏(゜ロ゜;)┛",
];
const pickOne = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)] || arr[0] || "";
let cleanupDragScrollTooFastListener: (() => void) | null = null;
watch(
  () => albumContainerRef.value,
  (el, prev) => {
    if (cleanupDragScrollTooFastListener) {
      cleanupDragScrollTooFastListener();
      cleanupDragScrollTooFastListener = null;
    }
    if (prev && prev !== el) {
      try {
        prev.removeEventListener("dragscroll-overspeed", onDragScrollOverspeed as any);
      } catch { }
    }
    if (!el) return;
    el.addEventListener("dragscroll-overspeed", onDragScrollOverspeed as any);
    cleanupDragScrollTooFastListener = () => {
      try {
        el.removeEventListener("dragscroll-overspeed", onDragScrollOverspeed as any);
      } catch { }
    };
  },
  { immediate: true }
);
function onDragScrollOverspeed(_ev: Event) {
  ElMessage({
    type: "info",
    message: pickOne(dragScrollTooFastMessages),
    duration: 900,
    showClose: false,
  });
}

const { isInteracting } = useImageGridAutoLoad({
  containerRef: albumContainerRef,
  onLoad: () => void loadImageUrls(),
});

const {
  imageSrcMap,
  loadImageUrls,
  removeFromCacheByIds,
  reset: resetImageUrlLoader,
  cleanup: cleanupImageUrlLoader,
} = useImageUrlLoader({
  containerRef: albumContainerRef,
  imagesRef: images,
  preferOriginalInGrid,
  gridColumns: imageGridColumns,
  isInteracting,
});

watch(
  () => albumViewRef.value,
  async () => {
    await nextTick();
    albumContainerRef.value = albumViewRef.value?.getContainerEl?.() ?? null;
    if (albumContainerRef.value && images.value.length > 0) {
      requestAnimationFrame(() => void loadImageUrls());
    }
  },
  { immediate: true }
);

// 计算当前画册的图片数量（优先使用 albumCounts，否则使用 images.length）
const currentAlbumImageCount = computed(() => {
  if (!albumId.value) return undefined;
  // 优先使用 store 中的计数（更准确，包括可能未加载的图片）
  const countFromStore = albumStore.albumCounts[albumId.value];
  if (countFromStore !== undefined) {
    return countFromStore;
  }
  // 如果没有计数，使用当前加载的图片数量
  return images.value.length;
});

const MAX_ALBUM_IMAGES = 10000;
const WARNING_THRESHOLD = 9000; // 超过 9000 时显示警告

const showAlbumLimitWarning = computed(() => {
  return (currentAlbumImageCount.value ?? 0) >= WARNING_THRESHOLD;
});

const isAtLimit = computed(() => {
  return (currentAlbumImageCount.value ?? 0) >= MAX_ALBUM_IMAGES;
});

const warningMessage = computed(() => {
  const count = currentAlbumImageCount.value ?? 0;
  if (count >= MAX_ALBUM_IMAGES) {
    return `画册图片数量已达到上限（${MAX_ALBUM_IMAGES} 张），将无法继续添加到画册`;
  }
  const remaining = MAX_ALBUM_IMAGES - count;
  return `画册图片数量即将到达上限（当前 ${count} / ${MAX_ALBUM_IMAGES}，剩余 ${remaining} 张）`;
});


const clearSelection = () => {
  albumViewRef.value?.clearSelection?.();
};

// 重命名相关
const isRenaming = ref(false);
const editingName = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);

// 轮播壁纸相关
const wallpaperRotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);
const currentRotationAlbumId = computed(() => {
  const raw = settingsStore.values.wallpaperRotationAlbumId as any as string | null | undefined;
  const id = (raw ?? "").trim();
  return id ? id : null;
});

// 收藏画册标记：当收藏状态变化时，如果页面在后台，标记为需要刷新
const favoriteAlbumDirty = ref(false);

// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<CoreImageInfo[]>([]);
const showAddToAlbumDialog = ref(false);
const addToAlbumImageIds = ref<string[]>([]);

const goBack = () => {
  router.back();
};

const handleRefresh = async () => {
  if (!albumId.value) return;
  isRefreshing.value = true;
  try {
    // 1) 刷新画册列表（名称/计数等）
    await albumStore.loadAlbums();
    const found = albumStore.albums.find((a) => a.id === albumId.value);
    if (found) albumName.value = found.name;

    // 2) 刷新轮播/当前壁纸状态（避免 UI 与后端设置不同步）
    await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);
    try {
      currentWallpaperImageId.value = await invoke<string | null>("get_current_wallpaper_image_id");
    } catch {
      currentWallpaperImageId.value = null;
    }

    // 3) 手动刷新：清缓存强制重载详情（否则 store 缓存会让 UI 看起来“没刷新”）
    delete albumStore.albumImages[albumId.value];
    delete albumStore.albumPreviews[albumId.value];

    // 4) 重新拉取图片列表 + 清理本地选择/URL 缓存
    clearSelection();
    await loadAlbum();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshing.value = false;
  }
};

const loadAlbum = async (opts?: { reset?: boolean }) => {
  if (!albumId.value) return;
  const reset = opts?.reset ?? false;
  loading.value = true;
  try {
    if (reset) {
      clearSelection();
      images.value = [];
      leafAllImages = [];
      await nextTick();
    }
    // 通过 provider 浏览获取 total + 当前页 leaf（<=1000）
    const root = providerRootPath.value;
    if (!root) return;
    const rootRes = await invoke<{ total: number }>("browse_gallery_provider", { path: root });
    totalImagesCount.value = rootRes?.total ?? 0;

    if (totalImagesCount.value <= 0) {
      leafAllImages = [];
      images.value = [];
      resetImageUrlLoader();
      return;
    }

    const leaf = buildLeafProviderPathForPage(root, totalImagesCount.value, currentPage.value);
    const leafRes = await invoke<any>("browse_gallery_provider", { path: leaf.path });
    const list: ImageInfo[] = (leafRes?.entries ?? [])
      .filter((e: any) => e?.kind === "image")
      .map((e: any) => e.image as ImageInfo);

    leafAllImages = list;
    images.value = list;

    // 清理旧资源
    resetImageUrlLoader();
  } finally {
    // 获取到列表后立即结束加载状态
    loading.value = false;
  }

  // 只优先加载视口内（以及 overscan）需要的 URL；其余在空闲时渐进补齐
  requestAnimationFrame(() => void loadImageUrls());
};


const handleAddedToAlbum = async () => {
  await albumStore.loadAlbums();
};

const { handleCopyImage } = useImageOperations(
  images,
  imageSrcMap,
  currentWallpaperImageId,
  albumViewRef,
  () => { },
  async (reset?: boolean) => {
    await loadAlbum({ reset: !!reset });
  }
);

// 确认移除图片（合并了原来的 remove 和 delete 逻辑）
const confirmRemoveImages = async () => {
  const imagesToRemove = pendingRemoveImages.value;
  if (imagesToRemove.length === 0) {
    showRemoveDialog.value = false;
    return;
  }
  if (!albumId.value) {
    showRemoveDialog.value = false;
    return;
  }

  const count = imagesToRemove.length;
  const includesCurrent =
    !!currentWallpaperImageId.value &&
    imagesToRemove.some((img) => img.id === currentWallpaperImageId.value);
  const shouldDeleteFiles = removeDeleteFiles.value;

  showRemoveDialog.value = false;

  try {
    const idsArr = imagesToRemove.map((i) => i.id);
    const isFavoriteAlbum = albumId.value === FAVORITE_ALBUM_ID.value;

    // 如果勾选了删除文件，则调用 deleteImage（会自动从所有画册移除并删除文件）
    // 否则只从当前画册移除，保留文件和其他画册中的记录
    if (shouldDeleteFiles) {
      // 删除图片：deleteImage 会从所有画册中移除并删除文件
      for (const img of imagesToRemove) {
        await crawlerStore.deleteImage(img.id);
      }
      // 注意：deleteImage 已经会从所有画册中移除图片，不需要再调用 removeImagesFromAlbum
    } else {
      // 只从当前画册移除，不删除文件
      await albumStore.removeImagesFromAlbum(albumId.value, idsArr);
    }

    if (includesCurrent) {
      currentWallpaperImageId.value = null;
    }

    const ids = new Set(idsArr);
    // 如果是从收藏画册移除，更新本地图片的 favorite 字段为 false
    if (isFavoriteAlbum && !shouldDeleteFiles) {
      images.value = images.value.map((img) => {
        if (ids.has(img.id)) {
          return { ...img, favorite: false } as ImageInfo;
        }
        return img;
      });
    }

    // 如果删除了文件，需要从列表中移除；如果只是从画册移除，也需要从列表中移除
    images.value = images.value.filter((img) => !ids.has(img.id));
    leafAllImages = leafAllImages.filter((img) => !ids.has(img.id));
    removeFromCacheByIds(idsArr);
    clearSelection();
    if (totalImagesCount.value > 0) {
      totalImagesCount.value = Math.max(0, totalImagesCount.value - idsArr.length);
    }

    // 根据操作类型显示不同的成功消息
    if (shouldDeleteFiles) {
      ElMessage.success(
        `${count > 1 ? `已删除 ${count} 张图片` : "已删除图片"}（已从所有画册和画廊中移除）`
      );
    } else {
      ElMessage.success(
        `${count > 1 ? `已从画册移除 ${count} 张图片` : "已从画册移除图片"}`
      );
    }
  } catch (error) {
    console.error("操作失败:", error);
    ElMessage.error(shouldDeleteFiles ? "删除失败" : "移除失败");
  }
};

const handleImageMenuCommand = async (payload: ContextCommandPayload): Promise<import("@/components/ImageGrid.vue").ContextCommand | null> => {
  const command = payload.command;
  const image = payload.image;
  // 让 ImageGrid 执行默认内置行为（详情）
  if (command === "detail") return command;

  // 从本地列表中查找图片对象（确保获取完整的图片信息）
  const imageInList = images.value.find((img) => img.id === image.id);
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? images.value.filter((img) => selectedSet.has(img.id))
    : imageInList
      ? [imageInList]
      : [];

  switch (command) {
    case "favorite": {
      const desiredFavorite = imagesToProcess.some((img) => !(img.favorite ?? false));
      const toChange = imagesToProcess.filter(
        (img) => (img.favorite ?? false) !== desiredFavorite
      );
      if (toChange.length === 0) {
        ElMessage.info(desiredFavorite ? "已收藏" : "已取消收藏");
        break;
      }

      const results = await Promise.allSettled(
        toChange.map((img) =>
          invoke("toggle_image_favorite", {
            imageId: img.id,
            favorite: desiredFavorite,
          })
        )
      );
      const succeededIds: string[] = [];
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") succeededIds.push(toChange[idx]!.id);
      });
      if (succeededIds.length === 0) {
        ElMessage.error("操作失败");
        break;
      }

      const succeededSet = new Set(succeededIds);
      const isFavoriteAlbum = albumId.value === FAVORITE_ALBUM_ID.value;

      // 1) 更新当前页面列表
      if (isFavoriteAlbum && !desiredFavorite) {
        images.value = images.value.filter((img) => !succeededSet.has(img.id));
        leafAllImages = leafAllImages.filter((img) => !succeededSet.has(img.id));
        if (totalImagesCount.value > 0) {
          totalImagesCount.value = Math.max(0, totalImagesCount.value - succeededIds.length);
        }
      } else {
        images.value = images.value.map((img) =>
          succeededSet.has(img.id) ? ({ ...img, favorite: desiredFavorite } as ImageInfo) : img
        );
        leafAllImages = leafAllImages.map((img) =>
          succeededSet.has(img.id) ? ({ ...img, favorite: desiredFavorite } as ImageInfo) : img
        );
      }

      // 2) 更新收藏画册计数（用于画册页预览/计数显示）
      const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID.value] || 0;
      albumStore.albumCounts[FAVORITE_ALBUM_ID.value] = Math.max(
        0,
        currentCount + (desiredFavorite ? succeededIds.length : -succeededIds.length)
      );

      // 3) 若收藏画册图片缓存已加载：同步更新缓存数组
      const favList = albumStore.albumImages[FAVORITE_ALBUM_ID.value];
      if (Array.isArray(favList)) {
        if (desiredFavorite) {
          for (const img of toChange) {
            if (!succeededSet.has(img.id)) continue;
            const idx = favList.findIndex((x) => x.id === img.id);
            if (idx === -1) favList.push({ ...(img as any), favorite: true } as any);
            else favList[idx] = { ...(favList[idx] as any), favorite: true } as any;
          }
        } else {
          for (let i = favList.length - 1; i >= 0; i--) {
            if (succeededSet.has(favList[i]!.id)) favList.splice(i, 1);
          }
        }
      }

      clearSelection();
      ElMessage.success(desiredFavorite ? `已收藏 ${succeededIds.length} 张` : `已取消收藏 ${succeededIds.length} 张`);
      break;
    }
    case "copy":
      // 单选时复制图片（多选时已在 MultiImageContextMenu 中隐藏复制选项）
      if (imagesToProcess[0]) {
        await handleCopyImage(imagesToProcess[0]);
      }
      break;
    case "open":
      if (!isMultiSelect) {
        await invoke("open_file_path", { filePath: image.localPath });
      }
      break;
    case "openFolder":
      if (!isMultiSelect) {
        await invoke("open_file_folder", { filePath: image.localPath });
      }
      break;
    case "wallpaper":
      if (!isMultiSelect) {
        await invoke("set_wallpaper_by_image_id", { imageId: image.id });
        currentWallpaperImageId.value = image.id;
      }
      break;
    case "exportToWE":
    case "exportToWEAuto":
      try {
        // 让用户输入工程名称
        const defaultName =
          imagesToProcess.length > 1
            ? `Kabegame_AlbumDetailSelection_${imagesToProcess.length}_Images`
            : `Kabegame_${image.id}`;

        const { value: projectName } = await ElMessageBox.prompt(
          `请输入 WE 工程名称（留空使用默认名称）`,
          "导出到 Wallpaper Engine",
          {
            confirmButtonText: "导出",
            cancelButtonText: "取消",
            inputPlaceholder: defaultName,
            inputValidator: (value) => {
              if (value && value.trim().length > 64) {
                return "名称不能超过 64 个字符";
              }
              return true;
            },
          }
        ).catch(() => ({ value: null })); // 用户取消时返回 null

        if (projectName === null) break; // 用户取消

        let outputParentDir = "";
        if (command === "exportToWEAuto") {
          const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
          if (!mp) {
            ElMessage.warning("未配置 Wallpaper Engine 目录：请到 设置 -> 壁纸轮播 -> Wallpaper Engine 目录 先选择");
            break;
          }
          outputParentDir = mp;
        } else {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "选择导出目录（将自动创建 Wallpaper Engine 工程文件夹）",
          });
          if (!selected || Array.isArray(selected)) break;
          outputParentDir = selected;
        }

        // 使用用户输入的名称，如果为空则使用默认名称
        const finalName = projectName?.trim() || defaultName;

        const res = await invoke<{ projectDir: string; imageCount: number }>(
          "export_images_to_we_project",
          {
            imagePaths: imagesToProcess.map((img) => img.localPath),
            title: finalName,
            outputParentDir,
            options: null,
          }
        );
        ElMessage.success(`已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`);
        await invoke("open_file_path", { filePath: res.projectDir });
      } catch (e) {
        if (e !== "cancel") {
          console.error("导出 Wallpaper Engine 工程失败:", e);
          ElMessage.error("导出失败");
        }
      }
      break;
    case "addToAlbum": {
      const ids = imagesToProcess.map((img) => img.id);
      addToAlbumImageIds.value = ids;
      showAddToAlbumDialog.value = true;
      break;
    }
    case "remove":
      // 显示移除对话框，让用户选择是否删除文件
      pendingRemoveImages.value = imagesToProcess;
      const count = imagesToProcess.length;
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);
      const currentHint = includesCurrent
        ? `\n\n注意：其中包含当前壁纸。移除/删除不会立刻改变桌面壁纸，但下次启动将无法复现该壁纸。`
        : "";
      removeDialogMessage.value = `将从当前画册移除${count > 1 ? `这 ${count} 张图片` : "这张图片"}。${currentHint}`;
      removeDeleteFiles.value = false; // 默认不删除文件
      showRemoveDialog.value = true;
      break;
  }
  return null;
};

// 初始化/刷新画册数据
const initAlbum = async (newAlbumId: string) => {
  // 如果是同一个画册，检查是否需要重新加载
  // 如果 store 中没有缓存（可能被刷新清除了），即使画册ID相同也要重新加载
  const hasCache = !!albumStore.albumImages[newAlbumId];
  if (albumId.value === newAlbumId && images.value.length > 0 && hasCache) {
    return;
  }

  // 先设置 loading，避免显示空状态
  loading.value = true;

  // 清理旧数据
  resetImageUrlLoader();
  images.value = [];
  clearSelection();

  albumId.value = newAlbumId;
  await albumStore.loadAlbums();
  const found = albumStore.albums.find((a) => a.id === newAlbumId);
  albumName.value = found?.name || "画册";

  // 清除store中的缓存，强制重新加载
  delete albumStore.albumImages[newAlbumId];
  await loadAlbum();
};

// 监听路由参数变化
watch(
  () => route.params.id,
  async (newId) => {
    if (newId && typeof newId === "string") {
      await initAlbum(newId);
    }
  }
);

onMounted(async () => {
  isAlbumDetailActive.value = true;
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）
  // 与 Gallery 共用同一套设置
  try {
    await loadSettings();
    // 加载虚拟磁盘设置
    await settingsStore.loadMany(["albumDriveEnabled", "albumDriveMountPoint"]);
  } catch (e) {
    console.error("加载设置失败:", e);
  }

  try {
    currentWallpaperImageId.value = await invoke<string | null>("get_current_wallpaper_image_id");
  } catch {
    currentWallpaperImageId.value = null;
  }

  await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);
  const id = route.params.id as string;
  if (id) {
    await initAlbum(id);
  }

  // 收藏状态以 store 为准：不再通过全局事件同步（favoriteChangedHandler 已移除）

  // 收藏状态以 store 为准：不再通过全局事件同步

  // 说明：图片变更的同步由 `images-change`（失效信号）驱动，统一走“刷新当前页”。

  // 画册图片变更：由 `images-change`（失效信号）统一驱动刷新（见下方 useImagesChangeRefresh）
});

// 组件从缓存激活时检查是否需要刷新
onActivated(async () => {
  isAlbumDetailActive.value = true;
  const id = route.params.id as string;
  if (id && id !== albumId.value) {
    await initAlbum(id);
    return;
  }

  // 如果是收藏画册且标记为需要刷新，重新加载
  if (albumId.value === FAVORITE_ALBUM_ID.value && favoriteAlbumDirty.value) {
    favoriteAlbumDirty.value = false;
    await loadAlbum();
  }
});

onDeactivated(() => {
  isAlbumDetailActive.value = false;
});

// 开始重命名
const handleStartRename = async (event?: MouseEvent) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!albumId.value) {
    console.warn("无法重命名：画册ID为空");
    return;
  }
  console.log("开始重命名画册:", albumName.value);
  editingName.value = albumName.value;
  isRenaming.value = true;
  await nextTick();
  renameInputRef.value?.focus();
  renameInputRef.value?.select();
};

// 确认重命名
const handleRenameConfirm = async () => {
  if (!albumId.value) {
    isRenaming.value = false;
    return;
  }
  const newName = editingName.value.trim();
  if (!newName) {
    ElMessage.warning("画册名称不能为空");
    isRenaming.value = false;
    return;
  }
  if (newName === albumName.value) {
    isRenaming.value = false;
    return;
  }
  try {
    await albumStore.renameAlbum(albumId.value, newName);
    albumName.value = newName;
    ElMessage.success("重命名成功");
  } catch (error: any) {
    console.error("重命名失败:", error);
    // 提取友好的错误信息
    const errorMessage = typeof error === "string"
      ? error
      : error?.message || String(error) || "未知错误";
    ElMessage.error(errorMessage);
  } finally {
    isRenaming.value = false;
  }
};

// 取消重命名
const handleRenameCancel = () => {
  isRenaming.value = false;
  editingName.value = "";
};


// 设为轮播壁纸
const handleSetAsWallpaperCarousel = async () => {
  if (!albumId.value) return;
  try {
    if (images.value.length === 0) {
      ElMessage.warning("画册为空：请先添加图片，再开启轮播");
      return;
    }
    // 如果轮播未开启，先开启轮播
    if (!wallpaperRotationEnabled.value) {
      await setWallpaperRotationEnabled(true);
    }
    // 设置轮播画册
    await setWallpaperRotationAlbumId(albumId.value);
    ElMessage.success(`已开启轮播：画册「${albumName.value}」`);
  } catch (error) {
    console.error("设置轮播画册失败:", error);
    ElMessage.error("设置失败");
  }
};

// 删除画册
const handleDeleteAlbum = async () => {
  if (!albumId.value) return;

  // 检查是否为"收藏"画册
  if (albumId.value === FAVORITE_ALBUM_ID.value) {
    ElMessage.warning("不能删除'收藏'画册");
    return;
  }

  try {
   

    const deletedAlbumId = albumId.value;
    const wasEnabled = wallpaperRotationEnabled.value;
    const wasCurrentRotation = currentRotationAlbumId.value === deletedAlbumId;
  
    await ElMessageBox.confirm(
      `确定要删除画册"${albumName.value}"吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );

    // 先读一下当前壁纸（用于切回单张壁纸时保持不变）
    let currentWallpaperPath: string | null = null;
    if (wasEnabled && wasCurrentRotation) {
      try {
        currentWallpaperPath = await invoke<string | null>("get_current_wallpaper_path");
      } catch {
        currentWallpaperPath = null;
      }
    }

    // 删除画册
    await albumStore.deleteAlbum(deletedAlbumId);

    // 如果删除的是当前轮播画册：自动关闭轮播并切回单张壁纸
    // if (wasCurrentRotation) {
    //   // 清除轮播画册
    //   try {
    //     await setWallpaperRotationAlbumId(null);
    //   } catch {
    //     // 静默失败
    //   }

    //   // 若轮播开启中：关闭轮播并切回单张壁纸
    //   if (wasEnabled) {
    //     try {
    //       await setWallpaperRotationEnabled(false);
    //     } catch {
    //       // 静默失败
    //     }

    //     // 切回单张壁纸：用当前壁纸路径再 set 一次，确保"单张模式"一致且设置页能显示
    //     if (currentWallpaperPath) {
    //       try {
    //         await invoke("set_wallpaper", { filePath: currentWallpaperPath });
    //       } catch (e) {
    //         console.warn("切回单张壁纸失败:", e);
    //       }
    //     }

    //     ElMessage.info("删除的画册正在用于轮播：已自动关闭轮播并切换为单张壁纸");
    //   }
    // }

    ElMessage.success("删除成功");
    // 返回上一页
    router.back();
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      ElMessage.error("删除失败");
    }
  }
};

// 统一图片变更事件：不做增量同步，收到 images-change 后刷新“当前页”（1000ms trailing 节流，不丢最后一次）
useImagesChangeRefresh({
  enabled: isAlbumDetailActive,
  waitMs: 1000,
  filter: (p) => {
    if (!albumId.value) return false;
    // 如果指定了 albumId，必须匹配当前画册
    if (p.albumId) {
      return p.albumId === albumId.value;
    }
    // 全局事件（如删除图片）：检查是否涉及当前显示的图片
    const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
    if (ids.length > 0) {
      return ids.some((id) => leafAllImages.some((img) => img.id === id));
    }
    return true;
  },
  onRefresh: async () => {
    if (!albumId.value) return;
    const prevList = images.value.slice();
    // 清缓存强制重载详情（避免 store 缓存让 UI 看起来“没刷新”）
    delete albumStore.albumImages[albumId.value];
    delete albumStore.albumPreviews[albumId.value];
    clearSelection();
    await loadAlbum();

    const { addedIds, removedIds } = diffById(prevList, images.value);
    if (removedIds.length > 0) {
      removeFromCacheByIds(removedIds);
      clearSelection();
    }
    if (addedIds.length > 0) {
      const addedSet = new Set(addedIds);
      const addedImages = images.value.filter((img) => addedSet.has(img.id));
      if (addedImages.length > 0) {
        void loadImageUrls(addedImages);
      }
    }
  },
});

onBeforeUnmount(() => {
  cleanupImageUrlLoader();

  // 收藏状态以 store 为准：无需移除监听

});
</script>

<style scoped lang="scss">
.album-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;

  .count {
    color: var(--anime-text-muted);
    font-size: 13px;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;

    .image-grid-root {
      overflow: visible;
    }
  }

  .detail-body-loading {
    padding: 20px;
  }

  .album-grid {
    width: 100%;
    height: 100%;
  }

}

.album-title-wrapper {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}

.album-name {
  cursor: pointer;
  user-select: none;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  background-image: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  position: relative;

  &:hover {
    &::before {
      content: '';
      position: absolute;
      inset: 0;
      background-color: var(--anime-bg-secondary);
      border-radius: 4px;
      z-index: -1;
    }
  }
}

.album-name-input {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  background: var(--anime-bg-secondary);
  border: 2px solid var(--anime-primary);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--anime-text);
  outline: none;
  width: 100%;
  max-width: 400px;
  font-family: inherit;

  &:focus {
    border-color: var(--anime-primary);
    box-shadow: 0 0 0 2px rgba(var(--anime-primary-rgb, 64, 158, 255), 0.2);
  }
}
</style>
