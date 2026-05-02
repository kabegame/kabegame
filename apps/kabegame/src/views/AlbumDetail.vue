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
          :count="albumStore.albumCounts[child.id] || 0"
          :preview-images="childPreviewImages[child.id] || []"
          :video-preview-remount-key="0"
          :is-loading="false"
          @click="openChildAlbum(child)"
          @visible="prefetchChildPreview(child)"
          @contextmenu="openChildAlbumContextMenu($event, child)"
        />
      </div>
    </div>

    <ImageGrid v-else ref="albumViewRef" class="detail-body" :images="images" :enable-ctrl-wheel-adjust-columns="!isCompact"
      :enable-ctrl-key-adjust-columns="!isCompact" :enable-virtual-scroll="!isCompact"
      :loading="loading || isRefreshing" :loading-overlay="showLoading || isRefreshing" :actions="imageActions"
      :on-context-command="handleImageMenuCommand" hide-scrollbar scroll-whole-container @added-to-album="handleAddedToAlbum">

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

      <template #before-grid>
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
          :page-size="pageSize"
          :search="search"
          @update:filter="(filter) => albumDetailRouteStore.navigate({ filter, page: 1 })"
          @update:sort="(sort) => albumDetailRouteStore.navigate({ sort })"
          @update:pageSize="(ps) => albumDetailRouteStore.navigate({ page: 1, pageSize: ps })"
          @update:search="(s) => albumDetailRouteStore.navigate({ page: 1, search: s })"
        />

        <GalleryBigPaginator :total-count="totalImagesCount" :current-page="currentPage"
          :big-page-size="pageSize" :is-sticky="true" @jump-to-page="handleJumpToPage" />
      </template>
    </ImageGrid>

    <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
      :message="removeDialogMessage" :title="t('gallery.removeFromAlbum')" :checkbox-label="t('gallery.removeDialogCheckboxLabel')" :hide-checkbox="isCompact"
      :danger-text="t('gallery.removeDialogDangerText')" :safe-text="t('gallery.removeDialogSafeText')"
      @confirm="confirmRemoveImages" />

    <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds"
      :exclude-album-ids="albumId ? [albumId] : []" @added="handleAddedToAlbum" />

    <el-dialog v-model="showCreateSubAlbumDialog" :title="t('albums.newAlbum')" width="360px">
      <el-input v-model="newSubAlbumName" :placeholder="t('albums.placeholderName')" />
      <template #footer>
        <el-button @click="showCreateSubAlbumDialog = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :disabled="!newSubAlbumName.trim()" @click="confirmCreateSubAlbum">{{ t("albums.create") }}</el-button>
      </template>
    </el-dialog>

    <ActionRenderer
      :visible="childAlbumMenu.visible.value"
      :position="childAlbumMenu.position.value"
      :actions="(albumActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="childAlbumMenuContext"
      :z-index="3500"
      @close="childAlbumMenu.hide"
      @command="(cmd) => handleChildAlbumMenuCommand(cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename' | 'moveTo')"
    />

    <el-dialog
      v-model="showMoveAlbumDialog"
      :title="t('albums.moveToTitle')"
      width="420px"
      @closed="onMoveAlbumDialogClosed"
    >
      <div class="mb-3">
        <el-checkbox v-model="moveToRoot">{{ t("albums.moveToRoot") }}</el-checkbox>
      </div>
      <AlbumPickerField
        v-show="!moveToRoot"
        v-model="moveTargetParentId"
        :album-tree="moveAlbumTree"
        :album-counts="albumStore.albumCounts"
        :clearable="false"
        :placeholder="t('albums.selectTargetAlbum')"
      />
      <template #footer>
        <el-button @click="showMoveAlbumDialog = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" @click="confirmMoveAlbum">{{ t("common.ok") }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@/api/rpc";
import { setWallpaperOrBackground } from "@/utils/wallpaperMode";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Star, StarFilled, FolderAdd, Picture } from "@element-plus/icons-vue";
import { createImageActions } from "@/actions/imageActions";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import ImageGrid from "@/components/ImageGrid.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import type { Album } from "@/stores/albums";
import AlbumCard from "@/components/albums/AlbumCard.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import AlbumDetailPageHeader from "@/components/header/AlbumDetailPageHeader.vue";
import AlbumDetailBrowseToolbar from "@/components/AlbumDetailBrowseToolbar.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { IS_LIGHT_MODE, IS_WEB } from "@kabegame/core/env";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import type { Component } from "vue";

