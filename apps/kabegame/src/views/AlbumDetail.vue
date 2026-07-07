<template>
  <div class="album-detail" v-pull-to-refresh="pullToRefreshOpts">
    <div
      v-if="showAlbumDetailTabs && activeAlbumDetailTab === 'subAlbums'"
      ref="albumSubAlbumsScrollRef"
      class="album-detail-scroll hide-scrollbar"
    >
      <AlbumDetailPageHeader :album-name="albumName" :total-images-count="totalImagesCount" :is-renaming="isRenaming"
        v-model:editing-name="editingName" :album-drive-enabled="albumDriveEnabled"
        :is-favorite-album="albumId === FAVORITE_ALBUM_ID"
        :is-hidden-album="albumId === HIDDEN_ALBUM_ID"
        :include-browse-controls="false"
        @view-vd="openVirtualDriveAlbumFolder" @refresh="handleRefresh"
        @set-wallpaper-rotate="handleSetAsWallpaperCarousel" @delete-album="handleDeleteAlbum" @help="openHelpDrawer"
        @quick-settings="openQuickSettings" @back="goBack" @start-rename="handleStartRename"
        @confirm-rename="handleRenameConfirm" @cancel-rename="handleRenameCancel"
        @open-browse-filter="albumBrowseToolbarRef?.openFilterPicker()"
        @open-browse-sort="albumBrowseToolbarRef?.openSortPicker()"
        @open-browse-page-size="albumBrowseToolbarRef?.openPageSizePicker()"
        @create-sub-album="openCreateSubAlbumDialog" />

      <nav v-if="albumId" class="album-breadcrumb-wrap" aria-label="breadcrumb">
        <el-breadcrumb>
          <el-breadcrumb-item>
            <router-link :to="{ name: 'Albums' }" class="album-breadcrumb-link">
              {{ t("route.albums") }}
            </router-link>
          </el-breadcrumb-item>
          <el-breadcrumb-item v-for="crumb in albumAncestorCrumbs" :key="crumb.id">
            <router-link
              :to="{ name: 'AlbumDetail', params: { id: crumb.id } }"
              class="album-breadcrumb-link"
            >
              {{ crumb.name }}
            </router-link>
          </el-breadcrumb-item>
          <el-breadcrumb-item>
            <span class="album-breadcrumb-current">{{ albumId === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : (albumName || "…") }}</span>
          </el-breadcrumb-item>
        </el-breadcrumb>
      </nav>

      <StyledTabs v-model="activeAlbumDetailTab" class="album-detail-tabs">
        <el-tab-pane :label="imagesTabLabel" name="images" />
        <el-tab-pane :label="subAlbumsTabLabel" name="subAlbums" />
      </StyledTabs>

      <div
        class="child-albums-view"
        :class="isCompact ? 'child-albums-view--android' : 'child-albums-view--desktop'"
      >
        <AlbumCard
          v-for="child in childAlbums"
          :key="child.id"
          class="child-album-card"
          :album="child"
          :count="childAlbumStats[child.id]?.imageCount || 0"
          :sub-album-count="childAlbumStats[child.id]?.subAlbumCount || 0"
          :preview-images="childPreviewImages[child.id] || []"
          :video-preview-remount-key="0"
          :is-loading="false"
          @click="openChildAlbum(child)"
          @contextmenu="openChildAlbumContextMenu($event, child)"
        />
      </div>
    </div>

    <ImageGrid v-else
      ref="albumViewRef" class="detail-body" :surface="surface"
      :enable-ctrl-wheel-adjust-columns="!isCompact"
      enable-virtual-scroll
      :enable-ctrl-key-adjust-columns="!isCompact"
      :loading="isRefreshing" :loading-overlay="isRefreshing"
      hide-scrollbar scroll-whole-container>

      <template #empty>
        <div class="album-empty fade-in">
          <template v-if="isAlbumWallpaperFilterEmpty">
            <EmptyState :primary-tip="t('gallery.wallpaperOrderEmptyTip')" />
            <el-button type="primary" class="empty-action-btn" @click="handleAlbumWallpaperEmptyViewAll">
              <el-icon>
                <Picture />
              </el-icon>
              {{ t("gallery.viewAllImages") }}
            </el-button>
          </template>
          <template v-else>
            <EmptyState />
          </template>
        </div>
      </template>

      <template #before-grid="{ totalCount, currentPage, pageSize: gridPageSize, jumpToPage }">
        <AlbumDetailPageHeader :album-name="albumName" :total-images-count="totalImagesCount" :is-renaming="isRenaming"
          v-model:editing-name="editingName" :album-drive-enabled="albumDriveEnabled"
          :is-favorite-album="albumId === FAVORITE_ALBUM_ID"
          :is-hidden-album="albumId === HIDDEN_ALBUM_ID"
          :include-browse-controls="activeAlbumDetailTab === 'images'"
          @view-vd="openVirtualDriveAlbumFolder" @refresh="handleRefresh"
          @set-wallpaper-rotate="handleSetAsWallpaperCarousel" @delete-album="handleDeleteAlbum" @help="openHelpDrawer"
          @quick-settings="openQuickSettings" @back="goBack" @start-rename="handleStartRename"
          @confirm-rename="handleRenameConfirm" @cancel-rename="handleRenameCancel"
          @open-browse-filter="albumBrowseToolbarRef?.openFilterPicker()"
          @open-browse-sort="albumBrowseToolbarRef?.openSortPicker()"
          @open-browse-page-size="albumBrowseToolbarRef?.openPageSizePicker()"
          @create-sub-album="openCreateSubAlbumDialog" />

        <nav v-if="albumId" class="album-breadcrumb-wrap" aria-label="breadcrumb">
          <el-breadcrumb>
            <el-breadcrumb-item>
              <router-link :to="{ name: 'Albums' }" class="album-breadcrumb-link">
                {{ t("route.albums") }}
              </router-link>
            </el-breadcrumb-item>
            <el-breadcrumb-item v-for="crumb in albumAncestorCrumbs" :key="crumb.id">
              <router-link
                :to="{ name: 'AlbumDetail', params: { id: crumb.id } }"
                class="album-breadcrumb-link"
              >
                {{ crumb.name }}
              </router-link>
            </el-breadcrumb-item>
            <el-breadcrumb-item>
              <span class="album-breadcrumb-current">{{ albumId === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : (albumName || "…") }}</span>
            </el-breadcrumb-item>
          </el-breadcrumb>
        </nav>

        <StyledTabs v-if="showAlbumDetailTabs" v-model="activeAlbumDetailTab" class="album-detail-tabs">
          <el-tab-pane :label="imagesTabLabel" name="images" />
          <el-tab-pane :label="subAlbumsTabLabel" name="subAlbums" />
        </StyledTabs>

        <AlbumDetailBrowseToolbar
          ref="albumBrowseToolbarRef"
          :album-id="albumDetailRouteStore.albumId"
          :filter="albumDetailRouteStore.filter"
          :sort="albumDetailRouteStore.sort"
          :page-size="gridPageSize"
          :search="search"
          @update:filter="(filter) => albumDetailRouteStore.navigate({ filter, page: 1 })"
          @update:sort="(sort) => albumDetailRouteStore.navigate({ sort })"
          @update:pageSize="(ps) => albumDetailRouteStore.navigate({ page: 1, pageSize: ps })"
          @update:search="(s) => albumDetailRouteStore.navigate({ page: 1, search: s })"
        />

        <GalleryBigPaginator :total-count="totalCount" :current-page="currentPage"
          :big-page-size="gridPageSize" :is-sticky="true" @jump-to-page="jumpToPage" />
      </template>
    </ImageGrid>

    <el-dialog :model-value="createSubAlbumDialog.isOpen.value" :z-index="createSubAlbumDialog.zIndex.value" :title="t('albums.newAlbum')" width="360px" @update:model-value="createSubAlbumDialog.close">
      <el-input v-model="newSubAlbumName" :placeholder="t('albums.placeholderName')" />
      <template #footer>
        <el-button @click="createSubAlbumDialog.close()">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :disabled="!newSubAlbumName.trim()" @click="confirmCreateSubAlbum">{{ t("albums.create") }}</el-button>
      </template>
    </el-dialog>

    <ActionRenderer
      :visible="childAlbumMenu.visible.value"
      :position="childAlbumMenu.position.value"
      :actions="(albumActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="childAlbumMenuContext"
      :z-index="childAlbumMenu.zIndex.value"
      @close="childAlbumMenu.hide"
      @command="(cmd) => handleChildAlbumMenuCommand(cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename' | 'moveTo' | 'syncNow' | 'syncNowRecursiveExisting' | 'syncNowRecursiveFull' | 'openLocalFolder')"
    />

    <el-dialog
      :model-value="moveAlbumDialog.isOpen.value"
      :z-index="moveAlbumDialog.zIndex.value"
      :title="t('albums.moveToTitle')"
      width="420px"
      @update:model-value="moveAlbumDialog.close"
      @closed="onMoveAlbumDialogClosed"
    >
      <div class="mb-3">
        <el-checkbox v-model="moveToRoot">{{ t("albums.moveToRoot") }}</el-checkbox>
      </div>
      <AlbumPickerField
        v-show="!moveToRoot"
        v-model="moveTargetParentId"
        :album-tree="moveAlbumTree"
        :album-counts="childAlbumCountsForPicker"
        :clearable="false"
        :placeholder="t('albums.selectTargetAlbum')"
      />
      <template #footer>
        <el-button @click="moveAlbumDialog.close()">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" @click="confirmMoveAlbum">{{ t("common.ok") }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts">
