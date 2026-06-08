<template>
  <div class="albums-page" v-pull-to-refresh="pullToRefreshOpts">
    <div class="albums-scroll-container">
      <AlbumsPageHeader
        :album-drive-enabled="albumDriveEnabled"
        @view-vd="openVirtualDrive"
        @refresh="handleRefresh"
        @create-album="createDialog.open()"
        @help="openHelpDrawer"
        @quick-settings="openQuickSettings"
      />

      <div v-loading="showLoading" style="min-height: 200px;">
        <transition-group v-if="!loading" :key="albumsListKey" name="fade-in-list" tag="div"
          class="albums-grid" :class="{ 'albums-grid-compact': isCompact }">
          <AlbumCard v-for="album in displayedAlbumRoots" :key="album.id" :ref="(el) => albumCardRefs[album.id] = el" :album="album"
            :count="displayedAlbumStats[album.id]?.imageCount || 0"
            :sub-album-count="displayedAlbumStats[album.id]?.subAlbumCount || 0"
            :preview-images="albumPreviewImages[album.id] || []"
            :video-preview-remount-key="albumVideoPreviewRemountKey"
            :is-loading="albumIsLoadingMap[album.id] || false"
            @click="openAlbum(album)"
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
      :z-index="albumMenu.zIndex.value"
      @close="albumMenu.hide"
      @command="(cmd) => handleAlbumMenuCommand(cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename' | 'moveTo' | 'syncNow' | 'syncNowRecursiveExisting' | 'syncNowRecursiveFull' | 'openLocalFolder')" />

    <el-dialog
      :model-value="createDialog.isOpen.value"
      :z-index="createDialog.zIndex.value"
      :title="$t('albums.newAlbum')"
      width="420px"
      @update:model-value="createDialog.close"
      @closed="resetCreateAlbumDialog"
    >
      <el-form label-width="0" @submit.prevent>
        <el-input
          v-model="newAlbumName"
          :placeholder="$t('albums.placeholderName')"
          @keyup.enter="handleCreateAlbum"
        />

        <AlbumPickerField
          v-model="newAlbumParentId"
          class="mt-3"
          :album-tree="createAlbumParentTree"
          :album-counts="displayedAlbumCountsForPicker"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />

        <el-checkbox v-if="!IS_ANDROID" v-model="newAlbumIsLocalFolder" class="mt-3">
          {{ $t('albums.localFolder.create') }}
        </el-checkbox>

        <div v-if="newAlbumIsLocalFolder" class="mt-2 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <el-button size="small" @click="pickLocalFolder">
              {{ $t('albums.localFolder.choosePath') }}
            </el-button>
            <span class="local-folder-path" :title="newAlbumSyncFolder">
              {{ newAlbumSyncFolder || $t('albums.localFolder.noPathSelected') }}
            </span>
          </div>
          <p v-if="syncFolderDuplicate" class="local-folder-error">
            {{ $t('albums.localFolder.duplicatePathHint') }}
          </p>
          <el-checkbox v-model="newAlbumRecursive">
            {{ $t('albums.localFolder.recursive') }}
          </el-checkbox>
          <p class="local-folder-hint">
            {{ $t('albums.localFolder.recursiveHint') }}
          </p>
          <p v-if="newAlbumRecursive" class="local-folder-hint">
            {{ $t('albums.localFolder.recursiveLimits', { maxDepth: 16 }) }}
          </p>
          <p class="local-folder-hint">
            {{ $t('albums.localFolder.skipNotice') }}
          </p>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.close()">{{ $t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :disabled="!canSubmitCreateAlbum"
          :loading="creatingAlbum"
          @click="handleCreateAlbum"
        >
          {{ $t('albums.create') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="moveDialog.isOpen.value" :z-index="moveDialog.zIndex.value" :title="$t('albums.moveToTitle')" width="420px" @update:model-value="moveDialog.close" @closed="onMoveAlbumDialogClosed">
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
        <el-button @click="moveDialog.close()">{{ $t('common.cancel') }}</el-button>
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
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
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
import { trackEvent } from "@kabegame/core/track/umami";
import AlbumsPageHeader from "@/components/header/AlbumsPageHeader.vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_WINDOWS, IS_LIGHT_MODE, IS_ANDROID, IS_WEB, CONTENT_URI_PROXY_PREFIX } from "@kabegame/core/env";
import { useModal } from "@kabegame/core/composables/useModal";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import type { ImageInfo } from "@kabegame/core/types/image";
import { fileToUrl, thumbnailToUrl } from "@kabegame/core/httpServer";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { openFilePicker } from "@/api/dialog";
import {
  syncLocalFolderAlbum,
  syncLocalFolderAlbums,
  type BatchSyncItem,
  type FolderStatusState,
  type SyncReport,
} from "@/api/syncLocalFolder";
import {
  albumSubtreeContainsAny,
  buildAlbumMediaNodes,
  flattenAlbumMediaNodes,
  loadAlbumMediaPreview,
  type AlbumMediaNode,
} from "@/utils/albumMediaTree";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

const { t } = useI18n();
const albumStore = useAlbumStore();
const { albums, albumRoots } = storeToRefs(albumStore);
const globalPathRoute = useGlobalPathRoute();
const { hide: globalHide } = storeToRefs(globalPathRoute);
const router = useRouter();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albums");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albums");
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);