// 选择操作项类型（用于本页选择栏）
export interface SelectionAction {
  key: string;
  label: string;
  icon: Component;
  command: string;
}
import { useImageOperations } from "@/composables/useImageOperations";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";
import {
  buildAlbumCountPathFromCurrentPath,
  isAlbumWallpaperFilterPath,
} from "@/utils/albumPath";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { useImageTypes } from "@/composables/useImageTypes";
import { openLocalImage } from "@/utils/openLocalImage";
import { clearImageStateCache } from "@kabegame/core/composables/useImageStateCache";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";

const route = useRoute();
const { t } = useI18n();
const router = useRouter();
const isOnAlbumRoute = computed(() => String(route.name ?? "") === "AlbumDetail");

const albumStore = useAlbumStore();
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");
const uiStore = useUiStore();
const { imageGridColumns } = storeToRefs(uiStore);
const isCompact = computed(() => uiStore.isCompact);
const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const isAlbumDetailActive = ref(true);
const albumDetailRouteStore = useAlbumDetailRouteStore();

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("albumdetail");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("albumdetail");

const pullToRefreshOpts = computed(() =>
  isCompact.value
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();


// 虚拟磁盘
const isLightMode = IS_LIGHT_MODE;
const albumDriveEnabled = computed(() => !isLightMode && !!settingsStore.values.albumDriveEnabled);

const albumId = ref<string>("");

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

const childAlbums = computed(() => {
  if (!albumId.value) return [];
  return albumStore.getChildren(albumId.value);
});
const showAlbumDetailTabs = computed(() => childAlbums.value.length > 0);
const activeAlbumDetailTab = ref<"images" | "subAlbums">("images");
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
const showCreateSubAlbumDialog = ref(false);
const newSubAlbumName = ref("");
useModalBack(showCreateSubAlbumDialog);
const showMoveAlbumDialog = ref(false);
useModalBack(showMoveAlbumDialog);
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
    albumImageCount: album ? (albumStore.albumCounts[album.id] || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
  };
});

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

watch(albumId, () => {
  childPreviewImages.value = {};
  activeAlbumDetailTab.value = "images";
});

watch(showAlbumDetailTabs, (hasTabs) => {
  if (!hasTabs) activeAlbumDetailTab.value = "images";
});

const prefetchChildPreview = async (child: Album) => {
  if (childPreviewImages.value[child.id]?.length) return;
  const imgs = await albumStore.loadAlbumPreview(child.id, isCompact.value ? 1 : 3);
  childPreviewImages.value = { ...childPreviewImages.value, [child.id]: imgs };
};

const openChildAlbum = (child: Album) => {
  router.push({ name: "AlbumDetail", params: { id: child.id } });
};

const openChildAlbumContextMenu = (event: MouseEvent, child: Album) => {
  childAlbumMenu.show(child, event);
};

const openCreateSubAlbumDialog = () => {
  newSubAlbumName.value = "";
  showCreateSubAlbumDialog.value = true;
};

const confirmCreateSubAlbum = async () => {
  const name = newSubAlbumName.value.trim();
  if (!name || !albumId.value) return;
  try {
    await albumStore.createAlbum(name, { parentId: albumId.value, reload: true });
    showCreateSubAlbumDialog.value = false;
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

const handleChildAlbumMenuCommand = async (
  command: "browse" | "delete" | "setWallpaperRotation" | "rename" | "moveTo",
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
    showMoveAlbumDialog.value = true;
    return;
  }

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
    ElMessage.success(t("albums.albumDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除子画册失败:", error);
      ElMessage.error(t("albums.deleteFailed"));
    }
  }
};

