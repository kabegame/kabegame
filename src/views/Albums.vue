<template>
  <div class="albums-page">
    <PageHeader title="画册">
      <el-button @click="handleRefresh" :loading="isRefreshing">
        <el-icon>
          <Refresh />
        </el-icon>
        刷新
      </el-button>
      <el-button type="primary" @click="showCreateDialog = true">新建画册</el-button>
    </PageHeader>

    <transition-group :key="albumsListKey" name="fade-in-list" tag="div" class="albums-grid">
      <AlbumCard v-for="album in albums" :key="album.id" :ref="(el) => albumCardRefs[album.id] = el" :album="album"
        :count="albumCounts[album.id] || 0" :preview-urls="albumPreviewUrls[album.id] || []"
        :loading-states="albumLoadingStates[album.id] || []" :is-loading="albumIsLoading[album.id] || false"
        @click="openAlbum(album)" @mouseenter="prefetchPreview(album)"
        @contextmenu.prevent="openAlbumContextMenu($event, album)" />
    </transition-group>

    <div v-if="albums.length === 0" class="empty-tip">暂无画册，点击右上角创建</div>

    <AlbumContextMenu :visible="albumMenuVisible" :position="albumMenuPosition" :album-id="menuAlbum?.id"
      :album-name="menuAlbum?.name" :current-rotation-album-id="currentRotationAlbumId"
      :wallpaper-rotation-enabled="wallpaperRotationEnabled" :album-image-count="menuAlbum ? (albumCounts[menuAlbum.id] || 0) : 0"
      @close="closeAlbumContextMenu" @command="handleAlbumMenuCommand" />


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
import { ref, onMounted, onActivated, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import AlbumContextMenu from "@/components/AlbumContextMenu.vue";
import { useAlbumStore } from "@/stores/albums";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";

const albumStore = useAlbumStore();
const { albums, albumCounts } = storeToRefs(albumStore);
const router = useRouter();

// 收藏画册的固定ID（与后端保持一致）
const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";

// 当前轮播画册ID
const currentRotationAlbumId = ref<string | null>(null);
// 轮播是否开启
const wallpaperRotationEnabled = ref<boolean>(false);

const showCreateDialog = ref(false);
const newAlbumName = ref("");
const isRefreshing = ref(false);
const albumCardRefs = ref<Record<string, any>>({});
// 用于强制重新挂载列表（让“刷新”能触发完整 enter 动画 + 重置卡片内部状态）
const albumsListKey = ref(0);

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

// 如果删除的画册正在被“壁纸轮播”引用：自动关闭轮播，切回单张壁纸，并尽量保持当前壁纸不变
const handleDeletedRotationAlbum = async (deletedAlbumId: string) => {
  if (currentRotationAlbumId.value !== deletedAlbumId) return;

  const wasEnabled = wallpaperRotationEnabled.value;

  // 先读一下当前壁纸（用于切回单张壁纸时保持不变）
  let currentWallpaperPath: string | null = null;
  if (wasEnabled) {
    try {
      currentWallpaperPath = await invoke<string | null>("get_current_wallpaper_path");
    } catch {
      currentWallpaperPath = null;
    }
  }

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

    // 切回单张壁纸：用当前壁纸路径再 set 一次，确保“单张模式”一致且设置页能显示
    if (currentWallpaperPath) {
      try {
        await invoke("set_wallpaper", { filePath: currentWallpaperPath });
      } catch (e) {
        console.warn("切回单张壁纸失败:", e);
      }
    }

    ElMessage.info("删除的画册正在用于轮播：已自动关闭轮播并切换为单张壁纸");
  }
};

// 刷新收藏画册的预览（用于收藏状态变化时）
const refreshFavoriteAlbumPreview = async () => {
  const favoriteAlbum = albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (!favoriteAlbum) return;

  // 清除收藏画册的本地预览缓存
  const oldUrls = albumPreviewUrls.value[FAVORITE_ALBUM_ID];
  if (oldUrls) {
    oldUrls.forEach((u) => URL.revokeObjectURL(u));
  }
  delete albumPreviewUrls.value[FAVORITE_ALBUM_ID];
  delete albumLoadingStates.value[FAVORITE_ALBUM_ID];
  delete albumIsLoading.value[FAVORITE_ALBUM_ID];
  // 清除store中的预览缓存
  delete albumStore.albumPreviews[FAVORITE_ALBUM_ID];
  // 重新加载预览
  await prefetchPreview(favoriteAlbum);
};

