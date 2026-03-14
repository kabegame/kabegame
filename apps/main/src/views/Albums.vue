<template>
  <div class="albums-page" v-pull-to-refresh="pullToRefreshOpts">
    <div class="albums-scroll-container">
      <AlbumsPageHeader
        :album-drive-enabled="albumDriveEnabled"
        @view-vd="openVirtualDrive"
        @refresh="handleRefresh"
        @create-album="showCreateDialog = true"
        @help="openHelpDrawer"
        @quick-settings="openQuickSettings"
      />

      <div v-loading="showLoading" style="min-height: 200px;">
        <transition-group v-if="!loading" :key="albumsListKey" name="fade-in-list" tag="div"
          class="albums-grid" :class="{ 'albums-grid-android': IS_ANDROID }">
          <AlbumCard v-for="album in albums" :key="album.id" :ref="(el) => albumCardRefs[album.id] = el" :album="album"
            :count="albumCounts[album.id] || 0" :preview-urls="albumPreviewUrls[album.id] || []"
            :loading-states="albumLoadingStates[album.id] || []" :is-loading="albumIsLoadingMap[album.id] || false"
            @click="openAlbum(album)" @visible="prefetchPreview(album)"
            @contextmenu.prevent="openAlbumContextMenu($event, album)" />
        </transition-group>

        <div v-if="!loading && albums.length === 0" class="empty-tip">暂无画册，点击右上角创建</div>
      </div>
    </div>

    <ActionRenderer
      :visible="albumMenu.visible.value"
      :position="albumMenu.position.value"
      :actions="(albumActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="albumMenuContext"
      :z-index="3500"
      @close="albumMenu.hide"
      @command="(cmd) => handleAlbumMenuCommand(cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename')" />

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
import { ref, computed, onMounted, onActivated, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, Setting, QuestionFilled } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { useAlbumStore } from "@/stores/albums";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import type { Album } from "@/stores/albums";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import AlbumsPageHeader from "@/components/header/AlbumsPageHeader.vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_WINDOWS, IS_LIGHT_MODE, IS_ANDROID, CONTENT_URI_PROXY_PREFIX } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import type { ImageInfo } from "@kabegame/core/types/image";
import { fileToUrl, thumbnailToUrl } from "@kabegame/core/httpServer";

const albumStore = useAlbumStore();
const { albums, albumCounts, FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const router = useRouter();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albums");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albums");

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);


// 虚拟磁盘
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");
const albumDriveEnabled = computed(() => !IS_ANDROID && !IS_LIGHT_MODE && !!settingsStore.values.albumDriveEnabled);
const albumDriveMountPoint = computed(() => settingsStore.values.albumDriveMountPoint || "K:\\");

const openVirtualDrive = async () => {
  try {
    await invoke("open_explorer", { path: albumDriveMountPoint.value });
  } catch (e) {
    console.error("打开虚拟磁盘失败:", e);
    ElMessage.error(String(e));
  }
};

// 当前轮播画册ID
const currentRotationAlbumId = computed(() => {
  const raw = settingsStore.values.wallpaperRotationAlbumId as any as string | null | undefined;
  const id = (raw ?? "").trim();
  return id ? id : null;
});
// 轮播是否开启
const wallpaperRotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const showCreateDialog = ref(false);
useModalBack(showCreateDialog);
const newAlbumName = ref("");
const isRefreshing = ref(false);
const albumCardRefs = ref<Record<string, any>>({});
// 使用 300ms 防闪屏加载延迟
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay(300);
// 用于强制重新挂载列表（让“刷新”能触发完整 enter 动画 + 重置卡片内部状态）
const albumsListKey = ref(0);

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
    await setWallpaperRotationAlbumId(null);
  } catch {
    // 静默失败
  }
};

const toPreviewUrl = (img: ImageInfo): string => {
  const thumbPath = (img.thumbnailPath || img.localPath || "").trim();
  if (!thumbPath) return "";
  if (IS_ANDROID) {
    return thumbPath.startsWith("content://")
      ? thumbPath.replace("content://", CONTENT_URI_PROXY_PREFIX)
      : "";
  }
  return thumbnailToUrl(thumbPath);
};

const hasPreviewUrl = (img: ImageInfo) => !!toPreviewUrl(img);

// 画册预览图数量：桌面 3 张，安卓 1 张
const albumPreviewLimit = IS_ANDROID ? 1 : 3;

// 保存每个画册的预览 ImageInfo 列表
const albumPreviewImages = ref<Record<string, ImageInfo[]>>({});

// 正在加载预览的画册 ID 集合
const albumIsLoading = ref<Set<string>>(new Set());

// 刷新收藏画册的预览（用于收藏状态变化时）
const refreshFavoriteAlbumPreview = async () => {
  const favoriteAlbum = albums.value.find(a => a.id === FAVORITE_ALBUM_ID.value);
  if (!favoriteAlbum) return;

  // 清除收藏画册的预览缓存
  clearAlbumPreviewCache(FAVORITE_ALBUM_ID.value);
  // 重新加载预览
  await prefetchPreview(favoriteAlbum);
};