const albumName = ref<string>("");
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();
const isRefreshing = ref(false);
const currentWallpaperImageId = ref<string | null>(null);
const images = ref<ImageInfo[]>([]);
let leafAllImages: ImageInfo[] = [];
const totalImagesCount = ref<number>(0);
const albumViewRef = ref<any>(null);
const albumSubAlbumsScrollRef = ref<HTMLElement | null>(null);
const albumBrowseToolbarRef = ref<{
  openFilterPicker: () => void;
  openSortPicker: () => void;
  openPageSizePicker: () => void;
} | null>(null);
const albumContainerRef = ref<HTMLElement | null>(null);

// 本地计算的 provider root path，用于初始化
const localProviderRootPath = computed(() => {
  if (!albumId.value) return "";
  // 新格式：album/<albumId>
  return `album/${albumId.value}`;
});

const { pageSize, search } = storeToRefs(albumDetailRouteStore);

const currentPath = computed(() => albumDetailRouteStore.currentPath);
const currentPage = computed(() => albumDetailRouteStore.page);

const isAlbumWallpaperFilterEmpty = computed(() =>
  albumDetailRouteStore.filter === "wallpaper-order"
);

const handleAlbumWallpaperEmptyViewAll = async () => {
  await albumDetailRouteStore.navigate({ filter: "all", page: 1 });
};

const handleJumpToPage = async (page: number) => {
  await albumDetailRouteStore.navigate({ page });
};

const loadTotalImagesCount = async () => {
  if (!albumId.value) return;
  const countPath = buildAlbumCountPathFromCurrentPath(currentPath.value);
  if (!countPath) return;
  const res = await invoke<{ total: number | null }>("browse_gallery_provider", {
    path: countPath,
  });
  totalImagesCount.value = res?.total ?? 0;
};

// 跟随路径变化重载当前 leaf（支持分页器跳转/浏览器前进后退）
watch(
  () => currentPath.value,
  async (newPath) => {
    if (!isOnAlbumRoute.value) return;
    if (!albumId.value) return;
    if (!albumName.value) return;
    if (!newPath) return;
    await loadAlbum({ reset: true });
  },
  { immediate: true }
);

watch(
  () => route.query.path,
  (rawPath) => {
    const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
    if (!isOnAlbumRoute.value) return;
    if (!qp.trim()) return;
    if (qp !== currentPath.value) {
      albumDetailRouteStore.syncFromUrl(qp);
    }
  },
  { immediate: true }
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

useImageGridAutoLoad({
  containerRef: albumContainerRef,
  onLoad: () => { },
});

// Image actions for context menu / action sheet
const imageActions = computed(() =>
  createImageActions({
    removeText: t("gallery.removeFromAlbum"),
  }),
);

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

// 收藏画册标记：当收藏状态变化时，如果页面在后台，标记为需要刷新
const favoriteAlbumDirty = ref(false);

// 移除/删除对话框相关
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);
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
    clearImageStateCache();

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

const loadAlbum = async (opts?: { reset?: boolean; silent?: boolean }) => {
  if (!albumId.value) return;
  const reset = opts?.reset ?? false;
  const silent = opts?.silent ?? false;
  if (!silent) startLoading();
  try {
    if (reset) {
      clearSelection();
      images.value = [];
      leafAllImages = [];
      await nextTick();
    }

    // 直接加载当前路径（新路径格式总是包含页码；可能带 `hide/` 前缀）
    const rawPath = currentPath.value || localProviderRootPath.value || `album/${albumId.value}/1`;
    const inner = rawPath.startsWith("hide/") ? rawPath.slice("hide/".length) : rawPath;
    if (!inner.startsWith("album/") || inner.startsWith("album//")) {
      return;
    }
    const pathToLoad = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
    clearImageMetadataCache();
    const res = await invoke<{ total?: number; entries?: Array<{ kind: string; image?: ImageInfo }> }>(
      "browse_gallery_provider",
      { path: pathToLoad }
    );
    try {
      await loadTotalImagesCount();
    } catch (error) {
      console.error("获取画册总图片数失败:", error);
      totalImagesCount.value = res?.total ?? 0;
    }
    const list: ImageInfo[] = (res?.entries ?? [])
      .filter((e: any) => e?.kind === "image")
      .map((e: any) => e.image as ImageInfo);
    leafAllImages = list;
    images.value = list;
  } finally {
    if (!silent) finishLoading();
  }
};

