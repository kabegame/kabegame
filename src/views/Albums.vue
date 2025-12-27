<template>
  <div class="albums-page">
    <PageHeader title="画册">
      <el-button type="primary" size="small" @click="showCreateDialog = true">新建画册</el-button>
    </PageHeader>

    <div class="albums-grid">
      <AlbumCard v-for="album in albums" :key="album.id" :album="album" :count="albumCounts[album.id] || 0"
        :preview-urls="albumPreviewUrls[album.id] || []" 
        :loading-states="albumLoadingStates[album.id] || []"
        :is-loading="albumIsLoading[album.id] || false"
        @click="openAlbum(album)" @mouseenter="prefetchPreview(album)"
        @contextmenu.prevent="openAlbumContextMenu($event, album)" />
    </div>

    <div v-if="albums.length === 0" class="empty-tip">暂无画册，点击右上角创建</div>

    <AlbumContextMenu
      :visible="albumMenuVisible"
      :position="albumMenuPosition"
      :album-id="menuAlbum?.id"
      :current-rotation-album-id="currentRotationAlbumId"
      @close="closeAlbumContextMenu"
      @command="handleAlbumMenuCommand"
    />

    <el-drawer v-model="drawerVisible" :title="currentAlbum?.name || '画册'" size="70%" append-to-body>
      <template #header>
        <div class="drawer-header">
          <div class="drawer-title">{{ currentAlbum?.name || '画册' }}</div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <el-button v-if="currentAlbum" size="small" class="drawer-browse-btn" @click="openAlbumFullPage">
              浏览
            </el-button>
            <el-button v-if="currentAlbum" size="small" type="danger" plain @click="handleDeleteCurrentAlbum">
              删除
            </el-button>
          </div>
        </div>
      </template>
      <div class="drawer-body" :style="drawerBgStyle" v-loading="loadingImages">
        <div v-if="!currentAlbum" class="empty-tip">未选择画册</div>
        <div v-else-if="currentImages.length === 0" class="empty-tip">该画册暂无图片</div>
        <template v-else>
          <div class="album-grid">
            <ImageGrid :images="currentImages" :image-url-map="imageSrcMap" image-click-action="preview" :columns="0"
              :aspect-ratio-match-window="false" :window-aspect-ratio="16 / 9" :selected-images="selectedImages"
              @image-click="handleImageClick" @image-dbl-click="handleImageDblClick" @contextmenu="handleImageContextMenu" />
          </div>
        </template>
      </div>
    </el-drawer>

    <ImageContextMenu :visible="imageMenuVisible" :position="imageMenuPosition" :image="imageMenuImage"
      :selected-count="selectedImages.size || 1" @close="imageMenuVisible = false" @command="handleImageMenuCommand" />

    <ImagePreviewDialog v-model="showPreview" v-model:image-url="previewUrl" :image-path="previewPath"
      :image="previewImage" />

    <ImageDetailDialog v-model="showImageDetail" :image="selectedDetailImage" />

    <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="pendingAddToAlbumImageIds"
      @added="handleAddedToAlbum" />

    <el-dialog v-model="showCreateDialog" title="新建画册" width="360px">
      <el-input v-model="newAlbumName" placeholder="输入画册名称" />
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!newAlbumName.trim()" @click="handleCreateAlbum">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ImageGrid from "@/components/ImageGrid.vue";
import ImagePreviewDialog from "@/components/ImagePreviewDialog.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import ImageContextMenu from "@/components/ImageContextMenu.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import AlbumContextMenu from "@/components/AlbumContextMenu.vue";
import { useAlbumStore } from "@/stores/albums";
import { useCrawlerStore, type ImageInfo as CrawlerImageInfo } from "@/stores/crawler";
import type { ImageInfo } from "@/stores/crawler";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import { onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";

const albumStore = useAlbumStore();
const crawlerStore = useCrawlerStore();
const { albums, albumCounts } = storeToRefs(albumStore);
const router = useRouter();

// 当前轮播画册ID
const currentRotationAlbumId = ref<string | null>(null);

const currentImages = ref<ImageInfo[]>([]);
const imageSrcMap = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const blobUrls = new Set<string>();
const loadingImages = ref(false);

const selectedImages = ref<Set<string>>(new Set());
const showPreview = ref(false);
const previewUrl = ref("");
const previewPath = ref("");
const previewImage = ref<ImageInfo | null>(null);
const showImageDetail = ref(false);
const selectedDetailImage = ref<ImageInfo | null>(null);

const showCreateDialog = ref(false);
const newAlbumName = ref("");

const loadRotationSettings = async () => {
  try {
    const settings = await invoke<{
      wallpaperRotationEnabled?: boolean;
      wallpaperRotationAlbumId?: string | null;
    }>("get_settings");
    currentRotationAlbumId.value = settings.wallpaperRotationAlbumId || null;
  } catch (error) {
    console.error("加载轮播设置失败:", error);
  }
};

onMounted(async () => {
  await albumStore.loadAlbums();
  await loadRotationSettings();
  
  // 初始化时加载前几个画册的预览图（前3张优先）
  const albumsToPreload = albums.value.slice(0, 3);
  for (const album of albumsToPreload) {
    prefetchPreview(album);
  }
});

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

const loadAlbumImages = async (albumId: string) => {
  loadingImages.value = true;
  try {
    const images = await albumStore.loadAlbumImages(albumId);
    currentImages.value = images;
    // 清空旧 URL
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.clear();
    imageSrcMap.value = {};

    // 顺序加载缩略图
    for (const img of images) {
      const thumbnailUrl = img.thumbnailPath ? await getImageUrl(img.thumbnailPath) : "";
      const originalUrl = await getImageUrl(img.localPath);
      imageSrcMap.value[img.id] = { thumbnail: thumbnailUrl, original: originalUrl };
    }
  } finally {
    loadingImages.value = false;
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

// 画册内图片右键菜单
const imageMenuVisible = ref(false);
const imageMenuPosition = ref({ x: 0, y: 0 });
const imageMenuImage = ref<ImageInfo | null>(null);
const showAddToAlbumDialog = ref(false);
const pendingAddToAlbumImageIds = ref<string[]>([]);

const handleImageContextMenu = (event: MouseEvent, image: ImageInfo) => {
  event.preventDefault();
  // 右键时确保当前图片处于选中集合中（便于 selectedCount 显示）
  if (!selectedImages.value.has(image.id)) {
    selectedImages.value.clear();
    selectedImages.value.add(image.id);
  }
  imageMenuImage.value = image;
  imageMenuPosition.value = { x: event.clientX, y: event.clientY };
  imageMenuVisible.value = true;
};

const handleAddedToAlbum = async () => {
  // 加入画册后，刷新计数（兜底）
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

  // 从当前画册视图移除
  const ids = new Set(imagesToDelete.map((i) => i.id));
  currentImages.value = currentImages.value.filter((img) => !ids.has(img.id));
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

  // 右键菜单支持单选/多选：若已选中多张，按 selectedImages 执行批量
  const imagesToProcess =
    selectedImages.value.size > 1
      ? currentImages.value.filter((img) => selectedImages.value.has(img.id))
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
        // 同步到列表
        currentImages.value = currentImages.value.map((img) =>
          img.id === image.id ? ({ ...img, favorite: newFavorite } as CrawlerImageInfo) : img
        );
      } catch (e) {
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

        const title =
          imagesToProcess.length > 1
            ? `Kabegami_AlbumSelection_${imagesToProcess.length}_Images`
            : `Kabegami_${image.id}`;

        const res = await invoke<{ projectDir: string; imageCount: number }>(
          "export_images_to_we_project",
          {
            imagePaths: imagesToProcess.map((img) => img.localPath),
            title,
            outputParentDir,
            options: null,
          }
        );
        ElMessage.success(`已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`);
        await invoke("open_file_path", { filePath: res.projectDir });
      } catch (e) {
        console.error("导出 Wallpaper Engine 工程失败:", e);
        ElMessage.error("导出失败");
      }
      break;
    case "delete":
      await handleBatchDeleteImages(imagesToProcess);
      break;
  }
};

const handleCreateAlbum = async () => {
  if (!newAlbumName.value.trim()) return;
  const created = await albumStore.createAlbum(newAlbumName.value.trim());
  await albumStore.loadAlbumPreview(created.id, 6);
  await prefetchPreview(created);
  newAlbumName.value = "";
  showCreateDialog.value = false;
  ElMessage.success("画册已创建");
};

// 卡牌交互
const currentAlbum = ref<{ id: string; name: string } | null>(null);
const drawerVisible = ref(false);
const albumPreviewUrls = ref<Record<string, string[]>>({});
const albumLoadingStates = ref<Record<string, boolean[]>>({});
const albumIsLoading = ref<Record<string, boolean>>({});
const heroIndex = ref(0);
const drawerBg = ref<string>("");

// 画册右键菜单状态
const albumMenuVisible = ref(false);
const albumMenuPosition = ref({ x: 0, y: 0 });
const menuAlbum = ref<{ id: string; name: string } | null>(null);

const prefetchPreview = async (album: { id: string }) => {
  // 如果已经加载完成，直接返回
  const existingUrls = albumPreviewUrls.value[album.id];
  if (existingUrls && existingUrls.length > 0 && existingUrls.some(url => url)) {
    return;
  }

  // 如果正在加载，也返回
  if (albumIsLoading.value[album.id]) {
    return;
  }

  albumIsLoading.value[album.id] = true;
  // 初始化加载状态：前3张标记为加载中
  albumLoadingStates.value[album.id] = [true, true, true, false, false, false];
  albumPreviewUrls.value[album.id] = ["", "", "", "", "", ""]; // 先占位

  try {
    const images = await albumStore.loadAlbumPreview(album.id, 6);
    const urls: string[] = [];
    const loadingStates: boolean[] = [];

    // 优先同步加载前3张
    for (let i = 0; i < Math.min(3, images.length); i++) {
      const img = images[i];
      const path = img.thumbnailPath || img.localPath;
      if (path) {
        try {
          const url = await getImageUrl(path);
          urls.push(url);
          loadingStates.push(false); // 加载完成
        } catch (e) {
          console.error("加载预览图失败:", e);
          urls.push("");
          loadingStates.push(false);
        }
      } else {
        urls.push("");
        loadingStates.push(false);
      }
    }

    // 更新前3张的结果
    albumPreviewUrls.value[album.id] = [...urls, "", "", ""];
    albumLoadingStates.value[album.id] = [...loadingStates, false, false, false];

    // 然后异步加载剩余的3张
    for (let i = 3; i < images.length; i++) {
      const img = images[i];
      const path = img.thumbnailPath || img.localPath;
      if (path) {
        loadingStates.push(true); // 标记为加载中
        albumLoadingStates.value[album.id][i] = true;
        
        // 异步加载
        getImageUrl(path).then(url => {
          const currentUrls = albumPreviewUrls.value[album.id] || [];
          const currentStates = albumLoadingStates.value[album.id] || [];
          if (currentUrls[i] === "") {
            currentUrls[i] = url;
            currentStates[i] = false;
            // 触发响应式更新
            albumPreviewUrls.value[album.id] = [...currentUrls];
            albumLoadingStates.value[album.id] = [...currentStates];
          }
        }).catch(e => {
          console.error("加载预览图失败:", e);
          const currentStates = albumLoadingStates.value[album.id] || [];
          currentStates[i] = false;
          albumLoadingStates.value[album.id] = [...currentStates];
        });
      } else {
        loadingStates.push(false);
        const currentStates = albumLoadingStates.value[album.id] || [];
        currentStates[i] = false;
        albumLoadingStates.value[album.id] = [...currentStates];
      }
    }

    // 确保至少有6个位置
    while (urls.length < 6) {
      urls.push("");
      loadingStates.push(false);
    }
  } catch (error) {
    console.error("加载画册预览失败:", error);
    albumPreviewUrls.value[album.id] = [];
    albumLoadingStates.value[album.id] = [false, false, false, false, false, false];
  } finally {
    albumIsLoading.value[album.id] = false;
  }
};

const openAlbum = async (album: { id: string; name: string }) => {
  currentAlbum.value = album;
  drawerVisible.value = true;
  await loadAlbumImages(album.id);
  drawerBg.value = albumPreviewUrls.value[album.id]?.[0] || "";
  heroIndex.value = 0;
};

const openAlbumContextMenu = (event: MouseEvent, album: { id: string; name: string }) => {
  albumMenuVisible.value = true;
  menuAlbum.value = album;
  albumMenuPosition.value = { x: event.clientX, y: event.clientY };
};

const closeAlbumContextMenu = () => {
  albumMenuVisible.value = false;
  menuAlbum.value = null;
};

const handleAlbumMenuCommand = async (command: "browse" | "delete" | "setWallpaperRotation" | "exportToWE" | "exportToWEAuto") => {
  if (!menuAlbum.value) return;
  const { id, name } = menuAlbum.value;
  closeAlbumContextMenu();

  if (command === "browse") {
    router.push(`/albums/${id}`);
    return;
  }

  if (command === "exportToWE" || command === "exportToWEAuto") {
    try {
      // 让用户输入工程名称
      const { value: projectName } = await ElMessageBox.prompt(
        `请输入 WE 工程名称（留空使用画册名称"${name}"）`,
        "导出到 Wallpaper Engine",
        {
          confirmButtonText: "导出",
          cancelButtonText: "取消",
          inputPlaceholder: name,
          inputValidator: (value) => {
            if (value && value.trim().length > 64) {
              return "名称不能超过 64 个字符";
            }
            return true;
          },
        }
      ).catch(() => ({ value: null })); // 用户取消时返回 null

      if (projectName === null) return; // 用户取消

      let outputParentDir = "";
      if (command === "exportToWEAuto") {
        const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
        if (!mp) {
          ElMessage.warning("未配置 Wallpaper Engine 目录：请到 设置 -> 壁纸轮播 -> Wallpaper Engine 目录 先选择");
          return;
        }
        outputParentDir = mp;
      } else {
        const selected = await open({
          directory: true,
          multiple: false,
          title: "选择导出目录（将自动创建 Wallpaper Engine 工程文件夹）",
        });
        if (!selected || Array.isArray(selected)) return;
        outputParentDir = selected;
      }

      // 使用用户输入的名称，如果为空则使用画册名称
      const finalName = projectName?.trim() || name;

      const res = await invoke<{ projectDir: string; imageCount: number }>(
        "export_album_to_we_project",
        {
          albumId: id,
          albumName: finalName,
          outputParentDir,
          options: null,
        }
      );
      ElMessage.success(`已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`);
      // 顺手打开导出目录（方便直接在 WE 里选择“打开项目”）
      await invoke("open_file_path", { filePath: res.projectDir });
    } catch (error) {
      if (error !== "cancel") {
        console.error("导出 Wallpaper Engine 工程失败:", error);
        ElMessage.error("导出失败");
      }
    }
    return;
  }

  if (command === "setWallpaperRotation") {
    try {
      await invoke("set_wallpaper_rotation_album_id", { albumId: id });
      currentRotationAlbumId.value = id;
      ElMessage.success(`已将画册"${name}"设为桌面轮播`);
    } catch (error) {
      console.error("设置轮播画册失败:", error);
      ElMessage.error("设置失败");
    }
    return;
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除画册"${name}"吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );
    await albumStore.deleteAlbum(id);
    // 如果正在预览同一个画册，顺便关闭抽屉并清理
    if (currentAlbum.value?.id === id) {
      drawerVisible.value = false;
      currentAlbum.value = null;
      currentImages.value = [];
      imageSrcMap.value = {};
      selectedImages.value.clear();
    }
    // 如果删除的是当前轮播画册，清除轮播设置
    if (currentRotationAlbumId.value === id) {
      await invoke("set_wallpaper_rotation_album_id", { albumId: null });
      currentRotationAlbumId.value = null;
    }
    delete albumPreviewUrls.value[id];
    await albumStore.loadAlbums();
    ElMessage.success("画册已删除");
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      ElMessage.error("删除失败");
    }
  }
};

