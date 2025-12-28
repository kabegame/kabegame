<template>
  <div class="album-detail">
    <PageHeader :title="albumName || '画册'" :subtitle="images.length ? `共 ${images.length} 张` : ''" show-back
      @back="goBack" />

    <div class="detail-body" v-loading="loading">
      <div v-if="!images.length" class="empty-tip">暂无图片</div>
      <div v-else class="album-grid">
        <ImageGrid :images="images" :image-url-map="imageSrcMap" image-click-action="preview" :columns="0"
          :aspect-ratio-match-window="false" :window-aspect-ratio="16 / 9" :selected-images="selectedImages"
          @image-click="handleImageClick" @image-dbl-click="handleImageDblClick" @contextmenu="handleImageContextMenu" />
      </div>
    </div>

    <ImageContextMenu :visible="imageMenuVisible" :position="imageMenuPosition" :image="imageMenuImage"
      :selected-count="selectedImages.size || 1" @close="imageMenuVisible = false" @command="handleImageMenuCommand" />

    <ImagePreviewDialog v-model="showPreview" v-model:image-url="previewUrl" :image-path="previewPath"
      :image="previewImage" />

    <ImageDetailDialog v-model="showImageDetail" :image="selectedDetailImage" />

    <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="pendingAddToAlbumImageIds"
      @added="handleAddedToAlbum" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage, ElMessageBox } from "element-plus";
import ImageGrid from "@/components/ImageGrid.vue";
import ImagePreviewDialog from "@/components/ImagePreviewDialog.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import ImageContextMenu from "@/components/ImageContextMenu.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useAlbumStore } from "@/stores/albums";
import { useCrawlerStore, type ImageInfo as CrawlerImageInfo } from "@/stores/crawler";
import type { ImageInfo } from "@/stores/crawler";
import PageHeader from "@/components/common/PageHeader.vue";

const route = useRoute();
const router = useRouter();
const albumStore = useAlbumStore();
const crawlerStore = useCrawlerStore();

const albumId = ref<string>("");
const albumName = ref<string>("");
const loading = ref(false);
const images = ref<ImageInfo[]>([]);
const imageSrcMap = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const blobUrls = new Set<string>();

const selectedImages = ref<Set<string>>(new Set());
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

const handleImageClick = (image: ImageInfo) => {
  selectedImages.value.clear();
  selectedImages.value.add(image.id);
};

const handleImageDblClick = (image: ImageInfo) => {
  previewImage.value = image;
  previewPath.value = image.localPath;
  previewUrl.value = imageSrcMap.value[image.id]?.original || "";
  showPreview.value = true;
};

const handleImageContextMenu = (event: MouseEvent, image: ImageInfo) => {
  event.preventDefault();
  if (!selectedImages.value.has(image.id)) {
    selectedImages.value.clear();
    selectedImages.value.add(image.id);
  }
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

const handleBatchRemoveImages = async (imagesToRemove: ImageInfo[]) => {
  if (imagesToRemove.length === 0) return;
  const count = imagesToRemove.length;
  await ElMessageBox.confirm(
    `移除后将删除缩略图和数据库记录，但保留原图文件。是否继续移除${count > 1 ? `这 ${count} 张图片` : "这张图片"}？`,
    "确认移除",
    { type: "warning" }
  );

  try {
    for (const img of imagesToRemove) {
      await crawlerStore.removeImage(img.id);
    }

    const ids = new Set(imagesToRemove.map((i) => i.id));
    images.value = images.value.filter((img) => !ids.has(img.id));
    for (const id of ids) {
      const data = imageSrcMap.value[id];
      if (data?.thumbnail) URL.revokeObjectURL(data.thumbnail);
      if (data?.original) URL.revokeObjectURL(data.original);
      const { [id]: _, ...rest } = imageSrcMap.value;
      imageSrcMap.value = rest;
    }
    selectedImages.value.clear();
    ElMessage.success(`${count > 1 ? `已移除 ${count} 张图片` : "已移除图片"}`);
  } catch (error) {
    console.error("移除图片失败:", error);
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
  selectedImages.value.clear();
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
      } catch {
        ElMessage.error("操作失败");
      }
      break;
    case "addToAlbum":
      pendingAddToAlbumImageIds.value = imagesToProcess.map((i) => i.id);
      showAddToAlbumDialog.value = true;
      break;
    case "copy":
      await handleCopyImage(image);
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
            ? `Kabegami_AlbumDetailSelection_${imagesToProcess.length}_Images`
            : `Kabegami_${image.id}`;
        
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
      await handleBatchRemoveImages(imagesToProcess);
      break;
    case "delete":
      await handleBatchDeleteImages(imagesToProcess);
      break;
  }
};

onMounted(async () => {
  albumId.value = route.params.id as string;
  await albumStore.loadAlbums();
  const found = albumStore.albums.find((a) => a.id === albumId.value);
  albumName.value = found?.name || "画册";
  await loadAlbum();
});

onBeforeUnmount(() => {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
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
  }

  .album-grid {
    width: 100%;
    height: 100%;
  }

  .empty-tip {
    padding: 32px;
    color: var(--anime-text-muted);
  }
}
</style>

