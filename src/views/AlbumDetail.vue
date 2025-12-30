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
    </PageHeader>

    <GalleryView ref="albumViewRef" class="detail-body" mode="albumDetail" :loading="loading" :images="images"
      :image-url-map="imageSrcMap" :columns="albumColumns" :aspect-ratio-match-window="false"
      :window-aspect-ratio="16 / 9" :allow-select="true" :enable-ctrl-wheel-adjust-columns="true"
      :is-blocked="isBlockingOverlayOpen" @adjust-columns="throttledAdjustColumns"
      @selection-change="handleSelectionChange" @image-dbl-click="handleImageDblClick"
      @contextmenu="handleImageContextMenu">
      <template #before-grid>
        <div v-if="!loading && !images.length" class="empty-state">
          <img src="/album-empty.png" alt="空画册" class="empty-image" />
          <p class="empty-tip">まだ空っぽだけど、これから色々お友達を作っていくのだ！</p>
        </div>
      </template>

      <template #overlays>
        <ImageContextMenu :visible="imageMenuVisible" :position="imageMenuPosition" :image="imageMenuImage"
          :selected-count="Math.max(1, selectedImages.size)" :is-image-selected="isImageMenuImageSelected"
          :simplified-multi-select-menu="true" :hide-favorite-and-add-to-album="selectedImages.size === 1"
          remove-text="从画册移除" @close="imageMenuVisible = false" @command="handleImageMenuCommand" />

        <ImagePreviewDialog v-model="showPreview" v-model:image-url="previewUrl" :image-path="previewPath"
          :image="previewImage" />

        <ImageDetailDialog v-model="showImageDetail" :image="selectedDetailImage" />

        <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="pendingAddToAlbumImageIds"
          @added="handleAddedToAlbum" />
      </template>
    </GalleryView>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage, ElMessageBox } from "element-plus";
import { Picture, Delete } from "@element-plus/icons-vue";
import ImagePreviewDialog from "@/components/ImagePreviewDialog.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import ImageContextMenu from "@/components/ImageContextMenu.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import GalleryView from "@/components/GalleryView.vue";
import { useAlbumStore } from "@/stores/albums";
import { useCrawlerStore, type ImageInfo as CrawlerImageInfo } from "@/stores/crawler";
import type { ImageInfo } from "@/stores/crawler";
import PageHeader from "@/components/common/PageHeader.vue";

const route = useRoute();
const router = useRouter();
const albumStore = useAlbumStore();
const crawlerStore = useCrawlerStore();

// 收藏画册的固定ID（与后端保持一致）
const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";

const albumId = ref<string>("");
const albumName = ref<string>("");
const loading = ref(false);
const images = ref<ImageInfo[]>([]);
const imageSrcMap = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const blobUrls = new Set<string>();

const selectedImages = ref<Set<string>>(new Set());
const albumViewRef = ref<any>(null);

// 画册详情页本地列数（0 表示 auto-fill）
const albumColumns = ref(0);

// 当有弹窗/抽屉等覆盖层时，不应处理画廊快捷键（避免误触）
const isBlockingOverlayOpen = () => {
  // 本页面自身的弹窗
  if (showPreview.value || showImageDetail.value || showAddToAlbumDialog.value) return true;

  // Element Plus 的 Dialog/Drawer/MessageBox 等通常会创建 el-overlay（teleport 到 body）
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(".el-overlay"));
  return overlays.some((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
};

// 调整列数（与 Gallery 行为对齐，但不写入全局设置）
const adjustColumns = (delta: number) => {
  if (delta > 0) {
    if (albumColumns.value === 0) {
      albumColumns.value = 5;
    } else if (albumColumns.value < 10) {
      albumColumns.value++;
    }
  } else {
    if (albumColumns.value > 1) {
      albumColumns.value--;
    } else if (albumColumns.value === 1) {
      albumColumns.value = 0;
    }
  }
  // 与 Gallery 共用同一套列数设置
  invoke("set_gallery_columns", { columns: albumColumns.value }).catch((error) => {
    console.error("保存列数设置失败:", error);
  });
};

const throttle = <T extends (...args: any[]) => any>(func: T, delay: number): T => {
  let lastCall = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      return func(...args);
    }
  }) as T;
};

