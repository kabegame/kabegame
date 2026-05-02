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
          class="albums-grid" :class="{ 'albums-grid-compact': isCompact }">
          <AlbumCard v-for="album in displayedAlbumRoots" :key="album.id" :ref="(el) => albumCardRefs[album.id] = el" :album="album"
            :count="displayedAlbumCounts[album.id] || 0" :preview-images="albumPreviewImages[album.id] || []"
            :video-preview-remount-key="albumVideoPreviewRemountKey"
            :is-loading="albumIsLoadingMap[album.id] || false"
            @click="openAlbum(album)" @visible="prefetchPreview(album)"
            @contextmenu="openAlbumContextMenu($event, album)" />
        </transition-group>

        <div v-if="!loading && displayedAlbumRoots.length === 0" class="empty-tip">{{ $t('albums.emptyTip') }}</div>
      </div>
    </div>

    <ActionRenderer
      :visible="albumMenu.visible.value"
      :position="albumMenu.position.value"
      :actions="(albumActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="albumMenuContext"
      :z-index="3500"
      @close="albumMenu.hide"
      @command="(cmd) => handleAlbumMenuCommand(cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename' | 'moveTo')" />

    <el-dialog v-model="showCreateDialog" :title="$t('albums.newAlbum')" width="360px">
      <el-input v-model="newAlbumName" :placeholder="$t('albums.placeholderName')" />
      <template #footer>
        <el-button @click="showCreateDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :disabled="!newAlbumName.trim()" @click="handleCreateAlbum">{{ $t('albums.create') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showMoveAlbumDialog" :title="$t('albums.moveToTitle')" width="420px" @closed="onMoveAlbumDialogClosed">
      <div class="mb-3">
        <el-checkbox v-model="moveToRoot">{{ $t('albums.moveToRoot') }}</el-checkbox>
      </div>
      <AlbumPickerField
        v-show="!moveToRoot"
        v-model="moveTargetParentId"
        :album-tree="moveAlbumTree"
        :album-counts="displayedAlbumCountsForPicker"
        :clearable="false"
        :placeholder="$t('albums.selectTargetAlbum')"
      />
      <template #footer>
        <el-button @click="showMoveAlbumDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" @click="confirmMoveAlbum">{{ $t('common.ok') }}</el-button>
      </template>
    </el-dialog>

    <button
      class="hidden-album-fab"
      :title="t('albums.enterHidden')"
      :aria-label="t('albums.enterHidden')"
      @click="openHiddenAlbum"
      @contextmenu.prevent
    >
      <el-icon :size="20"><Delete /></el-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, Setting, QuestionFilled, Delete } from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import type { Album } from "@/stores/albums";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import AlbumsPageHeader from "@/components/header/AlbumsPageHeader.vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_WINDOWS, IS_LIGHT_MODE, IS_ANDROID, IS_WEB, CONTENT_URI_PROXY_PREFIX } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import type { ImageInfo } from "@kabegame/core/types/image";
import { thumbnailToUrl } from "@kabegame/core/httpServer";
import { useGlobalPathRoute } from "@/stores/pathRoute";

const { t } = useI18n();
const albumStore = useAlbumStore();
const { albums, albumCounts } = storeToRefs(albumStore);
const globalPathRoute = useGlobalPathRoute();
const { hide: globalHide } = storeToRefs(globalPathRoute);
const router = useRouter();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albums");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albums");
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);


// 虚拟磁盘
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");
const albumDriveEnabled = computed(() => !IS_ANDROID && !IS_WEB && !IS_LIGHT_MODE && !!settingsStore.values.albumDriveEnabled);
const albumDriveMountPoint = computed(() => settingsStore.values.albumDriveMountPoint || "K:\\");