// 收藏状态以 store 为准：通过收藏画册计数变化触发预览刷新
const stopFavoriteCountWatch = ref<null | (() => void)>(null);

// 统一图片变更事件：收到 images-change 后，按 albumId 刷新对应画册预览（1000ms trailing 节流，不丢最后一次）
useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    // 只处理明确给出 albumId 的变更（例如：收藏/画册增删图片/爬虫写入时带 albumId）
    return !!p.albumId;
  },
  onRefresh: async (p) => {
    const targetAlbumId = p.albumId;
    if (!targetAlbumId) return;
    const targetAlbum = albums.value.find((a) => a.id === targetAlbumId);
    if (!targetAlbum) return;

    // 检查该画册的预览图列表是否已满
    const images = albumPreviewImages.value[targetAlbumId];
    if (images && images.length >= albumPreviewLimit) {
      const allLoaded = images.every((img) => hasPreviewUrl(img));
      if (allLoaded) return;
    }

    clearAlbumPreviewCache(targetAlbumId);
    delete albumStore.albumPreviews[targetAlbumId];
    await prefetchPreview(targetAlbum);
  },
});

onMounted(async () => {
  startLoading();
  try {
    await albumStore.loadAlbums();
  } finally {
    finishLoading();
  }
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）

  // 初始化时加载前几个画册的预览图（前3张优先）
  const albumsToPreload = albums.value.slice(0, 3);
  for (const album of albumsToPreload) {
    prefetchPreview(album);
  }

  // 监听收藏画册数量变化，刷新预览
  stopFavoriteCountWatch.value?.();
  stopFavoriteCountWatch.value = watch(
    () => albumCounts.value[FAVORITE_ALBUM_ID.value],
    () => {
      refreshFavoriteAlbumPreview();
    }
  );

  // 图片变更的预览刷新由 `images-change`（失效信号）驱动，统一节流处理。
});

// 组件激活时（keep-alive 缓存后重新显示）重新加载画册列表和轮播设置
onActivated(async () => {
  await albumStore.loadAlbums();
  // 重新加载虚拟磁盘设置（可能在设置页修改后返回）
  await settingsStore.loadMany([
    "albumDriveEnabled",
    "albumDriveMountPoint",
    "wallpaperRotationEnabled",
    "wallpaperRotationAlbumId",
  ]);

  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  const favoriteAlbum = albums.value.find(a => a.id === FAVORITE_ALBUM_ID.value);
  if (favoriteAlbum) {
    const favoriteCount = albumCounts.value[FAVORITE_ALBUM_ID.value] || 0;
    const images = albumPreviewImages.value[FAVORITE_ALBUM_ID.value];
    const hasValidPreview = images && images.length > 0 && images.some((img) => hasPreviewUrl(img));

    // 如果画册有内容但预览为空，清除缓存并重新加载
    if (favoriteCount > 0 && !hasValidPreview) {
      clearAlbumPreviewCache(FAVORITE_ALBUM_ID.value);
      // 重新加载预览
      await prefetchPreview(favoriteAlbum);
    }
  }

  // 检查是否有新画册需要加载预览（还没有预览数据的画册）
  for (const album of albums.value.slice(0, 6)) {
    // 跳过收藏画册，因为上面已经处理过了
    if (album.id === FAVORITE_ALBUM_ID.value) continue;

    const images = albumPreviewImages.value[album.id];
    if (!images || images.length === 0 || !images.some((img) => hasPreviewUrl(img))) {
      prefetchPreview(album);
    }
  }
});


const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await albumStore.loadAlbums();
    await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);
    // 手动刷新：强制重载预览缓存（否则本地缓存会让 UI 看起来"没刷新"）
    const albumsToPreload = albums.value.slice(0, 6);
    for (const album of albumsToPreload) {
      clearAlbumPreviewCache(album.id);
    }
    // 收藏画册也强制重载一次（收藏状态变化会影响预览）
    clearAlbumPreviewCache(FAVORITE_ALBUM_ID.value);

    // 清除所有画册的详情缓存，确保进入画册详情页时能获取最新内容
    for (const album of albums.value) {
      delete albumStore.albumImages[album.id];
    }
    // 也清除收藏画册的详情缓存
    delete albumStore.albumImages[FAVORITE_ALBUM_ID.value];

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
  try {
    const created = await albumStore.createAlbum(newAlbumName.value.trim());
    await albumStore.loadAlbumPreview(created.id, albumPreviewLimit);
    await prefetchPreview(created);
    newAlbumName.value = "";
    showCreateDialog.value = false;
    ElMessage.success("画册已创建");
  } catch (error: any) {
    console.error("创建画册失败:", error);
    // 提取友好的错误信息
    const errorMessage = typeof error === "string"
      ? error
      : error?.message || String(error) || "创建画册失败";
    ElMessage.error(errorMessage);
  }
};