watch(
  pageSize,
  async (_v, prev) => {
    if (prev === undefined) return;
    await loadAlbum();
  },
);

const handleAddedToAlbum = async () => {
  await albumStore.loadAlbums();
};

const { handleCopyImage } = useImageOperations(
  images,
  currentWallpaperImageId,
  albumViewRef
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

    // 如果勾选了删除文件，则调用 deleteImage（会自动从所有画册移除并删除文件）
    // 否则只从当前画册移除，保留文件和其他画册中的记录
    if (shouldDeleteFiles) {
      // 删除图片：deleteImage 会从所有画册中移除并删除文件
      for (const img of imagesToRemove) {
        await invoke("delete_image", { imageId: img.id });
      }
      // 注意：deleteImage 已经会从所有画册中移除图片，不需要再调用 removeImagesFromAlbum
    } else {
      // 只从当前画册移除，不删除文件
      await albumStore.removeImagesFromAlbum(albumId.value, idsArr);
    }

    if (includesCurrent) {
      currentWallpaperImageId.value = null;
    }

    // 列表由 images-change / album-images-change 事件驱动刷新，不做乐观更新

    // 根据操作类型显示不同的成功消息
    if (shouldDeleteFiles) {
      ElMessage.success(
        count > 1 ? t("gallery.deletedAndRemovedCountSuccess", { count }) : t("gallery.deletedAndRemovedSuccess")
      );
    } else {
      ElMessage.success(
        count > 1 ? t("gallery.removedFromAlbumCountSuccess", { count }) : t("gallery.removedFromAlbumSuccess")
      );
    }
  } catch (error) {
    console.error("操作失败:", error);
    ElMessage.error(shouldDeleteFiles ? t("common.deleteFail") : t("common.removeFail"));
  }
};