const throttledAdjustColumns = throttle(adjustColumns, 100);

const handleSelectionChange = (ids: Set<string>) => {
  // 始终用新 Set，避免外部误改导致状态不同步
  selectedImages.value = new Set(ids);
};

const clearSelection = () => {
  albumViewRef.value?.clearSelection?.();
  selectedImages.value = new Set();
};

const showPreview = ref(false);
const previewUrl = ref("");
const previewPath = ref("");
const previewImage = ref<ImageInfo | null>(null);
const showImageDetail = ref(false);
const selectedDetailImage = ref<ImageInfo | null>(null);

const imageMenuVisible = ref(false);
const imageMenuPosition = ref({ x: 0, y: 0 });
const imageMenuImage = ref<ImageInfo | null>(null);
const showAddToAlbumDialog = ref(false);
const pendingAddToAlbumImageIds = ref<string[]>([]);

const isImageMenuImageSelected = computed(() => {
  if (!imageMenuImage.value) return true;
  if (selectedImages.value.size <= 1) return true;
  return selectedImages.value.has(imageMenuImage.value.id);
});

// 重命名相关
const isRenaming = ref(false);
const editingName = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);

// 轮播壁纸相关
const wallpaperRotationEnabled = ref(false);
const currentRotationAlbumId = ref<string | null>(null);

// 收藏画册标记：当收藏状态变化时，如果页面在后台，标记为需要刷新
const favoriteAlbumDirty = ref(false);

const goBack = () => {
  router.back();
};

const getImageUrl = async (localPath: string): Promise<string> => {
  if (!localPath) return "";
  try {
    const normalizedPath = localPath.trimStart().replace(/^\\\\\?\\/, "");
    const fileData = await readFile(normalizedPath);
    const ext = normalizedPath.split(".").pop()?.toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    else if (ext === "gif") mimeType = "image/gif";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "bmp") mimeType = "image/bmp";
    const blob = new Blob([fileData], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return url;
  } catch (e) {
    console.error("加载图片失败", e);
    return "";
  }
};

const loadAlbum = async () => {
  if (!albumId.value) return;
  loading.value = true;
  try {
    const imgs = await albumStore.loadAlbumImages(albumId.value);
    images.value = imgs;

    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.clear();
    imageSrcMap.value = {};

    for (const img of imgs) {
      const thumbnailUrl = img.thumbnailPath ? await getImageUrl(img.thumbnailPath) : "";
      const originalUrl = await getImageUrl(img.localPath);
      imageSrcMap.value[img.id] = { thumbnail: thumbnailUrl, original: originalUrl };
    }
  } finally {
    loading.value = false;
  }
};

const handleImageDblClick = (image: ImageInfo) => {
  previewImage.value = image;
  previewPath.value = image.localPath;
  previewUrl.value = imageSrcMap.value[image.id]?.original || "";
  showPreview.value = true;
};