type AlbumDetailTab = "images" | "subAlbums";

type AlbumDetailSnapshot = {
  albumId: string;
  activeTab: AlbumDetailTab;
  imagesScrollTop: number;
  subAlbumsScrollTop: number;
};

// 画册访问栈：保存「当前画册祖先链」上每个画册的视图状态（滚动位置 / 选项卡）。
// 与浏览器前进后退无关：进入画册时按其祖先链重建该数组（沿用已有快照），
// 回到曾访问过的祖先时恢复其状态；跳到其它分支或经面包屑上溯时，被丢弃的画册状态自然出栈。
const albumDetailStack: AlbumDetailSnapshot[] = [];
</script>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@/api/rpc";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Picture } from "@element-plus/icons-vue";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import ImageGrid from "@/components/ImageGrid.vue";
import { createAlbumDetailSurface } from "@/components/imageGrid/surfaces/album";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import type { Album } from "@/stores/albums";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import AlbumDetailPageHeader from "@/components/header/AlbumDetailPageHeader.vue";
import AlbumDetailBrowseToolbar from "@/components/AlbumDetailBrowseToolbar.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { IS_LIGHT_MODE, IS_WEB, IS_ANDROID } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";
import { createImageAnalytics, currentUrl } from "@kabegame/core/track/imageAnalytics";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "@kabegame/core/composables/useModal";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import {
  albumSubtreeContainsAny,
  buildAlbumMediaNodes,
  flattenAlbumMediaNodes,
  loadAlbumMediaPreview,
  type AlbumMediaNode,
} from "@/utils/albumMediaTree";
import {
  syncLocalFolderAlbum,
  syncLocalFolderAlbums,
  type BatchSyncItem,
  type FolderStatusState,
  type SyncReport,
} from "@/api/syncLocalFolder";