// 从 ImageInfo 直接计算预览 URL 列表
const albumPreviewUrls = computed(() => {
  const result: Record<string, string[]> = {};
  for (const [albumId, images] of Object.entries(albumPreviewImages.value)) {
    result[albumId] = images.map((img) => toPreviewUrl(img));
  }
  return result;
});

// 简化后不追踪预览图加载态，统一由卡片级 loading 控制
const albumLoadingStates = computed(() => {
  const result: Record<string, boolean[]> = {};
  for (const [albumId, images] of Object.entries(albumPreviewImages.value)) {
    result[albumId] = images.map(() => false);
  }
  return result;
});

// 计算每个画册是否正在加载（用于响应式更新）
const albumIsLoadingMap = computed(() => {
  const result: Record<string, boolean> = {};
  for (const albumId of albumIsLoading.value) {
    result[albumId] = true;
  }
  return result;
});

const clearAlbumPreviewCache = (albumId: string) => {
  delete albumPreviewImages.value[albumId];
  albumIsLoading.value.delete(albumId);
  // 清除 store 中的预览缓存（强制下一次重新拉取预览图片列表）
  delete albumStore.albumPreviews[albumId];
};

// 画册右键菜单状态
// Album actions
const albumActions = computed(() => createAlbumActions());

// Find album by ID helper
const findAlbumById = (id: string): Album | null => {
  return albums.value.find((a) => a.id === id) ?? null;
};

// Album menu using useActionMenu (visible/position/context passed to ActionRenderer)
const albumMenu = useActionMenu<Album>();

// Album menu context with extended fields (must include ActionContext<Album> for ActionRenderer)
const albumMenuContext = computed<AlbumActionContext>(() => {
  const album = albumMenu.context.value.target;
  return {
    target: album,
    selectedIds: new Set<string>(),
    selectedCount: 0,
    currentRotationAlbumId: currentRotationAlbumId.value,
    wallpaperRotationEnabled: wallpaperRotationEnabled.value,
    albumImageCount: album ? (albumCounts.value[album.id] || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID.value,
  };
});

const prefetchPreview = async (album: { id: string }) => {
  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  if (album.id === FAVORITE_ALBUM_ID.value) {
    const favoriteCount = albumCounts.value[FAVORITE_ALBUM_ID.value] || 0;
    const images = albumPreviewImages.value[FAVORITE_ALBUM_ID.value];
    const hasValidPreview = images && images.length > 0 && images.some((img) => hasPreviewUrl(img));

    // 如果画册有内容但预览为空，清除缓存
    if (favoriteCount > 0 && !hasValidPreview) {
      clearAlbumPreviewCache(FAVORITE_ALBUM_ID.value);
    }
  }

  // 如果已经加载完成，直接返回
  const images = albumPreviewImages.value[album.id];
  if (images && images.length > 0) {
    const allLoaded = images.every((img) => hasPreviewUrl(img));
    if (allLoaded) return;
  }

  // 如果正在加载，也返回
  if (albumIsLoading.value.has(album.id)) {
    return;
  }

  albumIsLoading.value.add(album.id);

  try {
    // 加载预览图片列表（桌面 3 张，安卓 1 张）
    const previewImages = await albumStore.loadAlbumPreview(album.id, albumPreviewLimit);
    albumPreviewImages.value[album.id] = previewImages;
  } catch (error) {
    console.error("加载画册预览失败:", error);
    delete albumPreviewImages.value[album.id];
  } finally {
    albumIsLoading.value.delete(album.id);
  }
};

const openAlbum = (album: { id: string; name: string }) => {
  router.push(`/albums/${album.id}`);
};

const openAlbumContextMenu = (event: MouseEvent, album: { id: string; name: string }) => {
  const albumObj = findAlbumById(album.id);
  if (albumObj) {
    albumMenu.show(albumObj, event);
  }
};

const handleAlbumMenuCommand = async (
  command: "browse" | "delete" | "setWallpaperRotation" | "rename"
) => {
  const context = albumMenuContext.value;
  const album = context.target;
  if (!album) return;
  const { id, name } = album;
  albumMenu.hide();

  if (command === "browse") {
    router.push(`/albums/${id}`);
    return;
  }


  if (command === "setWallpaperRotation") {
    try {
      // 如果轮播未开启，先开启轮播
      if (!wallpaperRotationEnabled.value) await setWallpaperRotationEnabled(true);
      // 设置轮播画册
      await setWallpaperRotationAlbumId(id);
      ElMessage.success(`已开启轮播：画册「${name}」`);
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
  if (id === FAVORITE_ALBUM_ID.value) {
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
    clearAlbumPreviewCache(id);
    await albumStore.loadAlbums();
    ElMessage.success("画册已删除");
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      ElMessage.error("删除失败");
    }
  }
};

</script>

<style scoped lang="scss">
.albums-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.albums-scroll-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px;
}



.albums-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}

/* 安卓：2 列网格，卡片正方形 */
.albums-grid-android {
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;

  :deep(.album-card) {
    height: auto;
    aspect-ratio: 1;
  }
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
