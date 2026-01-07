<template>
  <div class="album-detail">
    <PageHeader :title="albumName || '画册'" :subtitle="images.length ? `共 ${images.length} 张` : ''" show-back
      @back="goBack">
      <template #title>
        <div class="album-title-wrapper">
          <input v-if="isRenaming" v-model="editingName" ref="renameInputRef" class="album-name-input"
            @blur="handleRenameConfirm" @keyup.enter="handleRenameConfirm" @keyup.esc="handleRenameCancel" />
          <span v-else class="album-name" @dblclick.stop="handleStartRename" @click.stop :title="'双击改名'">{{ albumName ||
            '画册' }}</span>
        </div>
      </template>
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
      <el-button @click="openQuickSettings" circle>
        <el-icon>
          <Setting />
        </el-icon>
      </el-button>
    </PageHeader>

    <div v-if="loading" class="detail-body detail-body-loading">
      <el-skeleton :rows="8" animated />
        </div>

    <ImageGrid v-else ref="albumViewRef" class="detail-body" :images="images" :image-url-map="imageSrcMap"
      :enable-ctrl-wheel-adjust-columns="true" :show-empty-state="true" :context-menu-component="AlbumImageContextMenu"
      :on-context-command="handleImageMenuCommand" @added-to-album="handleAddedToAlbum"
      @scroll-stable="loadImageUrls()" @reorder="(...args) => handleImageReorder(args[0])">

      <!-- 画册图片数量上限警告：作为 before-grid 插入（仅 AlbumDetail 使用） -->
      <template #before-grid>
        <div v-if="showAlbumLimitWarning" :class="['album-limit-warning', { 'is-danger': isAtLimit }]">
          <el-icon>
            <Warning v-if="!isAtLimit" />
            <CircleClose v-else />
          </el-icon>
          <span>{{ warningMessage }}</span>
        </div>
      </template>
    </ImageGrid>

    <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
      :message="removeDialogMessage" title="从画册移除" checkbox-label="同时删除图片（慎用）"
      danger-text="警告：将永久删除电脑文件，并从所有画册和画廊中移除，不可恢复！" safe-text="不勾选仅从当前画册移除，图片文件和其他画册中的记录将保留。"
      @confirm="confirmRemoveImages" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage, ElMessageBox } from "element-plus";
import { Picture, Delete, Setting, Refresh } from "@element-plus/icons-vue";
import { Warning, CircleClose } from "@element-plus/icons-vue";
import AlbumImageContextMenu from "@/components/contextMenu/AlbumImageContextMenu.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import RemoveImagesConfirmDialog from "@/components/common/RemoveImagesConfirmDialog.vue";
import { useAlbumStore } from "@/stores/albums";
import { useCrawlerStore, type ImageInfo as CrawlerImageInfo } from "@/stores/crawler";
import type { ImageInfo } from "@/stores/crawler";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import PageHeader from "@/components/common/PageHeader.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useGallerySettings } from "@/composables/useGallerySettings";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { useImageUrlLoader } from "@/composables/useImageUrlLoader";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";

const route = useRoute();
const router = useRouter();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);
const preferOriginalInGrid = computed(() => imageGridColumns.value <= 2);

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");

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
const albumViewRef = ref<any>(null);
const albumContainerRef = ref<HTMLElement | null>(null);

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

const albumAspectRatio = ref<number | null>(null);

watch(
  () => settingsStore.values.galleryImageAspectRatio,
  (newValue) => {
    if (!newValue) {
      albumAspectRatio.value = null;
      return;
    }
    const value = newValue as string;
    // 解析 "16:9" 格式
    if (value.includes(":") && !value.startsWith("custom:")) {
      const [w, h] = value.split(":").map(Number);
      if (w && h) {
        albumAspectRatio.value = w / h;
    }
    }
    // 解析 "custom:1920:1080" 格式
    if (value.startsWith("custom:")) {
      const parts = value.replace("custom:", "").split(":");
      const [w, h] = parts.map(Number);
      if (w && h) {
        albumAspectRatio.value = w / h;
      }
    }
  }
);

const clearSelection = () => {
  albumViewRef.value?.clearSelection?.();
};