const syncStatusSuffix = (state: FolderStatusState) =>
  state.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

const reportBatchSyncResult = (results: BatchSyncItem[]) => {
  if (results.length === 0) return;

  const errors = results.filter((r) => r.err != null);
  const badStatus = results.filter(
    (r) => r.ok && r.ok.status && r.ok.status.state !== "ok",
  );
  const okResults = results.filter((r) => r.ok && (!r.ok.status || r.ok.status.state === "ok"));

  let added = 0;
  let deleted = 0;
  let reimported = 0;
  let skippedInFlight = 0;
  for (const r of okResults) {
    if (!r.ok) continue;
    added += r.ok.added;
    deleted += r.ok.deleted;
    reimported += r.ok.reimported;
    if (r.ok.skippedInFlight) skippedInFlight++;
  }

  if (errors.length > 0) {
    console.warn("[local_folder] sync errors", errors);
    ElMessage.error(
      t("albums.localFolder.refreshSyncFailedSome", {
        count: errors.length,
        firstError: errors[0]?.err ?? "",
      }),
    );
    return;
  }

  if (badStatus.length > 0) {
    console.warn("[local_folder] sync bad status", badStatus);
    ElMessage.warning(
      t("albums.localFolder.refreshSyncBadStatus", { count: badStatus.length }),
    );
    return;
  }

  const skippedText =
    skippedInFlight > 0
      ? t("albums.localFolder.refreshSyncSkippedSuffix", { skipped: skippedInFlight })
      : "";
  ElMessage.success(
    t("albums.localFolder.refreshSyncDone", {
      added,
      deleted,
      reimported,
      skippedText,
    }),
  );
};

const reportSingleSyncResult = (report: SyncReport) => {
  if (report.skippedInFlight) {
    ElMessage.info(t("albums.localFolder.syncInFlight"));
    return;
  }

  if (report.status && report.status.state !== "ok") {
    ElMessage.warning(
      t(`albums.localFolder.status${syncStatusSuffix(report.status.state)}`, {
        message: report.status.message ?? "",
      }),
    );
    return;
  }

  ElMessage.success(
    t("albums.localFolder.syncDone", {
      added: report.added,
      deleted: report.deleted,
      reimported: report.reimported,
    }),
  );
};

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function trackAlbumEnter(album: { id: string; name: string }, source: "card" | "context_menu" | "hidden_button") {
  if (!IS_WEB) return;
  trackEvent("album_enter", {
    albumId: album.id,
    albumName: album.name,
    isHidden: album.id === HIDDEN_ALBUM_ID,
    source,
    triggerPage: "albums",
    url: currentUrl(),
  });
}


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