// Android 选择模式：构建操作栏 actions
const buildSelectionActions = (selectedCount: number, selectedIds: ReadonlySet<string>): SelectionAction[] => {
  const countText = selectedCount > 1 ? `(${selectedCount})` : "";
  const firstSelectedImage = images.value.find(img => selectedIds.has(img.id));
  const isFavorite = firstSelectedImage?.favorite ?? false;

  if (selectedCount === 1) {
    return [
      { key: "favorite", label: isFavorite ? t("contextMenu.unfavorite") : t("contextMenu.favorite"), icon: isFavorite ? StarFilled : Star, command: "favorite" },
      { key: "addToAlbum", label: t("contextMenu.addToAlbum"), icon: FolderAdd, command: "addToAlbum" },
      { key: "remove", label: t("gallery.removeFromAlbum"), icon: Delete, command: "remove" },
    ];
  } else {
    return [
      { key: "favorite", label: `${t("contextMenu.favorite")}${countText}`, icon: Star, command: "favorite" },
      { key: "addToAlbum", label: `${t("contextMenu.addToAlbum")}${countText}`, icon: FolderAdd, command: "addToAlbum" },
      { key: "remove", label: `${t("gallery.removeFromAlbum")}${countText}`, icon: Delete, command: "remove" },
    ];
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

      // 列表与画册缓存由 album-images-change / images-change 事件驱动刷新

      clearSelection();
      ElMessage.success(desiredFavorite ? `已收藏 ${succeededIds.length} 张` : `已取消收藏 ${succeededIds.length} 张`);
      break;
    }
    case "copy":
      if (IS_WEB) {
        for (const img of imagesToProcess) handleCopyImage(img);
      } else if (imagesToProcess[0]) {
        await handleCopyImage(imagesToProcess[0]);
      }
      break;
    case "open":
      if (!isMultiSelect && image.localPath) {
        try {
          await openLocalImage(image.localPath);
        } catch (error) {
          console.error("打开文件失败:", error);
          ElMessage.error("打开文件失败");
        }
      }
      break;
    case "openFolder":
      if (await guardDesktopOnly("openLocal")) break;
      if (!isMultiSelect) {
        await invoke("open_file_folder", { filePath: image.localPath });
      }
      break;
    case "wallpaper":
      if (!isMultiSelect) {
        await setWallpaperOrBackground(image.id);
        currentWallpaperImageId.value = image.id;
      }
      break;
    case "share":
      if (await guardDesktopOnly("share")) break;
      if (!isMultiSelect && image) {
        try {
          const filePath = image.localPath;
          if (!filePath) {
            ElMessage.error("图片路径不存在");
            break;
          }

          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          await loadImageTypes();
          const mimeType = getMimeTypeForImage(image, ext);
          await invoke("share_file", { filePath, mimeType });
        } catch (error) {
          console.error("分享失败:", error);
          ElMessage.error("分享失败");
        }
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

        const finalName = projectName?.trim() || defaultName;

        const isVideoPath = (path: string) => {
          const ext = (path.split(".").pop() || "").toLowerCase();
          return ext === "mp4" || ext === "mov";
        };
        const isSingleVideo =
          imagesToProcess.length === 1 &&
          isVideoPath(imagesToProcess[0].localPath);

        const res = await invoke<{
          projectDir: string;
          imageCount: number;
          videoCount?: number;
        }>(
          isSingleVideo ? "export_video_to_we_project" : "export_images_to_we_project",
          isSingleVideo
            ? {
                videoPath: imagesToProcess[0].localPath,
                title: finalName,
                outputParentDir,
              }
            : {
                imagePaths: imagesToProcess.map((img) => img.localPath),
                title: finalName,
                outputParentDir,
                options: null,
              }
        );
        const msg = res.videoCount
          ? `已导出 WE 视频工程：${res.projectDir}`
          : `已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`;
        ElMessage.success(msg);
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
    case "addToHidden": {
      if (await guardDesktopOnly("hideImage", { needSuper: true })) break;
      const ids = imagesToProcess.map((img) => img.id);
      if (ids.length === 0) break;
      const isUnhide = !!image?.isHidden || albumId.value === HIDDEN_ALBUM_ID;
      try {
        if (isUnhide) {
          await albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(t("contextMenu.unhideSuccess"));
        } else {
          await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(
            ids.length > 1
              ? t("contextMenu.hiddenCount", { count: ids.length })
              : t("contextMenu.hiddenOne"),
          );
        }
        clearSelection();
      } catch (e) {
        console.error(isUnhide ? "取消隐藏失败:" : "隐藏失败:", e);
        ElMessage.error(t(isUnhide ? "contextMenu.unhideFailed" : "contextMenu.hideFailed"));
      }
      break;
    }
    case "remove":
      // 显示移除对话框，让用户选择是否删除文件
      pendingRemoveImages.value = imagesToProcess;
      const count = imagesToProcess.length;
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);
      const currentHint = includesCurrent ? `\n\n${t("gallery.removeDialogWallpaperHint")}` : "";
      removeDialogMessage.value = (count > 1 ? t("gallery.removeDialogMessageMulti", { count }) : t("gallery.removeDialogMessageSingle")) + currentHint;
      removeDeleteFiles.value = false;
      showRemoveDialog.value = true;
      break;
    case "swipe-remove" as any:
      // 上划删除：直接从画册移除，不删除文件，不显示确认对话框
      if (imagesToProcess.length === 0 || !albumId.value) break;
      void (async () => {
        try {
          const idsArr = imagesToProcess.map((i) => i.id);

          // 只从当前画册移除，不删除文件
          await albumStore.removeImagesFromAlbum(albumId.value, idsArr);

          const includesCurrentWallpaper =
            !!currentWallpaperImageId.value &&
            imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);

          // 如果包含当前壁纸，清除壁纸 ID（列表由事件刷新）
          if (includesCurrentWallpaper) {
            currentWallpaperImageId.value = null;
          }
        } catch (error) {
          console.error("移除图片失败:", error);
          ElMessage.error(t("gallery.removeImageFailed"));
        }
      })();
      break;
  }
  return null;
};