const openAlbumFullPage = () => {
  if (!currentAlbum.value) return;
  router.push(`/albums/${currentAlbum.value.id}`);
};

const handleDeleteCurrentAlbum = async () => {
  if (!currentAlbum.value) return;
  const albumId = currentAlbum.value.id;
  const name = currentAlbum.value.name;
  try {
    await ElMessageBox.confirm(
      `确定要删除画册“${name}”吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );
    await albumStore.deleteAlbum(albumId);
    // 清理当前抽屉状态
    drawerVisible.value = false;
    currentAlbum.value = null;
    currentImages.value = [];
    imageSrcMap.value = {};
    selectedImages.value.clear();
    // 清理预览缓存背景
    delete albumPreviewUrls.value[albumId];
    // 重新拉取计数/列表（兜底）
    await albumStore.loadAlbums();
    ElMessage.success("画册已删除");
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      ElMessage.error("删除失败");
    }
  }
};

onBeforeUnmount(() => {
  Object.values(albumPreviewUrls.value).forEach((urls) => {
    urls.forEach((u) => URL.revokeObjectURL(u));
  });
  albumPreviewUrls.value = {};
});

const drawerBgStyle = computed(() => {
  if (!drawerBg.value) return {};
  return {
    backgroundImage: `linear-gradient(rgba(255,255,255,0.85), rgba(255,255,255,0.95)), url(${drawerBg.value})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backdropFilter: "blur(12px)",
  };
});
</script>