// 收藏状态变化事件处理器
const handleFavoriteStatusChanged = () => {
  refreshFavoriteAlbumPreview();
};

onMounted(async () => {
  await albumStore.loadAlbums();
  await loadRotationSettings();

  // 初始化时加载前几个画册的预览图（前3张优先）
  const albumsToPreload = albums.value.slice(0, 3);
  for (const album of albumsToPreload) {
    prefetchPreview(album);
  }

  // 监听收藏状态变化事件
  window.addEventListener("favorite-status-changed", handleFavoriteStatusChanged);
});

// 组件激活时（keep-alive 缓存后重新显示）重新加载画册列表和轮播设置
onActivated(async () => {
  await albumStore.loadAlbums();
  await loadRotationSettings();
  
  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  const favoriteAlbum = albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (favoriteAlbum) {
    const favoriteCount = albumCounts.value[FAVORITE_ALBUM_ID] || 0;
    const existingUrls = albumPreviewUrls.value[FAVORITE_ALBUM_ID];
    const hasValidPreview = existingUrls && existingUrls.length > 0 && existingUrls.some(url => url);
    
    // 如果画册有内容但预览为空，清除缓存并重新加载
    if (favoriteCount > 0 && !hasValidPreview) {
      // 清除本地预览URL缓存
      delete albumPreviewUrls.value[FAVORITE_ALBUM_ID];
      delete albumLoadingStates.value[FAVORITE_ALBUM_ID];
      delete albumIsLoading.value[FAVORITE_ALBUM_ID];
      // 清除store中的预览缓存
      delete albumStore.albumPreviews[FAVORITE_ALBUM_ID];
      // 重新加载预览
      await prefetchPreview(favoriteAlbum);
    }
  }
  
  // 检查是否有新画册需要加载预览（还没有预览数据的画册）
  for (const album of albums.value.slice(0, 6)) {
    // 跳过收藏画册，因为上面已经处理过了
    if (album.id === FAVORITE_ALBUM_ID) continue;
    
    const existingUrls = albumPreviewUrls.value[album.id];
    if (!existingUrls || existingUrls.length === 0 || !existingUrls.some(url => url)) {
      prefetchPreview(album);
    }
  }
});


const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await albumStore.loadAlbums();
    await loadRotationSettings();
    // 手动刷新：强制重载预览缓存（否则本地缓存会让 UI 看起来“没刷新”）
    const albumsToPreload = albums.value.slice(0, 6);
    for (const album of albumsToPreload) {
      clearAlbumPreviewCache(album.id);
    }
    // 收藏画册也强制重载一次（收藏状态变化会影响预览）
    clearAlbumPreviewCache(FAVORITE_ALBUM_ID);

    // 强制重新挂载列表，让每个卡片的 enter 动画和内部状态都重置
    albumsListKey.value++;

    // 重新加载预览图（前 6 张优先）
    for (const album of albumsToPreload) {
      prefetchPreview(album);
    }
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshing.value = false;
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
const albumPreviewUrls = ref<Record<string, string[]>>({});
const albumLoadingStates = ref<Record<string, boolean[]>>({});
const albumIsLoading = ref<Record<string, boolean>>({});

const clearAlbumPreviewCache = (albumId: string) => {
  const oldUrls = albumPreviewUrls.value[albumId];
  if (oldUrls) {
    oldUrls.forEach((u) => {
      if (u) URL.revokeObjectURL(u);
    });
  }
  delete albumPreviewUrls.value[albumId];
  delete albumLoadingStates.value[albumId];
  delete albumIsLoading.value[albumId];
  // 清除 store 中的预览缓存（强制下一次重新拉取预览图片列表）
  delete albumStore.albumPreviews[albumId];
};

// 画册右键菜单状态
const albumMenuVisible = ref(false);
const albumMenuPosition = ref({ x: 0, y: 0 });
const menuAlbum = ref<{ id: string; name: string } | null>(null);