const openVirtualDrive = async () => {
  try {
    await invoke("open_explorer", { path: albumDriveMountPoint.value });
  } catch (e) {
    console.error("打开虚拟磁盘失败:", e);
    ElMessage.error(`${String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
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

const moveDlgAlbum = ref<Album | null>(null);
const showMoveAlbumDialog = ref(false);
useModalBack(showMoveAlbumDialog);
const moveToRoot = ref(false);
const moveTargetParentId = ref<string | null>(null);

const moveAlbumTree = computed(() => {
  const a = moveDlgAlbum.value;
  if (!a) return [];
  const exclude = [a.id, ...albumStore.getDescendantIds(a.id), FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID];
  return albumStore.getAlbumTreeExcluding(exclude);
});

watch(showMoveAlbumDialog, (open) => {
  if (open) {
    moveToRoot.value = false;
    moveTargetParentId.value = null;
  }
});

const onMoveAlbumDialogClosed = () => {
  moveDlgAlbum.value = null;
};

const confirmMoveAlbum = async () => {
  const album = moveDlgAlbum.value;
  if (!album) return;
  const pid = moveToRoot.value ? null : (moveTargetParentId.value?.trim() || null);
  if (!moveToRoot.value && !pid) {
    ElMessage.warning(t("albums.selectTargetAlbum"));
    return;
  }
  try {
    await albumStore.moveAlbum(album.id, pid);
    showMoveAlbumDialog.value = false;
    moveDlgAlbum.value = null;
    ElMessage.success(t("albums.moveSuccess"));
  } catch (e: unknown) {
    const msg =
      typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
    ElMessage.error(msg || t("albums.moveFailed"));
  }
};
const newAlbumName = ref("");
const isRefreshing = ref(false);
const albumCardRefs = ref<Record<string, any>>({});
// 使用 300ms 防闪屏加载延迟
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay(300);
// 用于强制重新挂载列表（让“刷新”能触发完整 enter 动画 + 重置卡片内部状态）
const albumsListKey = ref(0);
const albumListPath = computed(() => (globalHide.value ? "hide/album/" : "album/"));
/** keep-alive 再次进入画册页时递增，作为视频预览 ImageItem 的 :key 后缀，强制重建以恢复桌面 <video> autoplay */
const albumVideoPreviewRemountKey = ref(0);
const albumsSkipFirstActivateForVideoRemount = ref(true);

interface ProviderChildDir {
  kind: "dir";
  name: string;
  meta?: {
    kind?: string;
    data?: Record<string, unknown>;
  } | null;
  total?: number | null;
}

interface GalleryBrowseResult {
  entries?: Array<{ kind: string; image?: ImageInfo }>;
}

const displayedAlbumRoots = ref<Album[]>([]);
const displayedAlbumCounts = ref<Record<string, number>>({});
const displayedAlbumCountsForPicker = computed(() => ({
  ...albumCounts.value,
  ...displayedAlbumCounts.value,
}));

function albumFromProviderChild(child: ProviderChildDir): Album | null {
  if (child.meta?.kind !== "album") return null;
  const data = child.meta.data ?? {};
  const id = String(data.id ?? child.name ?? "").trim();
  if (!id || id === HIDDEN_ALBUM_ID) return null;
  const createdAt = data.createdAt ?? data.created_at ?? 0;
  return {
    id,
    name: String(data.name ?? child.name ?? ""),
    parentId: data.parentId == null ? null : String(data.parentId),
    createdAt: typeof createdAt === "number" ? createdAt : Number(createdAt) || 0,
  };
}

async function loadProviderAlbumList() {
  const entries = await invoke<ProviderChildDir[]>("list_provider_children", {
    path: albumListPath.value,
  });
  const roots: Album[] = [];
  const counts: Record<string, number> = {};
  for (const child of Array.isArray(entries) ? entries : []) {
    if (!child || child.kind !== "dir") continue;
    const album = albumFromProviderChild(child);
    if (!album) continue;
    roots.push(album);
    counts[album.id] = typeof child.total === "number" ? child.total : 0;
  }
  displayedAlbumRoots.value = roots;
  displayedAlbumCounts.value = counts;
}

function albumBasePath(albumId: string): string {
  const base = albumListPath.value.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(albumId)}`;
}

function albumPreviewPath(albumId: string, limit = albumPreviewLimit): string {
  return `${albumBasePath(albumId)}/order/x${limit}x/1/`;
}

async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await invoke<ProviderChildDir[]>("list_provider_children", { path });
  return (Array.isArray(entries) ? entries : []).filter(
    (e): e is ProviderChildDir =>
      !!e && e.kind === "dir" && typeof e.name === "string" && !!e.name,
  );
}

async function fetchProviderImages(path: string): Promise<ImageInfo[]> {
  const res = await invoke<GalleryBrowseResult>("browse_gallery_provider", { path });
  return (res?.entries ?? [])
    .filter((e): e is { kind: string; image: ImageInfo } => e?.kind === "image" && !!e.image)
    .map((e) => e.image);
}

async function loadAlbumPreviewFromProvider(albumId: string, limit = albumPreviewLimit): Promise<ImageInfo[]> {
  const out = await fetchProviderImages(albumPreviewPath(albumId, limit));
  if (out.length >= limit) return out.slice(0, limit);

  const children = await listProviderDirs(`${albumBasePath(albumId)}/`);
  for (const child of children) {
    const childAlbum = albumFromProviderChild(child);
    if (!childAlbum) continue;
    const childImages = await fetchProviderImages(albumPreviewPath(childAlbum.id, 3));
    for (const image of childImages) {
      out.push(image);
      if (out.length >= limit) return out.slice(0, limit);
    }
  }
  return out;
}

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
  const favoriteAlbum =
    displayedAlbumRoots.value.find((a) => a.id === FAVORITE_ALBUM_ID) ??
    albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (!favoriteAlbum) return;

  // 清除收藏画册的预览缓存
  clearAlbumPreviewCache(FAVORITE_ALBUM_ID);
  // 重新加载预览
  await prefetchPreview(favoriteAlbum);
};