<style scoped lang="scss">
.albums-page {
  padding: 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}



.albums-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}

.empty-tip {
  padding: 32px;
  color: var(--anime-text-muted);
}

.album-grid {
  width: 100%;
}

.drawer-body {
  padding: 0 8px;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

.drawer-title {
  font-weight: 700;
  font-size: 18px;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.drawer-browse-btn {
  background: var(--anime-primary);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 8px;
  box-shadow: 0 6px 14px rgba(255, 107, 157, 0.22);

  &:hover {
    opacity: 0.92;
  }
}

.hero-banner {
  position: relative;
  height: 240px;
  margin: 12px 0 20px 0;
  overflow: hidden;

  &:hover {
    .hero-btn {
      opacity: 1;
    }
  }

  .hero-track {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .hero-item {
    position: absolute;
    top: 10%;
    width: 60%;
    height: 80%;
    left: 20%;
    border-radius: 16px;
    background-size: cover;
    background-position: center;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
    transition: transform 0.35s ease, opacity 0.35s ease, box-shadow 0.35s ease, z-index 0.35s ease;
    opacity: 0;
    z-index: 1;

    &.is-center {
      transform: translateX(0) scale(1);
      opacity: 1;
      z-index: 3;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.28);
    }

    &.is-left {
      transform: translateX(-40%) scale(0.88);
      opacity: 0.85;
      z-index: 2;
    }

    &.is-right {
      transform: translateX(40%) scale(0.88);
      opacity: 0.85;
      z-index: 2;
    }

    &.is-hidden {
      opacity: 0;
      transform: translateX(0) scale(0.8);
      z-index: 1;
    }
  }

  .hero-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    cursor: pointer;
    transition: background 0.2s ease, opacity 0.2s ease;
    opacity: 0;

    &.left {
      left: 8px;
    }

    &.right {
      right: 8px;
    }

    &:hover {
      background: rgba(0, 0, 0, 0.28);
    }
  }
}
</style>