const handleImageContextMenu = (event: MouseEvent, image: ImageInfo) => {
  event.preventDefault();
  imageMenuImage.value = image;
  imageMenuPosition.value = { x: event.clientX, y: event.clientY };
  imageMenuVisible.value = true;
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

const handleBatchRemoveImagesFromAlbum = async (imagesToRemove: ImageInfo[]) => {
  if (imagesToRemove.length === 0) return;
  if (!albumId.value) return;
  const count = imagesToRemove.length;
  await ElMessageBox.confirm(
    `将从当前画册移除，但不会删除图片文件。是否继续移除${count > 1 ? `这 ${count} 张图片` : "这张图片"}？`,
    "确认从画册移除",
    { type: "warning" }
  );

  try {
    const idsArr = imagesToRemove.map((i) => i.id);
    await albumStore.removeImagesFromAlbum(albumId.value, idsArr);

    const ids = new Set(idsArr);
    images.value = images.value.filter((img) => !ids.has(img.id));
    for (const id of ids) {
      const data = imageSrcMap.value[id];
      if (data?.thumbnail) URL.revokeObjectURL(data.thumbnail);
      if (data?.original) URL.revokeObjectURL(data.original);
      const { [id]: _, ...rest } = imageSrcMap.value;
      imageSrcMap.value = rest;
    }
    clearSelection();
    ElMessage.success(`${count > 1 ? `已从画册移除 ${count} 张图片` : "已从画册移除图片"}`);
  } catch (error) {
    console.error("从画册移除图片失败:", error);
    ElMessage.error("移除失败");
  }
};

const handleBatchDeleteImages = async (imagesToDelete: ImageInfo[]) => {
  if (imagesToDelete.length === 0) return;
  const count = imagesToDelete.length;
  await ElMessageBox.confirm(
    `删除后将同时移除原图、缩略图及数据库记录，且无法恢复。是否继续删除${count > 1 ? `这 ${count} 张图片` : "这张图片"}？`,
    "确认删除",
    { type: "warning" }
  );

  for (const img of imagesToDelete) {
    await crawlerStore.deleteImage(img.id);
  }

  const ids = new Set(imagesToDelete.map((i) => i.id));
  images.value = images.value.filter((img) => !ids.has(img.id));
  for (const id of ids) {
    const data = imageSrcMap.value[id];
    if (data?.thumbnail) URL.revokeObjectURL(data.thumbnail);
    if (data?.original) URL.revokeObjectURL(data.original);
    const { [id]: _, ...rest } = imageSrcMap.value;
    imageSrcMap.value = rest;
  }
  clearSelection();
};

const handleImageMenuCommand = async (command: string) => {
  const image = imageMenuImage.value;
  if (!image) return;
  imageMenuVisible.value = false;

  const imagesToProcess =
    selectedImages.value.size > 1
      ? images.value.filter((img) => selectedImages.value.has(img.id))
      : [image];

  switch (command) {
    case "detail":
      selectedDetailImage.value = image;
      showImageDetail.value = true;
      break;
    case "favorite":
      try {
        const newFavorite = !image.favorite;
        await invoke("toggle_image_favorite", { imageId: image.id, favorite: newFavorite });
        images.value = images.value.map((img) =>
          img.id === image.id ? ({ ...img, favorite: newFavorite } as CrawlerImageInfo) : img
        );

        // 清除收藏画册的缓存，确保下次查看时重新加载
        delete albumStore.albumImages[FAVORITE_ALBUM_ID];
        delete albumStore.albumPreviews[FAVORITE_ALBUM_ID];
        // 更新收藏画册计数
        const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID] || 0;
        albumStore.albumCounts[FAVORITE_ALBUM_ID] = Math.max(0, currentCount + (newFavorite ? 1 : -1));

        // 发出收藏状态变化事件，通知其他页面更新
        window.dispatchEvent(
          new CustomEvent("favorite-status-changed", {
            detail: { imageIds: [image.id], favorite: newFavorite },
          })
        );
      } catch {
        ElMessage.error("操作失败");
      }
      break;
    case "addToAlbum":
      pendingAddToAlbumImageIds.value = imagesToProcess.map((i) => i.id);
      showAddToAlbumDialog.value = true;
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
      await invoke("open_file_path", { filePath: image.localPath });
      break;
    case "openFolder":
      await invoke("open_file_folder", { filePath: image.localPath });
      break;
    case "wallpaper":
      await invoke("set_wallpaper", { filePath: image.localPath });
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
      await handleBatchRemoveImagesFromAlbum(imagesToProcess);
      break;
    case "delete":
      await handleBatchDeleteImages(imagesToProcess);
      break;
  }
};