// 初始化画册数据
const initAlbum = async (newAlbumId: string) => {
  // Provider 路径加载不再写入 albumStore.albumImages；当前页已有图片时即可跳过同画册初始化。
  if (albumId.value === newAlbumId && images.value.length > 0) {
    return;
  }

  // 先设置 loading，避免显示空状态
  startLoading();

  // 清理旧数据
  images.value = [];
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

  // 清除store中的缓存，强制重新加载
  delete albumStore.albumImages[newAlbumId];
  await loadAlbum();
};

// 监听路由参数变化
watch(
  () => route.params.id,
  async (newId) => {
    if (!isOnAlbumRoute.value) return;
    if (newId && typeof newId === "string") {
      await initAlbum(newId);
    }
  },
  { immediate: true }
);

onMounted(async () => {
  isAlbumDetailActive.value = true;
  // 注意：任务列表加载已移到 TaskDrawer 组件的 onMounted 中（单例，仅启动时加载一次）
  // 与 Gallery 共用同一套设置
  try {
    await settingsStore.loadAll();
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

  // 收藏状态以 store 为准：不再通过全局事件同步（favoriteChangedHandler 已移除）

  // 收藏状态以 store 为准：不再通过全局事件同步

  // 说明：`images-change`（images 表）与 `album-images-change`（album_images 表）驱动刷新当前页。

});

// 组件从缓存激活时检查是否需要刷新
onActivated(async () => {
  isAlbumDetailActive.value = true;

  // 如果是收藏画册且标记为需要刷新，重新加载
  if (albumId.value === FAVORITE_ALBUM_ID && favoriteAlbumDirty.value) {
    favoriteAlbumDirty.value = false;
    await loadAlbum();
  }
});

onDeactivated(() => {
  isAlbumDetailActive.value = false;
  clearSelection();
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
  if (albumId.value === FAVORITE_ALBUM_ID) {
    ElMessage.warning("不能删除'收藏'画册");
    return;
  }

  try {


    const deletedAlbumId = albumId.value;

    await ElMessageBox.confirm(
      `确定要删除画册"${albumName.value}"吗？此操作仅删除画册及其关联，不会删除图片文件。`,
      "确认删除",
      { type: "warning" }
    );

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

const refreshAlbumDetailPageFromEvents = async () => {
  if (!albumId.value) return;
  const prevList = images.value.slice();
  delete albumStore.albumImages[albumId.value];
  delete albumStore.albumPreviews[albumId.value];
  clearSelection();
  await loadAlbum({ silent: true });

  const { removedIds } = diffById(prevList, images.value);
  if (removedIds.length > 0) clearSelection();
};

// images 表变更：1000ms trailing 节流
useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    if (!albumId.value) return false;
    const reason = String(p.reason ?? "");
    const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
    const intersects = ids.some((id) => leafAllImages.some((img) => img.id === id));

    if (reason === "delete") {
      return ids.length === 0 || intersects;
    }
    if (reason === "change") {
      if (isAlbumWallpaperFilterPath(currentPath.value)) return true;
      return ids.length === 0 || intersects;
    }
    return true;
  },
  onRefresh: refreshAlbumDetailPageFromEvents,
});

// album_images 表变更：与上同策略节流
// HIDDEN 命中时也刷新——HideGate 会改变其它画册详情的可见性
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    if (!albumId.value) return false;
    const ids = p.albumIds ?? [];
    return ids.includes(albumId.value) || ids.includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: refreshAlbumDetailPageFromEvents,
});

onBeforeUnmount(() => {
  // 收藏状态以 store 为准：无需移除监听

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