// 收藏状态以 store 为准：通过收藏画册计数变化触发预览刷新
const stopFavoriteCountWatch = ref<null | (() => void)>(null);

// album_images 表变更：按 albumIds 刷新对应画册预览（1000ms trailing 节流，不丢最后一次）
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    const ids = p.albumIds ?? [];
    return ids.includes(HIDDEN_ALBUM_ID) || ids.some((aid) => albums.value.some((a) => a.id === aid));
  },
  onRefresh: async (p) => {
    const affected = new Set(p.albumIds ?? []);
    const hiddenAffected = affected.has(HIDDEN_ALBUM_ID);
    await loadProviderAlbumList();
    for (const album of displayedAlbumRoots.value) {
      if (!affected.has(album.id) && !hiddenAffected) continue;

      const images = albumPreviewImages.value[album.id];
      if (!hiddenAffected && images && images.length >= albumPreviewLimit) {
        const allLoaded = images.every((img) => hasPreviewUrl(img));
        if (allLoaded) continue;
      }

      clearAlbumPreviewCache(album.id);
      delete albumStore.albumPreviews[album.id];
      await prefetchPreview(album);
    }
  },
});

onMounted(async () => {
  startLoading();
  try {
    await Promise.all([
      albumStore.loadAlbums(),
      loadProviderAlbumList(),
    ]);
  } finally {
    finishLoading();
  }
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）

  // 初始化时加载前几个画册的预览图（前3张优先）
  const albumsToPreload = displayedAlbumRoots.value.slice(0, 3);
  for (const album of albumsToPreload) {
    prefetchPreview(album);
  }

  // 监听收藏画册数量变化，刷新预览
  stopFavoriteCountWatch.value?.();
  stopFavoriteCountWatch.value = watch(
    () => displayedAlbumCounts.value[FAVORITE_ALBUM_ID],
    () => {
      refreshFavoriteAlbumPreview();
    }
  );

  // 画册成员变更的预览刷新由 `album-images-change` 驱动，统一节流处理。
});

// 组件激活时（keep-alive 缓存后重新显示）重新加载画册列表和轮播设置
onActivated(async () => {
  await Promise.all([
    albumStore.loadAlbums(),
    loadProviderAlbumList(),
  ]);
  // 重新加载虚拟磁盘设置（可能在设置页修改后返回）
  await settingsStore.loadMany([
    "albumDriveEnabled",
    "albumDriveMountPoint",
    "wallpaperRotationEnabled",
    "wallpaperRotationAlbumId",
  ]);

  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  const favoriteAlbum =
    displayedAlbumRoots.value.find((a) => a.id === FAVORITE_ALBUM_ID) ??
    albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (favoriteAlbum) {
    const favoriteCount = displayedAlbumCounts.value[FAVORITE_ALBUM_ID] || 0;
    const images = albumPreviewImages.value[FAVORITE_ALBUM_ID];
    const hasValidPreview = images && images.length > 0 && images.some((img) => hasPreviewUrl(img));

    // 如果画册有内容但预览为空，清除缓存并重新加载
    if (favoriteCount > 0 && !hasValidPreview) {
      clearAlbumPreviewCache(FAVORITE_ALBUM_ID);
      // 重新加载预览
      await prefetchPreview(favoriteAlbum);
    }
  }

  // 检查是否有新画册需要加载预览（还没有预览数据的画册）
  for (const album of displayedAlbumRoots.value.slice(0, 6)) {
    // 跳过收藏画册，因为上面已经处理过了
    if (album.id === FAVORITE_ALBUM_ID) continue;

    const images = albumPreviewImages.value[album.id];
    if (!images || images.length === 0 || !images.some((img) => hasPreviewUrl(img))) {
      prefetchPreview(album);
    }
  }

  // 首次 onActivated 不递增，避免刚进页就多挂一次视频；从其它页返回时再递增以重建 ImageItem
  if (albumsSkipFirstActivateForVideoRemount.value) {
    albumsSkipFirstActivateForVideoRemount.value = false;
  } else {
    albumVideoPreviewRemountKey.value++;
  }
});