// 初始化/刷新画册数据
const initAlbum = async (newAlbumId: string) => {
  // 如果是同一个画册，不重复加载
  if (albumId.value === newAlbumId && images.value.length > 0) {
    return;
  }

  // 先设置 loading，避免显示空状态
  loading.value = true;

  // 清理旧数据
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
  images.value = [];
  imageSrcMap.value = {};
  clearSelection();

  albumId.value = newAlbumId;
  await albumStore.loadAlbums();
  const found = albumStore.albums.find((a) => a.id === newAlbumId);
  albumName.value = found?.name || "画册";
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
  // 与 Gallery 共用同一套列数：进入画册页时读取一次设置
  try {
    const settings = await invoke<{ galleryColumns?: number }>("get_settings");
    albumColumns.value = settings.galleryColumns || 0;
  } catch (e) {
    console.error("加载列数设置失败:", e);
  }

  await loadRotationSettings();
  const id = route.params.id as string;
  if (id) {
    await initAlbum(id);
  }

  // 监听收藏状态变化事件（来自画廊等页面的收藏操作）
  const favoriteChangedHandler = ((event: Event) => {
    const ce = event as CustomEvent<{ imageIds: string[]; favorite: boolean }>;
    const detail = ce.detail;
    if (!detail || !Array.isArray(detail.imageIds)) return;

    // 只处理收藏画册详情页
    if (albumId.value !== FAVORITE_ALBUM_ID) return;

    // 检查当前页面是否激活（通过检查路由是否匹配）
    const currentRouteId = route.params.id as string;
    const isActive = currentRouteId === FAVORITE_ALBUM_ID;

    if (detail.favorite === false) {
      // 取消收藏：从列表中移除对应图片
      const idsToRemove = new Set(detail.imageIds);
      images.value = images.value.filter((img) => !idsToRemove.has(img.id));

      // 清理对应的 Blob URL 和 imageSrcMap
      for (const id of idsToRemove) {
        const data = imageSrcMap.value[id];
        if (data?.thumbnail) {
          URL.revokeObjectURL(data.thumbnail);
          blobUrls.delete(data.thumbnail);
        }
        if (data?.original) {
          URL.revokeObjectURL(data.original);
          blobUrls.delete(data.original);
        }
        delete imageSrcMap.value[id];
      }

      // 清除选中状态
      for (const id of idsToRemove) {
        selectedImages.value.delete(id);
      }
    } else {
      // 新增收藏：需要重新加载以获取完整的 ImageInfo
      if (isActive) {
        // 页面激活时立即刷新
        loadAlbum();
      } else {
        // 页面在后台时标记为需要刷新
        favoriteAlbumDirty.value = true;
      }
    }
  }) as EventListener;

  window.addEventListener("favorite-status-changed", favoriteChangedHandler);
  (window as any).__albumDetailFavoriteHandler = favoriteChangedHandler;
});

// 组件从缓存激活时检查是否需要刷新
onActivated(async () => {
  const id = route.params.id as string;
  if (id && id !== albumId.value) {
    await initAlbum(id);
    return;
  }

  // 如果是收藏画册且标记为需要刷新，重新加载
  if (albumId.value === FAVORITE_ALBUM_ID && favoriteAlbumDirty.value) {
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
    // 如果轮播未开启，先开启轮播
    if (!wallpaperRotationEnabled.value) {
      await invoke("set_wallpaper_rotation_enabled", { enabled: true });
      wallpaperRotationEnabled.value = true;
    }
    // 设置轮播画册
    await invoke("set_wallpaper_rotation_album_id", { albumId: albumId.value });
    currentRotationAlbumId.value = albumId.value;
    ElMessage.success(`已将画册"${albumName.value}"设为桌面轮播`);
  } catch (error) {
    console.error("设置轮播画册失败:", error);
    ElMessage.error("设置失败");
  }
};

// 删除画册
const handleDeleteAlbum = async () => {
  if (!albumId.value) return;

  // 检查是否为"收藏"画册
  if (albumId.value === FAVORITE_ALBUM_ID) {
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
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();

  // 移除收藏状态变化监听
  const handler = (window as any).__albumDetailFavoriteHandler;
  if (handler) {
    window.removeEventListener("favorite-status-changed", handler);
    delete (window as any).__albumDetailFavoriteHandler;
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

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
    height: 100%;

    .empty-image {
      width: 200px;
      max-width: 60%;
      height: auto;
      opacity: 0.85;
      margin-bottom: 24px;
      user-select: none;
      pointer-events: none;
    }

    .empty-tip {
      color: var(--anime-text-muted);
      font-size: 14px;
      text-align: center;
      line-height: 1.6;
    }
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