const getImageUrl = async (localPath: string): Promise<string> => {
  if (!localPath) return "";
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
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
    return url;
  } catch (e) {
    console.error("加载图片失败", e);
    return "";
  }
};

const prefetchPreview = async (album: { id: string }) => {
  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  if (album.id === FAVORITE_ALBUM_ID) {
    const favoriteCount = albumCounts.value[FAVORITE_ALBUM_ID] || 0;
    const existingUrls = albumPreviewUrls.value[FAVORITE_ALBUM_ID];
    const hasValidPreview = existingUrls && existingUrls.length > 0 && existingUrls.some(url => url);
    
    // 如果画册有内容但预览为空，清除缓存
    if (favoriteCount > 0 && !hasValidPreview) {
      // 清除本地预览URL缓存
      delete albumPreviewUrls.value[FAVORITE_ALBUM_ID];
      delete albumLoadingStates.value[FAVORITE_ALBUM_ID];
      delete albumIsLoading.value[FAVORITE_ALBUM_ID];
      // 清除store中的预览缓存
      delete albumStore.albumPreviews[FAVORITE_ALBUM_ID];
    }
  }
  
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

const openAlbum = (album: { id: string; name: string }) => {
  // 空相册不能打开
  const count = albumCounts.value[album.id] || 0;
  if (count === 0) {
    return;
  }
  router.push(`/albums/${album.id}`);
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

const handleAlbumMenuCommand = async (command: "browse" | "delete" | "setWallpaperRotation" | "exportToWE" | "exportToWEAuto" | "rename") => {
  if (!menuAlbum.value) return;
  const { id, name } = menuAlbum.value;
  closeAlbumContextMenu();

  if (command === "browse") {
    // 空相册不能浏览
    const count = albumCounts.value[id] || 0;
    if (count === 0) {
      return;
    }
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
      // 如果轮播未开启，先开启轮播
      if (!wallpaperRotationEnabled.value) {
        await invoke("set_wallpaper_rotation_enabled", { enabled: true });
        wallpaperRotationEnabled.value = true;
      }
      // 设置轮播画册
      await invoke("set_wallpaper_rotation_album_id", { albumId: id });
      currentRotationAlbumId.value = id;
      ElMessage.success(`已将画册"${name}"设为桌面轮播`);
    } catch (error) {
      console.error("设置轮播画册失败:", error);
      ElMessage.error("设置失败");
    }
    return;
  }

  if (command === "rename") {
    // 通过 ref 触发重命名
    const cardRef = albumCardRefs.value[id];
    if (cardRef && cardRef.startRename) {
      cardRef.startRename();
    }
    return;
  }

  // 检查是否为"收藏"画册（使用固定ID）
  if (id === FAVORITE_ALBUM_ID) {
    ElMessage.warning("不能删除'收藏'画册");
    return;
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除画册"${name}"吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );
    await albumStore.deleteAlbum(id);
    // 如果删除的是当前轮播画册：自动关闭轮播并切回单张壁纸
    await handleDeletedRotationAlbum(id);
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


onBeforeUnmount(() => {
  // 移除收藏状态变化事件监听
  window.removeEventListener("favorite-status-changed", handleFavoriteStatusChanged);
  
  Object.values(albumPreviewUrls.value).forEach((urls) => {
    urls.forEach((u) => URL.revokeObjectURL(u));
  });
  albumPreviewUrls.value = {};
});

</script>

<style scoped lang="scss">
.albums-page {
  padding: 20px;
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

/* 列表淡入动画 */
.fade-in-list-enter-active {
  transition: transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.26s ease-out, filter 0.26s ease-out;
}

.fade-in-list-leave-active {
  transition: transform 0.22s ease-in, opacity 0.22s ease-in, filter 0.22s ease-in;
  pointer-events: none;
}

.fade-in-list-enter-from {
  opacity: 0;
  transform: translateY(14px) scale(0.96);
  filter: blur(2px);
}

.fade-in-list-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.92);
  filter: blur(2px);
}

.fade-in-list-move {
  transition: transform 0.4s ease;
}

.empty-tip {
  padding: 32px;
  color: var(--anime-text-muted);
}
</style>