// 重命名相关
const isRenaming = ref(false);
const editingName = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);

// 轮播壁纸相关
const wallpaperRotationEnabled = ref(false);
const currentRotationAlbumId = ref<string | null>(null);

// 收藏画册标记：当收藏状态变化时，如果页面在后台，标记为需要刷新
const favoriteAlbumDirty = ref(false);

// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);

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
    await loadRotationSettings();
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

const loadAlbum = async () => {
  if (!albumId.value) return;
  loading.value = true;
  let imgs: ImageInfo[] = [];
  try {
    // 仅获取图片列表时显示加载状态
    imgs = await albumStore.loadAlbumImages(albumId.value);
    images.value = imgs;

    // 清理旧资源
    resetImageUrlLoader();
  } finally {
    // 获取到列表后立即结束加载状态
    loading.value = false;
  }

  // 只优先加载视口内（以及 overscan）需要的 URL；其余在空闲时渐进补齐
  requestAnimationFrame(() => void loadImageUrls());
};

const handleImageReorder = async (payload: { aId: string; aOrder: number; bId: string; bOrder: number }) => {
  if (!albumId.value) return;

  try {
    const imageOrders: [string, number][] = [
      [payload.aId, payload.aOrder],
      [payload.bId, payload.bOrder],
    ];

    await invoke("update_album_images_order", {
      albumId: albumId.value,
      imageOrders,
    });

    const idxA = images.value.findIndex((i) => i.id === payload.aId);
    const idxB = images.value.findIndex((i) => i.id === payload.bId);
    if (idxA !== -1 && idxB !== -1) {
      const next = images.value.slice();
      [next[idxA], next[idxB]] = [next[idxB], next[idxA]];
      images.value = next.map((img) => {
        if (img.id === payload.aId) return { ...img, order: payload.aOrder } as ImageInfo;
        if (img.id === payload.bId) return { ...img, order: payload.bOrder } as ImageInfo;
        return img;
      });
    }

    ElMessage.success("顺序已更新");
  } catch (error) {
    console.error("更新画册图片顺序失败:", error);
    ElMessage.error("更新顺序失败");
  }
};

const handleAddedToAlbum = async () => {
  await albumStore.loadAlbums();
};