// ---------- Component setup ----------
const route = useRoute();
const { t } = useI18n();
const router = useRouter();
const isOnAlbumRoute = computed(() => String(route.name ?? "") === "AlbumDetail");

// ---------- Stores and route state ----------
const albumStore = useAlbumStore();
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);
const albumDetailRouteStore = useAlbumDetailRouteStore();
const { search, albumId } = storeToRefs(albumDetailRouteStore);

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albumdetail");

const albumName = ref<string>("");
const currentPath = computed(() => albumDetailRouteStore.computedPath);
let lastTrackedAlbumPath: string | null = null;

const isLocalFolderDetail = computed(() => albumStore.isLocalFolderAlbum(albumId.value));

// ---------- Analytics ----------
const analytics = createImageAnalytics(() => ({
  surface: "album_detail",
  albumId: albumId.value,
  albumName: albumName.value,
  path: currentPath.value,
}));

// 数据加载 / 菜单命令 / 本页事件刷新均由 ImageGrid connected 模式接管
const surface = createAlbumDetailSurface({
  albumId: () => albumId.value,
  albumName: () => albumName.value,
  isLocalFolder: () => isLocalFolderDetail.value,
  analytics,
});

// ---------- Album state ----------
const isRefreshing = ref(false);
const pullToRefreshOpts = computed(() =>
  isCompact.value
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

const albumViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);
const albumSubAlbumsScrollRef = ref<HTMLElement | null>(null);
const albumBrowseToolbarRef = ref<{
  openFilterPicker: () => void;
  openSortPicker: () => void;
  openPageSizePicker: () => void;
} | null>(null);
const albumContainerRef = ref<HTMLElement | null>(null);

// grid 卸载（子画册 tab）时保留最后一次总数，供 header / tab label 显示
const totalImagesCount = ref(0);
watch(
  () => albumViewRef.value?.totalImagesCount ?? null,
  (v) => {
    if (typeof v === "number") totalImagesCount.value = v;
  }
);

// ---------- Local folder sync helpers ----------
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

const isLightMode = IS_LIGHT_MODE;
const albumDriveEnabled = computed(() => !isLightMode && !!settingsStore.values.albumDriveEnabled);