const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await Promise.all([
      albumStore.loadAlbums(),
      loadProviderAlbumList(),
    ]);
    await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);
    // 手动刷新：强制重载预览缓存（否则本地缓存会让 UI 看起来"没刷新"）
    const albumsToPreload = displayedAlbumRoots.value.slice(0, 6);
    for (const album of albumsToPreload) {
      clearAlbumPreviewCache(album.id);
    }
    // 收藏画册也强制重载一次（收藏状态变化会影响预览）
    clearAlbumPreviewCache(FAVORITE_ALBUM_ID);

    // 清除所有画册的详情缓存，确保进入画册详情页时能获取最新内容
    for (const album of albums.value) {
      delete albumStore.albumImages[album.id];
    }
    // 也清除收藏画册的详情缓存
    delete albumStore.albumImages[FAVORITE_ALBUM_ID];

    // 强制重新挂载列表，让每个卡片的 enter 动画和内部状态都重置
    albumsListKey.value++;

    // 重新加载预览图（前 6 张优先）
    for (const album of albumsToPreload) {
      prefetchPreview(album);
    }
    ElMessage.success(t("albums.refreshSuccess"));
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("albums.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

watch(albumListPath, async () => {
  albumPreviewImages.value = {};
  albumIsLoading.value.clear();
  albumsListKey.value++;
  startLoading();
  try {
    await loadProviderAlbumList();
    for (const album of displayedAlbumRoots.value.slice(0, 6)) {
      prefetchPreview(album);
    }
  } finally {
    finishLoading();
  }
});


const handleCreateAlbum = async () => {
  if (!newAlbumName.value.trim()) return;
  try {
    const created = await albumStore.createAlbum(newAlbumName.value.trim());
    await loadProviderAlbumList();
    await prefetchPreview(created);
    newAlbumName.value = "";
    showCreateDialog.value = false;
    ElMessage.success("画册已创建");
  } catch (error: any) {
    console.error("创建画册失败:", error);
    // 提取友好的错误信息
    const errorMessage = typeof error === "string"
      ? error
      : error?.message || String(error) || t("albums.createAlbumFailed");
    ElMessage.error(errorMessage);
  }
};

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
    albumImageCount: album ? (displayedAlbumCounts.value[album.id] || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
  };
});

const prefetchPreview = async (album: { id: string }) => {
  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  if (album.id === FAVORITE_ALBUM_ID) {
    const favoriteCount = displayedAlbumCounts.value[FAVORITE_ALBUM_ID] || 0;
    const images = albumPreviewImages.value[FAVORITE_ALBUM_ID];
    const hasValidPreview = images && images.length > 0 && images.some((img) => hasPreviewUrl(img));

    // 如果画册有内容但预览为空，清除缓存
    if (favoriteCount > 0 && !hasValidPreview) {
      clearAlbumPreviewCache(FAVORITE_ALBUM_ID);
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
    const previewImages = await loadAlbumPreviewFromProvider(album.id, albumPreviewLimit);
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

const openHiddenAlbum = () => {
  router.push(`/albums/${HIDDEN_ALBUM_ID}`);
};

const openAlbumContextMenu = (event: MouseEvent, album: { id: string; name: string }) => {
  if (album.id === HIDDEN_ALBUM_ID) {
    event.preventDefault();
    return;
  }
  const albumObj = findAlbumById(album.id);
  if (albumObj) {
    albumMenu.show(albumObj, event);
  }
};

const handleAlbumMenuCommand = async (
  command: "browse" | "delete" | "setWallpaperRotation" | "rename" | "moveTo",
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
      ElMessage.success(t("albums.rotationStarted", { name }));
    } catch (error) {
      console.error("设置轮播画册失败:", error);
      ElMessage.error(t("albums.setFailed"));
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

  if (command === "moveTo") {
    moveDlgAlbum.value = album;
    showMoveAlbumDialog.value = true;
    return;
  }

  // 检查是否为"收藏"画册（使用固定ID）
  if (id === FAVORITE_ALBUM_ID) {
    ElMessage.warning(t("albums.cannotDeleteFavorite"));
    return;
  }

  try {
    await ElMessageBox.confirm(
      t("albums.deleteAlbumConfirm", { name }),
      t("albums.confirmDelete"),
      { type: "warning" }
    );
    await albumStore.deleteAlbum(id);
    // 如果删除的是当前轮播画册：自动关闭轮播并切回单张壁纸
    await handleDeletedRotationAlbum(id);
    clearAlbumPreviewCache(id);
    await albumStore.loadAlbums();
    await loadProviderAlbumList();
    ElMessage.success(t("albums.albumDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      ElMessage.error(t("albums.deleteFailed"));
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

/* 紧凑布局：2 列网格，卡片正方形 */
.albums-grid-compact {
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

.hidden-album-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--anime-surface, #fff);
  color: var(--anime-text-secondary, #666);
  border: 1px solid var(--anime-border, rgba(0, 0, 0, 0.08));
  box-shadow: var(--anime-shadow, 0 2px 10px rgba(0, 0, 0, 0.1));
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s ease, transform 0.15s ease;

  &:hover {
    opacity: 1;
    transform: translateY(-1px);
  }
}
</style>