const handleCopyImage = async (image: ImageInfo) => {
  const imageUrl = imageSrcMap.value[image.id]?.original || imageSrcMap.value[image.id]?.thumbnail;
  if (!imageUrl) {
    ElMessage.warning("图片尚未加载完成，请稍后再试");
    return;
  }
  const response = await fetch(imageUrl);
  let blob = await response.blob();

  if (blob.type === "image/jpeg" || blob.type === "image/jpg") {
    const img = new Image();
    img.src = imageUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas context");
    ctx.drawImage(img, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("转换图片失败"))), "image/png");
    });
  }

  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  ElMessage.success("图片已复制到剪贴板");
};

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
  removeFromCacheByIds(idsArr);
  clearSelection();

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
  // 让 ImageGrid 执行默认内置行为（详情/加入画册）
  if (command === "detail" || command === "addToAlbum") {
    return command;
  }
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? images.value.filter((img) => selectedSet.has(img.id))
      : [image];

  switch (command) {
    case "favorite":
      try {
        const newFavorite = !image.favorite;
        await invoke("toggle_image_favorite", { imageId: image.id, favorite: newFavorite });
        images.value = images.value.map((img) =>
          img.id === image.id ? ({ ...img, favorite: newFavorite } as CrawlerImageInfo) : img
        );

        // 清除收藏画册的缓存，确保下次查看时重新加载
        delete albumStore.albumImages[FAVORITE_ALBUM_ID.value];
        delete albumStore.albumPreviews[FAVORITE_ALBUM_ID.value];
        // 更新收藏画册计数
        const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID.value] || 0;
        albumStore.albumCounts[FAVORITE_ALBUM_ID.value] = Math.max(0, currentCount + (newFavorite ? 1 : -1));

        // 收藏状态以 store 为准：不再通过全局事件同步
      } catch {
        ElMessage.error("操作失败");
      }
      break;
    case "copy":
      if (imagesToProcess.length > 1) {
        // 多选时复制第一张图片（浏览器限制，一次只能复制一张）
        await handleCopyImage(imagesToProcess[0]);
        ElMessage.success(`已复制 ${imagesToProcess.length} 张图片`);
      } else {
        await handleCopyImage(image);
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
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）
  // 与 Gallery 共用同一套设置
  try {
    await loadSettings();

    // 解析宽高比
    if (settingsStore.values.galleryImageAspectRatio) {
      const value = settingsStore.values.galleryImageAspectRatio;

      // 解析 "16:9" 格式
      if (value.includes(":") && !value.startsWith("custom:")) {
        const [w, h] = value.split(":").map(Number);
        if (w && h) {
          albumAspectRatio.value = w / h;
        }
      }

      // 解析 "custom:1920:1080" 格式
      if (value.startsWith("custom:")) {
        const parts = value.replace("custom:", "").split(":");
        const [w, h] = parts.map(Number);
        if (w && h) {
          albumAspectRatio.value = w / h;
        }
      }
    }
  } catch (e) {
    console.error("加载设置失败:", e);
  }

  try {
    currentWallpaperImageId.value = await invoke<string | null>("get_current_wallpaper_image_id");
  } catch {
    currentWallpaperImageId.value = null;
  }

  await loadRotationSettings();
  const id = route.params.id as string;
  if (id) {
    await initAlbum(id);
  }

  // 收藏状态以 store 为准：不再通过全局事件同步（favoriteChangedHandler 已移除）

  // 收藏状态以 store 为准：不再通过全局事件同步

  // 监听图片删除事件（来自画廊等页面的删除操作）
  const imagesDeletedHandler = ((event: Event) => {
    const ce = event as CustomEvent<{ imageIds: string[] }>;
    const detail = ce.detail;
    if (!detail || !Array.isArray(detail.imageIds)) return;

    // 从列表中移除已删除的图片
    const idsToRemove = new Set(detail.imageIds);
    const beforeCount = images.value.length;
    images.value = images.value.filter((img) => !idsToRemove.has(img.id));

    // 如果有图片被移除，清理对应的 Blob URL 和 imageSrcMap
    if (images.value.length < beforeCount) {
      removeFromCacheByIds(Array.from(idsToRemove));
    }
  }) as EventListener;

  window.addEventListener("images-deleted", imagesDeletedHandler);
  (window as any).__albumDetailImagesDeletedHandler = imagesDeletedHandler;

  // 监听图片移除事件（来自画廊等页面的移除操作）
  const imagesRemovedHandler = ((event: Event) => {
    const ce = event as CustomEvent<{ imageIds: string[] }>;
    const detail = ce.detail;
    if (!detail || !Array.isArray(detail.imageIds)) return;

    // 从列表中移除已移除的图片
    const idsToRemove = new Set(detail.imageIds);
    const beforeCount = images.value.length;
    images.value = images.value.filter((img) => !idsToRemove.has(img.id));

    // 如果有图片被移除，清理对应的 Blob URL 和 imageSrcMap
    if (images.value.length < beforeCount) {
      removeFromCacheByIds(Array.from(idsToRemove));
    }
  }) as EventListener;

  window.addEventListener("images-removed", imagesRemovedHandler);
  (window as any).__albumDetailImagesRemovedHandler = imagesRemovedHandler;

  // 监听图片添加事件（来自爬虫下载完成）
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenImageAdded = await listen<{ taskId: string; imageId: string; albumId?: string }>(
    "image-added",
    async (event) => {
      // 如果事件中包含 albumId，且与当前画册ID匹配，则添加新图片到列表
      if (event.payload.albumId && event.payload.albumId === albumId.value && event.payload.imageId) {
        const imageId = event.payload.imageId;

        // 检查图片是否已经在列表中（避免重复添加）
        if (images.value.some(img => img.id === imageId)) {
          return;
        }

        try {
          // 获取新图片的详细信息
          const newImage = await invoke<ImageInfo | null>("get_image_by_id", { imageId });
          if (!newImage) {
            return;
          }

          // 检查图片是否属于当前画册（通过获取画册图片ID列表）
          const albumImageIds = await albumStore.getAlbumImageIds(albumId.value);
          if (!albumImageIds.includes(imageId)) {
            return;
          }

          // 添加到列表：
          // 注意：useImageUrlLoader 内部用 watch(() => imagesRef.value, { deep: false })
          // 维护 imageIdSet；如果这里用 push 原地修改数组引用不变，会导致新图片永远不进入 loader 的集合。
          images.value = [...images.value, newImage];
          void loadImageUrls([newImage]);
        } catch (error) {
          console.error("添加新图片到画册失败:", error);
          // 如果获取失败，可以选择刷新整个画册作为后备方案
          // await loadAlbum();
        }
      }
    }
  );

  // 保存监听器引用以便在卸载时移除
  (window as any).__albumDetailImageAddedUnlisten = unlistenImageAdded;
});