// ---------- Album shell actions ----------
const openVirtualDriveAlbumFolder = async () => {
  const id = albumId.value?.trim();
  if (!id) {
    ElMessage.warning("画册 ID 无效");
    return;
  }
  try {
    await invoke("open_album_virtual_drive_folder", { albumId: id });
  } catch (e) {
    console.error("打开虚拟磁盘文件夹失败:", e);
    ElMessage.error(`${String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
  }
};

// ---------- Child albums ----------
const childAlbumRoots = computed(() => {
  if (!albumId.value) return [];
  return albumStore.getChildren(albumId.value);
});
const albumMediaHide = computed(() => albumDetailRouteStore.computedPath.startsWith("hide/"));
const childAlbumNodes = computed(() =>
  buildAlbumMediaNodes(
    childAlbumRoots.value,
    albumStore.albums,
    albumStore.getAlbumDirectCounts(albumMediaHide.value),
    albumMediaHide.value,
  ),
);
const childAlbumNodeById = computed(() => {
  const entries = childAlbumNodes.value
    .flatMap((node) => flattenAlbumMediaNodes(node))
    .map((node) => [node.album.id, node] as const);
  return Object.fromEntries(entries) as Record<string, AlbumMediaNode>;
});
const childAlbums = computed(() => childAlbumNodes.value.map((node) => node.album));
const childAlbumStats = computed(() => albumStore.getAlbumStats(albumMediaHide.value));
const childAlbumCountsForPicker = computed(() => ({
  ...albumStore.getAlbumCounts(albumMediaHide.value),
}));
const showAlbumDetailTabs = computed(() => childAlbums.value.length > 0);
const activeAlbumDetailTab = ref<AlbumDetailTab>("images");
const imagesTabLabel = computed(() => `${t("albums.imagesTab")} (${totalImagesCount.value})`);
const subAlbumsTabLabel = computed(() => `${t("albums.subAlbums")} (${childAlbums.value.length})`);

/** 从根到直接父级（不含当前画册），供面包屑中间段 */
const albumAncestorCrumbs = computed((): { id: string; name: string }[] => {
  const id = albumId.value?.trim();
  if (!id) return [];
  const map = new Map(albumStore.albums.map((a) => [a.id, a]));
  const up: { id: string; name: string }[] = [];
  let cur = map.get(id);
  if (!cur) return [];
  while (cur.parentId) {
    const p = map.get(cur.parentId);
    if (!p) break;
    up.push({ id: p.id, name: p.name });
    cur = p;
  }
  up.reverse();
  return up;
});
const childPreviewImages = ref<Record<string, ImageInfo[]>>({});

// ---------- Dialog flow ----------
const createSubAlbumDialog = useModal();
const newSubAlbumName = ref("");
const moveAlbumDialog = useModal();
const moveDlgAlbum = ref<Album | null>(null);
const moveToRoot = ref(false);
const moveTargetParentId = ref<string | null>(null);

const albumActions = computed(() => createAlbumActions());
const childAlbumMenu = useActionMenu<Album>();
const childAlbumMenuContext = computed<AlbumActionContext>(() => {
  const album = childAlbumMenu.context.value.target;
  return {
    target: album,
    selectedIds: new Set<string>(),
    selectedCount: 0,
    currentRotationAlbumId: currentRotationAlbumId.value,
    wallpaperRotationEnabled: wallpaperRotationEnabled.value,
    albumImageCount: album ? (childAlbumStats.value[album.id]?.imageCount || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
    isLocalFolder: album?.type === "local_folder",
  };
});

const moveAlbumTree = computed(() => {
  const a = moveDlgAlbum.value;
  if (!a) return [];
  const exclude = [a.id, ...albumStore.getDescendantIds(a.id), FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID];
  return albumStore.getAlbumTreeExcluding(exclude);
});

watch(moveAlbumDialog.isOpen, (open) => {
  if (open) {
    moveToRoot.value = false;
    moveTargetParentId.value = null;
  }
});

const onMoveAlbumDialogClosed = () => {
  moveDlgAlbum.value = null;
};

watch(albumId, () => {
  childPreviewImages.value = {};
  activeAlbumDetailTab.value = "images";
});

watch(showAlbumDetailTabs, (hasTabs) => {
  if (!hasTabs) activeAlbumDetailTab.value = "images";
});

const prefetchChildPreview = async (child: Album) => {
  if (childPreviewImages.value[child.id]?.length) return;
  const limit = isCompact.value ? 1 : 3;
  const node = childAlbumNodeById.value[child.id];
  const imgs = node ? await loadAlbumMediaPreview(node, limit) : [];
  childPreviewImages.value = { ...childPreviewImages.value, [child.id]: imgs };
};

// 直接为所有子画册加载预览（不再用视口懒加载；列表变化时自动补齐）
watch(
  () => childAlbums.value.map((a) => a.id).join("|"),
  () => {
    for (const child of childAlbums.value) {
      prefetchChildPreview(child);
    }
  },
  { immediate: true },
);

function trackAlbumChildEnter(child: Album) {
  if (!IS_WEB) return;
  trackEvent("album_child_enter", {
    parentAlbumId: albumId.value,
    parentAlbumName: albumName.value,
    childAlbumId: child.id,
    childAlbumName: child.name,
    path: currentPath.value,
    url: currentUrl(),
  });
}

const openChildAlbum = (child: Album) => {
  trackAlbumChildEnter(child);
  router.push({ name: "AlbumDetail", params: { id: child.id } });
};

const openChildAlbumContextMenu = (event: MouseEvent, child: Album) => {
  childAlbumMenu.show(child, event);
};

const openCreateSubAlbumDialog = () => {
  newSubAlbumName.value = "";
  createSubAlbumDialog.open();
};

const confirmCreateSubAlbum = async () => {
  const name = newSubAlbumName.value.trim();
  if (!name || !albumId.value) return;
  try {
    await albumStore.createAlbum(name, { parentId: albumId.value, reload: false });
    createSubAlbumDialog.close();
    newSubAlbumName.value = "";
    activeAlbumDetailTab.value = "subAlbums";
    ElMessage.success(t("albums.albumCreated"));
  } catch (error: any) {
    const errorMessage =
      typeof error === "string" ? error : error?.message || String(error) || t("albums.createAlbumFailed");
    ElMessage.error(errorMessage);
  }
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
    delete childPreviewImages.value[album.id];
    moveAlbumDialog.close();
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

const handleChildAlbumMenuCommand = async (
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
  const context = childAlbumMenuContext.value;
  const album = context.target;
  if (!album) return;
  const { id, name } = album;
  childAlbumMenu.hide();

  if (command === "browse") {
    openChildAlbum(album);
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
      if (!wallpaperRotationEnabled.value) await setWallpaperRotationEnabled(true);
      await setWallpaperRotationAlbumId(id);
      ElMessage.success(t("albums.rotationStarted", { name }));
    } catch (error) {
      console.error("设置轮播画册失败:", error);
      ElMessage.error(t("albums.setFailed"));
    }
    return;
  }

  if (command === "rename") {
    try {
      const { value } = await ElMessageBox.prompt(
        t("albums.placeholderName"),
        t("albums.title"),
        {
          inputValue: name,
          inputValidator: (v) => {
            if (!String(v || "").trim()) return t("albums.albumNameCannotBeEmpty");
            return true;
          },
        }
      );
      const newName = String(value || "").trim();
      if (!newName || newName === name) return;
      await albumStore.renameAlbum(id, newName);
      ElMessage.success(t("albums.renameSuccess"));
    } catch (error) {
      if (error !== "cancel") {
        const errorMessage =
          typeof error === "string" ? error : (error as any)?.message || String(error);
        ElMessage.error(errorMessage || t("albums.renameFailed"));
      }
    }
    return;
  }

  if (command === "moveTo") {
    moveDlgAlbum.value = album;
    moveAlbumDialog.open();
    return;
  }

  if (id === FAVORITE_ALBUM_ID) {
    ElMessage.warning(t("albums.cannotDeleteFavorite"));
    return;
  }

  try {
    await ElMessageBox.confirm(
      album.type === "local_folder" || albumStore.isLocalFolderAlbum(id)
        ? t("albums.deleteLocalFolderAlbumConfirm", { name })
        : t("albums.deleteAlbumConfirm", { name }),
      t("albums.confirmDelete"),
      { type: "warning" }
    );
    const deletedIds = [id, ...albumStore.getDescendantIds(id)];
    await albumStore.deleteAlbum(id);
    for (const deletedId of deletedIds) {
      delete childPreviewImages.value[deletedId];
    }
    delete childPreviewImages.value[id];
    ElMessage.success(t("albums.albumDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除子画册失败:", error);
      ElMessage.error(t("albums.deleteFailed"));
    }
  }
};

function getImagesScrollEl(): HTMLElement | null {
  return albumViewRef.value?.getContainerEl?.() ?? null;
}

function captureAlbumDetailSnapshot(): AlbumDetailSnapshot | null {
  const currentAlbumId = albumId.value?.trim();
  if (!currentAlbumId) return null;
  return {
    albumId: currentAlbumId,
    activeTab: activeAlbumDetailTab.value,
    imagesScrollTop: getImagesScrollEl()?.scrollTop ?? 0,
    subAlbumsScrollTop: albumSubAlbumsScrollRef.value?.scrollTop ?? 0,
  };
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function applyAlbumDetailSnapshot(snapshot: AlbumDetailSnapshot) {
  if (snapshot.albumId !== albumId.value) return;
  activeAlbumDetailTab.value =
    snapshot.activeTab === "subAlbums" && !showAlbumDetailTabs.value
      ? "images"
      : snapshot.activeTab;

  const restoreScroll = () => {
    const target =
      activeAlbumDetailTab.value === "subAlbums"
        ? albumSubAlbumsScrollRef.value
        : getImagesScrollEl();
    if (!target) return;
    target.scrollTop =
      activeAlbumDetailTab.value === "subAlbums"
        ? snapshot.subAlbumsScrollTop
        : snapshot.imagesScrollTop;
  };

  await nextTick();
  restoreScroll();
  if (activeAlbumDetailTab.value === "images" && isCompact.value) {
    await waitForNextFrame();
    restoreScroll();
  }
}

/** 计算某画册的祖先链 ID（从根到直接父级，不含自身）。 */
function getAlbumAncestorIds(id: string): string[] {
  const map = new Map(albumStore.albums.map((a) => [a.id, a]));
  const chain: string[] = [];
  let cur = map.get(id);
  if (!cur) return chain;
  while (cur.parentId) {
    const p = map.get(cur.parentId);
    if (!p) break;
    chain.push(p.id);
    cur = p;
  }
  chain.reverse();
  return chain;
}

/**
 * 维护访问栈，原则「跳后保存，跳前丢弃」：
 * - 跳后保存：若刚离开的画册是新画册的祖先（向更深层跳转），把它入栈；
 *   仅保存「真正停留过」的画册，被跳过的中间层级不入栈。
 * - 跳前丢弃：剔除所有不在新画册祖先链上的画册状态（新画册自身、其它分支、上溯越过的层级）。
 *
 * 例：直接跳到 A/B/C/D 再跳到 A/B/C/D/E/F，栈为 |D（仅停留过的 D，跳过的 E 不入栈）；
 * 再跳到 A/B/C/D/E，栈仍为 |D（不保存 F，但 D 仍是祖先故保留）；再进入 F 则为 |D|E。
 */
function maintainAlbumDetailStack(
  newAlbumId: string,
  leaving: AlbumDetailSnapshot | null,
) {
  const ancestors = new Set(getAlbumAncestorIds(newAlbumId));
  if (leaving && ancestors.has(leaving.albumId)) {
    albumDetailStack.push(leaving);
  }
  const kept = albumDetailStack.filter((s) => ancestors.has(s.albumId));
  albumDetailStack.length = 0;
  albumDetailStack.push(...kept);
}

function childAlbumScopeIds(): string[] {
  if (!albumId.value) return [];
  return childAlbumRoots.value.flatMap((album) => [
    album.id,
    ...albumStore.getDescendantIds(album.id),
  ]);
}

// ---------- Filter flags ----------
const isAlbumWallpaperFilterEmpty = computed(() =>
  albumDetailRouteStore.filter === "wallpaper-order"
);

const handleAlbumWallpaperEmptyViewAll = async () => {
  await albumDetailRouteStore.navigate({ filter: "all", page: 1 });
};

// ---------- Route synchronization ----------
watch(
  () => [currentPath.value, albumId.value, albumName.value] as const,
  ([path, id, name]) => {
    if (!IS_WEB) return;
    if (!isOnAlbumRoute.value) return;
    if (!path || !id || !name) return;
    const key = `${id}:${path}`;
    if (key === lastTrackedAlbumPath) return;
    lastTrackedAlbumPath = key;
    trackEvent("album_path", {
      albumId: id,
      albumName: name,
      path,
      url: currentUrl(),
    });
  },
  { immediate: true }
);

watch(
  () => `${albumMediaHide.value ? "hide" : "all"}:${childAlbumScopeIds().join("|")}`,
  async (_key, prevKey) => {
    if (!isOnAlbumRoute.value) return;
    const ids = childAlbumScopeIds();
    const keep = new Set(ids);
    for (const id of Object.keys(childPreviewImages.value)) {
      if (!keep.has(id)) delete childPreviewImages.value[id];
    }

    const hideChanged = !!prevKey && prevKey.split(":")[0] !== _key.split(":")[0];
    if (hideChanged) {
      childPreviewImages.value = {};
    }
  },
  { immediate: true },
);

// dragScroll “太快且仍在加速”时的俏皮提示（画册开启）
const dragScrollTooFastMessages = computed(() => [
  t("gallery.scrollTooFast1"),
  t("gallery.scrollTooFast2"),
  t("gallery.scrollTooFast3"),
  t("gallery.scrollTooFast4"),
  t("gallery.scrollTooFast5"),
]);
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
    message: pickOne(dragScrollTooFastMessages.value),
    duration: 900,
    showClose: false,
  });
}

watch(
  [() => albumViewRef.value, activeAlbumDetailTab],
  async () => {
    await nextTick();
    albumContainerRef.value =
      activeAlbumDetailTab.value === "images"
        ? albumViewRef.value?.getContainerEl?.() ?? null
        : null;
  },
  { immediate: true }
);

const clearSelection = () => {
  albumViewRef.value?.clearSelection?.();
};

// 重命名相关
const isRenaming = ref(false);
const editingName = ref("");

// 轮播壁纸相关
const wallpaperRotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);
const currentRotationAlbumId = computed(() => {
  const raw = settingsStore.values.wallpaperRotationAlbumId as any as string | null | undefined;
  const id = (raw ?? "").trim();
  return id ? id : null;
});

// ---------- Album loading flow ----------
const goBack = () => {
  if (IS_WEB) {
    trackEvent("album_detail_exit", {
      albumId: albumId.value,
      albumName: albumName.value,
      path: currentPath.value,
      url: currentUrl(),
    });
  }
  router.back();
};

const handleRefresh = async () => {
  if (!albumId.value) return;
  isRefreshing.value = true;
  try {
    // 1) 刷新画册列表（名称/计数等）
    await albumStore.loadAlbums();
    // 直接重新拉取并覆写子画册预览（不清空，避免清空后不再出现 / 闪屏）
    await refreshAffectedChildPreviews(new Set());
    const found = albumStore.albums.find((a) => a.id === albumId.value);
    if (found) albumName.value = found.name;

    // 3) 手动刷新：清缓存强制重载详情（否则 store 缓存会让 UI 看起来“没刷新”）
    delete albumStore.albumImages[albumId.value];
    delete albumStore.albumPreviews[albumId.value];
    // 4) 重新拉取图片列表 + 清理本地选择
    clearSelection();
    await albumViewRef.value?.refresh();

    const idsToSync = new Set<string>();
    if (albumStore.isLocalFolderAlbum(albumId.value)) {
      idsToSync.add(albumId.value);
    }
    for (const a of albumStore.albums) {
      if (a.parentId === albumId.value && a.type === "local_folder") {
        idsToSync.add(a.id);
      }
    }

    if (IS_ANDROID || IS_WEB || idsToSync.size === 0) {
      ElMessage.success(t("albums.refreshSuccess"));
    } else {
      ElMessage.warning(t("albums.localFolder.refreshSyncProgressing"));
      const results = await syncLocalFolderAlbums(Array.from(idsToSync));
      reportBatchSyncResult(results);
    }
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("albums.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

// ---------- Album initialization ----------
const initAlbum = async (newAlbumId: string) => {
  // 同画册且当前页已有图片时跳过重复初始化
  if (albumId.value === newAlbumId && (albumViewRef.value?.images?.length ?? 0) > 0) {
    return;
  }

  clearSelection();
  albumId.value = newAlbumId;
  const rawPath = route.query.path;
  const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
  if (qp.startsWith(`album/${newAlbumId}/`)) {
    albumDetailRouteStore.syncFromUrl(qp);
  } else {
    await albumDetailRouteStore.navigate({
      albumId: newAlbumId,
      filter: "all",
      sort: "join-asc",
      page: 1,
    });
  }
  await albumStore.loadAlbums();
  const found = albumStore.albums.find((a) => a.id === newAlbumId);
  albumName.value = found?.name || "画册";

  // 清除store中的缓存；列表与总数由 ImageGrid 自动加载（albumName 就绪后 isActive 翻转触发）
  delete albumStore.albumImages[newAlbumId];
};

watch(
  () => route.params.albumId,
  async (newId, oldId) => {
    if (!isOnAlbumRoute.value) return;
    if (!newId || typeof newId !== "string") return;

    const oldAlbumId = typeof oldId === "string" ? oldId : undefined;
    if (oldAlbumId === newId) return;

    // 1) 离开旧画册前，捕获其当前视图状态（滚动 / 选项卡）。
    const leaving = oldAlbumId ? captureAlbumDetailSnapshot() : null;

    // 2) 维护栈之前，查看新画册是否已在栈中。
    //    只有「沿祖先链向上」回到曾停留过的画册时才存在（如面包屑上溯）。
    const restored = albumDetailStack.find((s) => s.albumId === newId) ?? null;

    // 3) 初始化新画册（会加载 albums，使祖先链可计算）。
    await initAlbum(newId);

    // 4) 跳后保存、跳前丢弃地维护访问栈。
    maintainAlbumDetailStack(newId, leaving);

    // 5) 若回到一个曾停留过的祖先，恢复它当时的滚动 / 选项卡。
    if (restored) {
      await applyAlbumDetailSnapshot(restored);
    }
  },
  { immediate: true }
);

// ---------- Album management ----------
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
  editingName.value = albumName.value;
  isRenaming.value = true;
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
    if (totalImagesCount.value === 0) {
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
  if (albumId.value === FAVORITE_ALBUM_ID) {
    ElMessage.warning("不能删除'收藏'画册");
    return;
  }

  try {
    const deletedAlbumId = albumId.value;

    await ElMessageBox.confirm(
      isLocalFolderDetail.value
        ? t("albums.deleteLocalFolderAlbumConfirm", { name: albumName.value })
        : t("albums.deleteAlbumConfirm", { name: albumName.value }),
      t("albums.confirmDelete"),
      { type: "warning" }
    );

    // 删除画册
    await albumStore.deleteAlbum(deletedAlbumId);

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

// ---------- Event-driven refresh（子画册预览维度）----------
// 本画册页面自身的 images-change / album-images-change 刷新由 ImageGrid（surface adapter）
// 接管；这里只保留子画册预览的刷新——它属于 view 状态，且需要在 grid 卸载
// （子画册 tab 激活）时仍然生效。
function childAlbumEventAffectsCurrentSubtree(albumIds: ReadonlySet<string>): boolean {
  if (!albumId.value) return false;
  if (albumIds.size === 0) return true;
  if (albumIds.has(HIDDEN_ALBUM_ID)) return true;
  if (childAlbumNodes.value.some((node) => albumSubtreeContainsAny(node, albumIds))) {
    return true;
  }
  const descendants = new Set(albumStore.getDescendantIds(albumId.value));
  return Array.from(albumIds).some((id) => descendants.has(id));
}

// 受影响子画册预览：直接拉取并覆写，不先清空（既补上缺失的重新拉取，又避免闪屏）
async function refreshAffectedChildPreviews(albumIds: ReadonlySet<string>) {
  const allAffected = albumIds.size === 0;
  const hiddenAffected = albumIds.has(HIDDEN_ALBUM_ID);
  const limit = isCompact.value ? 1 : 3;
  for (const node of childAlbumNodes.value) {
    if (!allAffected && !hiddenAffected && !albumSubtreeContainsAny(node, albumIds)) continue;
    const next = await loadAlbumMediaPreview(node, limit);
    childPreviewImages.value = { ...childPreviewImages.value, [node.album.id]: next };
  }
}

useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    if (!albumId.value) return false;
    const ids = new Set((p.albumIds ?? []).map((id) => String(id).trim()).filter(Boolean));
    return childAlbumEventAffectsCurrentSubtree(ids);
  },
  onRefresh: async (p) => {
    const affected = new Set((p.albumIds ?? []).map((id) => String(id).trim()).filter(Boolean));
    await refreshAffectedChildPreviews(affected);
  },
});

// ---------- Lifecycle ----------
onMounted(() => { });

onActivated(() => { });

onDeactivated(() => {
  clearSelection();
});
</script>

<style scoped lang="scss">
.album-breadcrumb-wrap {
  margin-bottom: 12px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;

  :deep(.el-breadcrumb) {
    font-size: 13px;
    line-height: 1.4;
    white-space: nowrap;
  }

  :deep(.el-breadcrumb__separator) {
    color: var(--anime-text-muted);
    margin: 0 6px;
  }

  .album-breadcrumb-link {
    color: var(--anime-text-muted);
    text-decoration: none;
    transition: color 0.15s ease;

    &:hover {
      color: var(--el-color-primary);
    }
  }

  .album-breadcrumb-current {
    color: var(--anime-text-primary);
    font-weight: 500;
  }
}

.album-detail-tabs {
  flex: none;
  margin-top: 0;

  :deep(.el-tabs__header) {
    margin-bottom: 12px;
  }
}

.child-albums-view {
  padding-right: 2px;
}

/* 桌面：与画册列表页一致的响应式网格 */
.child-albums-view--desktop {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  align-content: start;
}

.child-albums-view--desktop .child-album-card {
  min-width: 0;
}

/* 安卓：与画册列表页一致的双列方格 */
.child-albums-view--android {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  align-content: start;
}

.child-albums-view--android :deep(.album-card) {
  height: auto;
  aspect-ratio: 1;
}

.child-albums-view--android .child-album-card {
  min-width: 0;
}

.album-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;

  .album-detail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .album-detail-scroll.hide-scrollbar {
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .album-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 16px;

    .empty-action-btn {
      margin-top: 4px;
    }
  }

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