const createDialog = useModal();

const moveDlgAlbum = ref<Album | null>(null);
const moveDialog = useModal();
const moveToRoot = ref(false);
const moveTargetParentId = ref<string | null>(null);

const moveAlbumTree = computed(() => {
  const a = moveDlgAlbum.value;
  if (!a) return [];
  const exclude = [a.id, ...albumStore.getDescendantIds(a.id), FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID];
  return albumStore.getAlbumTreeExcluding(exclude);
});

watch(moveDialog.isOpen, (open) => {
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
    moveDialog.close();
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
const newAlbumParentId = ref<string | null>(null);
const newAlbumIsLocalFolder = ref(false);
const newAlbumSyncFolder = ref("");
const newAlbumRecursive = ref(false);
const creatingAlbum = ref(false);
/** 规范化本地路径用于比较：去除尾部分隔符（根目录除外）。 */
const normalizeSyncPath = (p: string): string => {
  const trimmed = p.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/[/\\]+$/, "");
  return stripped || trimmed;
};
const existingSyncFolders = computed(() => {
  const set = new Set<string>();
  for (const a of albums.value) {
    if (a.type === "local_folder" && a.syncFolder) {
      set.add(normalizeSyncPath(a.syncFolder));
    }
  }
  return set;
});
/** 选中的同步目录已存在对应的本地文件夹画册：禁用创建并在弹窗提示。 */
const syncFolderDuplicate = computed(() => {
  if (!newAlbumIsLocalFolder.value || !newAlbumSyncFolder.value) return false;
  return existingSyncFolders.value.has(normalizeSyncPath(newAlbumSyncFolder.value));
});
const canSubmitCreateAlbum = computed(() => {
  if (!newAlbumName.value.trim()) return false;
  if (creatingAlbum.value) return false;
  if (newAlbumIsLocalFolder.value && !newAlbumSyncFolder.value) return false;
  if (syncFolderDuplicate.value) return false;
  return true;
});
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

const displayedAlbumRoots = computed(() => albumRoots.value);
const displayedAlbumNodes = computed(() =>
  buildAlbumMediaNodes(
    displayedAlbumRoots.value,
    albums.value,
    albumStore.getAlbumDirectCounts(globalHide.value),
    globalHide.value,
  ),
);
const displayedAlbumNodeById = computed(() => {
  const entries = displayedAlbumNodes.value
    .flatMap((node) => flattenAlbumMediaNodes(node))
    .map((node) => [node.album.id, node] as const);
  return Object.fromEntries(entries) as Record<string, AlbumMediaNode>;
});
const displayedAlbumStats = computed(() => albumStore.getAlbumStats(globalHide.value));
const displayedAlbumCountsForPicker = computed(() => ({
  ...albumStore.getAlbumCounts(globalHide.value),
}));
const createAlbumParentTree = computed(() =>
  albumStore.getAlbumTreeExcluding([FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID]),
);

function removeLocalAlbumMediaState(albumIds: Iterable<string>) {
  const ids = new Set(albumIds);
  for (const id of ids) {
    clearAlbumPreviewCache(id);
  }
}

async function loadAlbumPreviewFromProvider(album: { id: string }, limit = albumPreviewLimit): Promise<ImageInfo[]> {
  const node = displayedAlbumNodeById.value[album.id];
  if (!node) return [];
  return loadAlbumMediaPreview(node, limit);
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
  const thumbPath = (img.thumbnailPath || "").trim();
  const localPath = (img.localPath || "").trim();
  const path = thumbPath || localPath;
  if (!path) return "";
  if (IS_ANDROID) {
    return path.startsWith("content://")
      ? path.replace("content://", CONTENT_URI_PROXY_PREFIX)
      : "";
  }
  return thumbPath ? thumbnailToUrl(thumbPath) : fileToUrl(localPath);
};

const hasPreviewUrl = (img: ImageInfo) => !!toPreviewUrl(img);

// 画册预览图数量：桌面 3 张，安卓 1 张
const albumPreviewLimit = IS_ANDROID ? 1 : 3;

// 保存每个画册的预览 ImageInfo 列表
const albumPreviewImages = ref<Record<string, ImageInfo[]>>({});

// 正在加载预览的画册 ID 集合
const albumIsLoading = ref<Set<string>>(new Set());

// 刷新单个画册预览：直接拉取并覆写，不先清空（清空到空数组再回填才是闪屏根因）
const refreshAlbumPreview = async (album: { id: string }) => {
  if (albumIsLoading.value.has(album.id)) return;
  albumIsLoading.value.add(album.id);
  try {
    const next = await loadAlbumPreviewFromProvider(album, albumPreviewLimit);
    albumPreviewImages.value[album.id] = next;
  } catch (error) {
    console.error("刷新画册预览失败:", error);
  } finally {
    albumIsLoading.value.delete(album.id);
  }
};

// 刷新收藏画册的预览（用于收藏状态变化时）
const refreshFavoriteAlbumPreview = async () => {
  const favoriteAlbum =
    displayedAlbumRoots.value.find((a) => a.id === FAVORITE_ALBUM_ID) ??
    albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (!favoriteAlbum) return;
  await refreshAlbumPreview(favoriteAlbum);
};

// 收藏状态以 store 为准：通过收藏画册计数变化触发预览刷新
const stopFavoriteCountWatch = ref<null | (() => void)>(null);

// album_images 表变更：按 albumIds 刷新对应画册预览（1000ms trailing 节流，不丢最后一次）
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    const ids = p.albumIds ?? [];
    return ids.length === 0 || ids.includes(HIDDEN_ALBUM_ID) || ids.some((aid) => albums.value.some((a) => a.id === aid));
  },
  onRefresh: async (p) => {
    const affected = new Set(p.albumIds ?? []);
    const allAffected = affected.size === 0;
    const hiddenAffected = affected.has(HIDDEN_ALBUM_ID);

    for (const node of displayedAlbumNodes.value) {
      const album = node.album;
      const subtreeAffected = albumSubtreeContainsAny(node, affected);
      if (!allAffected && !subtreeAffected && !hiddenAffected) continue;

      await refreshAlbumPreview(album);
    }
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
  // 预览图加载由上方 watch(displayedAlbumRoots) 统一驱动，无需在此手动预载。

  // 监听收藏画册数量变化，刷新预览
  stopFavoriteCountWatch.value?.();
  stopFavoriteCountWatch.value = watch(
    () => displayedAlbumStats.value[FAVORITE_ALBUM_ID]?.imageCount,
    () => {
      refreshFavoriteAlbumPreview();
    }
  );

  // 画册成员变更的预览刷新由 `album-images-change` 驱动，统一节流处理。
});