// 组件从缓存激活时检查是否需要刷新
onActivated(async () => {
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
  } catch (error) {
    console.error("重命名失败:", error);
    ElMessage.error("重命名失败");
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
      await invoke("set_wallpaper_rotation_enabled", { enabled: true });
      wallpaperRotationEnabled.value = true;
    }
    // 设置轮播画册
    await invoke("set_wallpaper_rotation_album_id", { albumId: albumId.value });
    currentRotationAlbumId.value = albumId.value;
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
    await ElMessageBox.confirm(
      `确定要删除画册"${albumName.value}"吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );

    const deletedAlbumId = albumId.value;
    const wasEnabled = wallpaperRotationEnabled.value;
    const wasCurrentRotation = currentRotationAlbumId.value === deletedAlbumId;

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
    if (wasCurrentRotation) {
      // 清除轮播画册
      try {
        await invoke("set_wallpaper_rotation_album_id", { albumId: null });
      } finally {
        currentRotationAlbumId.value = null;
      }

      // 若轮播开启中：关闭轮播并切回单张壁纸
      if (wasEnabled) {
        try {
          await invoke("set_wallpaper_rotation_enabled", { enabled: false });
        } finally {
          wallpaperRotationEnabled.value = false;
        }

        // 切回单张壁纸：用当前壁纸路径再 set 一次，确保"单张模式"一致且设置页能显示
        if (currentWallpaperPath) {
          try {
            await invoke("set_wallpaper", { filePath: currentWallpaperPath });
          } catch (e) {
            console.warn("切回单张壁纸失败:", e);
          }
        }

        ElMessage.info("删除的画册正在用于轮播：已自动关闭轮播并切换为单张壁纸");
      }
    }

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

// 加载轮播设置
const loadRotationSettings = async () => {
  try {
    const settings = await invoke<{
      wallpaperRotationEnabled?: boolean;
      wallpaperRotationAlbumId?: string | null;
    }>("get_settings");
    wallpaperRotationEnabled.value = settings.wallpaperRotationEnabled ?? false;
    currentRotationAlbumId.value = settings.wallpaperRotationAlbumId || null;
  } catch (error) {
    console.error("加载轮播设置失败:", error);
  }
};

onBeforeUnmount(() => {
  cleanupImageUrlLoader();

  // 收藏状态以 store 为准：无需移除监听

  // 移除图片删除事件监听
  const deletedHandler = (window as any).__albumDetailImagesDeletedHandler;
  if (deletedHandler) {
    window.removeEventListener("images-deleted", deletedHandler);
    delete (window as any).__albumDetailImagesDeletedHandler;
  }

  // 移除图片移除事件监听
  const removedHandler = (window as any).__albumDetailImagesRemovedHandler;
  if (removedHandler) {
    window.removeEventListener("images-removed", removedHandler);
    delete (window as any).__albumDetailImagesRemovedHandler;
  }

  // 移除图片添加事件监听
  const imageAddedUnlisten = (window as any).__albumDetailImageAddedUnlisten;
  if (imageAddedUnlisten) {
    imageAddedUnlisten();
    delete (window as any).__albumDetailImageAddedUnlisten;
  }
});
</script>

<style scoped lang="scss">
.album-detail {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;

  .count {
    color: var(--anime-text-muted);
    font-size: 13px;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-top: 6px;
    padding-bottom: 6px;

    .image-grid-root {
      overflow: visible;
    }
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