// 组件激活时（keep-alive 缓存后重新显示）重新加载画册列表，并等待设置缓存就绪。
onActivated(async () => {
  await albumStore.loadAlbums();
  await settingsStore.ensureLoaded();

  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  const favoriteAlbum =
    displayedAlbumRoots.value.find((a) => a.id === FAVORITE_ALBUM_ID) ??
    albums.value.find(a => a.id === FAVORITE_ALBUM_ID);
  if (favoriteAlbum) {
    const favoriteCount = displayedAlbumStats.value[FAVORITE_ALBUM_ID]?.imageCount || 0;
    const images = albumPreviewImages.value[FAVORITE_ALBUM_ID];
    const hasValidPreview = images && images.length > 0 && images.some((img) => hasPreviewUrl(img));

    // 如果画册有内容但预览为空，清除缓存并重新加载
    if (favoriteCount > 0 && !hasValidPreview) {
      clearAlbumPreviewCache(FAVORITE_ALBUM_ID);
      // 重新加载预览
      await prefetchPreview(favoriteAlbum);
    }
  }

  // 为所有画册补齐预览（prefetchPreview 自带去重/已加载短路）
  ensureAllAlbumPreviews();

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
    await albumStore.loadAlbums();
    await settingsStore.ensureLoaded();
    // 手动刷新：强制重载预览缓存（否则本地缓存会让 UI 看起来"没刷新"）
    for (const album of displayedAlbumRoots.value) {
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

    // 重新加载所有画册预览
    ensureAllAlbumPreviews();

    const localFolderIdsOnPage = displayedAlbumRoots.value
      .filter((a) => a.type === "local_folder")
      .map((a) => a.id);

    if (IS_ANDROID || IS_WEB || localFolderIdsOnPage.length === 0) {
      ElMessage.success(t("albums.refreshSuccess"));
    } else {
      ElMessage.warning(t("albums.localFolder.refreshSyncProgressing"));
      const results = await syncLocalFolderAlbums(localFolderIdsOnPage);
      reportBatchSyncResult(results);
    }
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("albums.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

watch(globalHide, async () => {
  albumPreviewImages.value = {};
  albumIsLoading.value.clear();
  albumsListKey.value++;
  startLoading();
  try {
    ensureAllAlbumPreviews();
  } finally {
    finishLoading();
  }
});

const resetCreateAlbumDialog = () => {
  newAlbumName.value = "";
  newAlbumParentId.value = null;
  newAlbumIsLocalFolder.value = false;
  newAlbumSyncFolder.value = "";
  newAlbumRecursive.value = false;
  creatingAlbum.value = false;
};

const pickLocalFolder = async () => {
  try {
    const selected = await openFilePicker({ directory: true, multiple: false });
    const path = selected?.paths?.[0];
    if (path) {
      newAlbumSyncFolder.value = path;
    }
  } catch (error) {
    console.warn("pick local folder failed", error);
    ElMessage.error(t("albums.selectFolderFailed"));
  }
};

const handleCreateAlbum = async () => {
  if (!canSubmitCreateAlbum.value) return;
  // 本地文件夹同步仅桌面端支持：Web 端（无论是否管理员）选择本地文件夹后点击创建，引导前往桌面版。
  if (newAlbumIsLocalFolder.value && (await guardDesktopOnly("localFolderSync"))) {
    return;
  }
  creatingAlbum.value = true;
  try {
    const parentId = newAlbumParentId.value?.trim() || null;
    if (newAlbumIsLocalFolder.value) {
      await albumStore.createLocalFolderAlbum(
        {
          name: newAlbumName.value.trim(),
          parentId,
          syncFolder: newAlbumSyncFolder.value,
          recursive: newAlbumRecursive.value,
        },
        { reload: false },
      );
    } else {
      await albumStore.createAlbum(newAlbumName.value.trim(), { parentId, reload: false });
    }
    createDialog.close();
    ElMessage.success(t("albums.albumCreated"));
  } catch (error: any) {
    console.error("创建画册失败:", error);
    // 提取友好的错误信息
    const errorMessage = typeof error === "string"
      ? error
      : error?.message || String(error) || t("albums.createAlbumFailed");
    ElMessage.error(errorMessage);
  } finally {
    creatingAlbum.value = false;
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
    albumImageCount: album ? (displayedAlbumStats.value[album.id]?.imageCount || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
    isLocalFolder: album?.type === "local_folder",
  };
});

const prefetchPreview = async (album: { id: string }) => {
  // 对于收藏画册，如果数量大于0但预览为空，清除缓存并重新加载
  if (album.id === FAVORITE_ALBUM_ID) {
    const favoriteCount = displayedAlbumStats.value[FAVORITE_ALBUM_ID]?.imageCount || 0;
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
    const previewImages = await loadAlbumPreviewFromProvider(album, albumPreviewLimit);
    albumPreviewImages.value[album.id] = previewImages;
  } catch (error) {
    console.error("加载画册预览失败:", error);
    delete albumPreviewImages.value[album.id];
  } finally {
    albumIsLoading.value.delete(album.id);
  }
};

// 直接为所有展示中的画册加载预览（不再用视口懒加载，新增画册经下方 watch 自动补齐）
const ensureAllAlbumPreviews = () => {
  for (const album of displayedAlbumRoots.value) {
    prefetchPreview(album);
  }
};

watch(
  () => displayedAlbumRoots.value.map((a) => a.id).join("|"),
  () => ensureAllAlbumPreviews(),
  { immediate: true },
);

const openAlbum = (album: { id: string; name: string }) => {
  trackAlbumEnter(album, "card");
  router.push(`/albums/${album.id}`);
};

const openHiddenAlbum = () => {
  trackAlbumEnter({ id: HIDDEN_ALBUM_ID, name: t("albums.hiddenAlbumName") }, "hidden_button");
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
  command:
    | "browse"
    | "delete"
    | "setWallpaperRotation"
    | "rename"
    | "moveTo"
    | "syncNow"
    | "syncNowRecursiveExisting"
    | "syncNowRecursiveFull"
    | "openLocalFolder",
) => {
  const context = albumMenuContext.value;
  const album = context.target;
  if (!album) return;
  const { id, name } = album;
  albumMenu.hide();

  if (command === "browse") {
    trackAlbumEnter({ id, name }, "context_menu");
    router.push(`/albums/${id}`);
    return;
  }

  if (command === "openLocalFolder") {
    const folder = album.syncFolder?.trim();
    if (!folder) return;
    try {
      await invoke("open_explorer", { path: folder });
    } catch (e: any) {
      console.error("打开本地文件夹失败:", e);
      ElMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "syncNow") {
    try {
      const report = await syncLocalFolderAlbum(id);
      if (report) reportSingleSyncResult(report);
    } catch (e: any) {
      ElMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "syncNowRecursiveExisting" || command === "syncNowRecursiveFull") {
    ElMessage.info(t("albums.localFolder.recursiveSyncing", { name }));
    try {
      const report = await syncLocalFolderAlbum(id, {
        recursive: true,
        createMissingAlbums: command === "syncNowRecursiveFull",
      });
      if (report) {
        await albumStore.loadAlbums();
        ElMessage.success(
          t("albums.localFolder.recursiveSyncDone", {
            createdAlbums: report.createdAlbums,
            syncedAlbums: report.syncedAlbums,
            added: report.added,
            deleted: report.deleted,
          }),
        );
      }
    } catch (e: any) {
      ElMessage.error(e?.message || String(e));
    }
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
    moveDialog.open();
    return;
  }

  // 检查是否为"收藏"画册（使用固定ID）
  if (id === FAVORITE_ALBUM_ID) {
    ElMessage.warning(t("albums.cannotDeleteFavorite"));
    return;
  }

  try {
    await ElMessageBox.confirm(
      albumStore.isLocalFolderAlbum(id)
        ? t("albums.deleteLocalFolderAlbumConfirm", { name })
        : t("albums.deleteAlbumConfirm", { name }),
      t("albums.confirmDelete"),
      { type: "warning" }
    );
    const deletedIds = [id, ...albumStore.getDescendantIds(id)];
    await albumStore.deleteAlbum(id);
    // 如果删除的是当前轮播画册：自动关闭轮播并切回单张壁纸
    await handleDeletedRotationAlbum(id);
    removeLocalAlbumMediaState(deletedIds);
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

.local-folder-path {
  flex: 1;
  min-width: 0;
  color: var(--anime-text-muted);
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.local-folder-hint {
  margin: 0;
  color: var(--anime-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.local-folder-error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.45;
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
