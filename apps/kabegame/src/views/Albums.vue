<template>
  <div class="albums-page" v-pull-to-refresh="pullToRefreshOpts" v-drag-file="dropZone">
    <!-- 单个 ImageGrid、单个滚动容器（sticky 体系与 Gallery 同源）：#header 页头全宽 sticky 钉顶，
         #aside 树列排在页头之下、自身 sticky 钉在页头下缘，中栏 = before-grid（查询行 / sticky 分页）
         + 图片流，图片能滚到页头下方 -->
    <ImageGrid
      ref="albumViewRef"
      class="albums-grid-body"
      :class="{ 'has-detail': !isCompact && detailOpen }"
      :surface="surface"
      :enable-ctrl-wheel-adjust-columns="!isCompact"
      enable-virtual-scroll
      :enable-ctrl-key-adjust-columns="!isCompact"
      :loading="isRefreshing"
      :loading-overlay="isRefreshing"
      hide-scrollbar
      scroll-whole-container
    >
      <!-- 直接放 AlbumsPageHeader，不能包短容器：sticky 元素被限制在父盒内，父盒等高即失效 -->
      <template #header>
        <AlbumsPageHeader
          class="albums-page-header"
          :album-drive-enabled="albumDriveEnabled"
          @view-vd="openVirtualDrive"
          @refresh="handleRefresh"
          @create-album="openCreateDialogWithParent(null)"
          @open-tree="treeDrawer.open()"
          @toggle-detail="toggleDetailPanel"
        />
      </template>

      <template v-if="!isCompact" #aside>
        <KbResizable
          side="right"
          class="albums-tree-pane"
          v-model="treeWidth"
          :default-size="TREE_DEFAULT_WIDTH"
        >
          <AlbumTreePanel
            :selected-id="selectedAlbumId"
            @select="onTreeSelect"
            @create-album="openCreateDialogWithParent"
            @contextmenu="onTreeContextMenu"
            @dblclick="onTreeDblclick"
          />
        </KbResizable>
      </template>

      <template v-if="!isCompact && detailOpen" #aside-right>
        <KbResizable
          side="left"
          class="albums-detail-pane"
          v-model="detailWidth"
          :default-size="DETAIL_DEFAULT_WIDTH"
        >
          <AlbumDetailPanel
            :album="selectedAlbum"
            :is-hidden="selectedAlbumId === HIDDEN_ALBUM_ID"
            :stats="selectedAlbumStats"
            :is-rotating="isSelectedAlbumRotating"
            :can-create-sub-album="canCreateSubAlbumForSelected"
            :can-rename="selectedAlbumId !== HIDDEN_ALBUM_ID"
            :cover="albumCover"
            @close="detailOpen = false"
            @more="(e: MouseEvent) => selectedAlbum && albumMenu.show(selectedAlbum, e)"
            @command="(cmd) => runAlbumCommand(cmd, selectedAlbum)"
          />
        </KbResizable>
      </template>

      <template #empty>
        <div class="album-empty fade-in">
          <EmptyState />
        </div>
      </template>

      <template #before-grid="{ totalCount, currentPage, pageSize: gridPageSize, jumpToPage }">
        <nav v-if="selectedAlbumId" class="album-breadcrumb-wrap" aria-label="breadcrumb">
          <el-breadcrumb>
            <el-breadcrumb-item v-for="crumb in selectedAlbumAncestorCrumbs" :key="crumb.id">
              <a class="album-breadcrumb-link" @click="selectAlbum(crumb.id)">{{ crumb.name }}</a>
            </el-breadcrumb-item>
            <el-breadcrumb-item>
              <span class="album-breadcrumb-current">{{ selectedAlbumName || "…" }}</span>
              <span class="album-breadcrumb-stats">{{ t("albums.detailCrumbStats", { images: selectedAlbumStats.imageCount, subAlbums: selectedAlbumStats.subAlbumCount }) }}</span>
            </el-breadcrumb-item>
          </el-breadcrumb>
        </nav>

        <GalleryQueryBar
          ref="albumBrowseToolbarRef"
          :query="albumDetailRouteStore.query"
          :no-album="albumDetailRouteStore.effectiveNoAlbum"
          :sort="albumDetailRouteStore.sort"
          :page="albumDetailRouteStore.page"
          :page-size="gridPageSize"
          :search-mode="albumDetailStickySearchMode"
          :provider-context-prefix="albumDetailRouteStore.computedContextPath"
          :context-base="albumDetailRouteStore.contextPathFor({ query: [] })"
          :filter-features="albumFilterFeatures"
          :sort-features="albumSortFeatures"
          enable-clear-all
          @navigate="onQueryNavigate"
          @search-mode-change="rememberAlbumDetailSearchMode"
        />

        <!-- 与 Gallery 同款：查询行随内容滚走，分页条 sticky（top:64）贴在 sticky 页头下方 -->
        <GalleryBigPaginator
          :total-count="totalCount"
          :current-page="currentPage"
          :big-page-size="gridPageSize"
          :is-sticky="true"
          @jump-to-page="jumpToPage"
        />
      </template>
    </ImageGrid>

    <!-- 紧凑模式：左树收进抽屉（useModal 已接 modalStack → Android 返回键可关） -->
    <el-drawer
      v-if="isCompact"
      :model-value="treeDrawer.isOpen.value"
      :z-index="treeDrawer.zIndex.value"
      direction="ltr"
      size="min(80vw, 320px)"
      :with-header="false"
      class="albums-tree-drawer"
      @update:model-value="treeDrawer.close"
    >
      <AlbumTreePanel
        :selected-id="selectedAlbumId"
        @select="(id) => { onTreeSelect(id); treeDrawer.close(); }"
        @create-album="(pid) => { openCreateDialogWithParent(pid); treeDrawer.close(); }"
        @contextmenu="onTreeContextMenu"
        @dblclick="(id) => { onTreeDblclick(id); treeDrawer.close(); }"
      />
    </el-drawer>

    <!-- 紧凑模式：画册信息面板收进右侧抽屉 -->
    <el-drawer
      v-if="isCompact"
      :model-value="detailDrawer.isOpen.value"
      :z-index="detailDrawer.zIndex.value"
      direction="rtl"
      size="min(85vw, 340px)"
      :with-header="false"
      class="albums-detail-drawer"
      @update:model-value="detailDrawer.close"
    >
      <AlbumDetailPanel
        :album="selectedAlbum"
        :is-hidden="selectedAlbumId === HIDDEN_ALBUM_ID"
        :stats="selectedAlbumStats"
        :is-rotating="isSelectedAlbumRotating"
        :can-create-sub-album="canCreateSubAlbumForSelected"
        :can-rename="selectedAlbumId !== HIDDEN_ALBUM_ID"
        :cover="albumCover"
        @close="detailDrawer.close()"
        @more="(e: MouseEvent) => selectedAlbum && albumMenu.show(selectedAlbum, e)"
        @command="(cmd) => runAlbumCommand(cmd, selectedAlbum)"
      />
    </el-drawer>

    <ActionRenderer
      :visible="albumMenu.visible.value"
      :position="albumMenu.position.value"
      :actions="(albumActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="albumMenuContext"
      :z-index="albumMenu.zIndex.value"
      @close="albumMenu.hide"
      @command="(cmd) => runAlbumCommand(cmd as AlbumCommand, albumMenuContext.target)" />

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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, watch } from "vue";
import { ElMessageBox } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useLocalStorage } from "@vueuse/core";
import { invoke } from "@/api/rpc";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import AlbumTreePanel from "@/components/albums/AlbumTreePanel.vue";
import AlbumDetailPanel from "@/components/albums/AlbumDetailPanel.vue";
import type { AlbumPanelCommand } from "@/components/albums/AlbumDetailPanel.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import KbResizable from "@kabegame/core/components/common/KbResizable.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import type { Album } from "@/stores/albums";
import type { ImageInfo } from "@kabegame/core/types/image";
import { storeToRefs } from "pinia";
import { trackEvent } from "@kabegame/core/track/umami";
import { createImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import AlbumsPageHeader from "@/components/header/AlbumsPageHeader.vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_LIGHT_MODE, IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { useModal } from "@kabegame/core/composables/useModal";
import { useI18n } from "@kabegame/i18n";
import {
  querySearchTerm,
  type GalleryBrowseDimension,
  type GalleryQueryPatch,
  type GallerySortField,
} from "@/utils/galleryPath";
import { createAlbumDetailSurface } from "@/components/imageGrid/surfaces/album";
import {
  useAlbumDetailRouteStore,
  albumDetailStickySearchMode,
  rememberAlbumDetailSearchMode,
} from "@/stores/albumDetailRoute";
import {
  useAlbumIdPathState,
  lastAlbumIdOf,
  segmentsOfAlbumIdPath,
} from "@/composables/useAlbumIdPathState";
import { openFilePicker } from "@/api/dialog";
import {
  convertLocalFolderAlbumToNormal,
  setAlbumSyncMode,
  syncLocalFolderAlbum,
  syncLocalFolderAlbums,
} from "@/api/syncLocalFolder";
import type { AlbumSyncMode } from "@kabegame/core/types/album";
import { reportBatchSyncResult, reportSingleSyncResult } from "@/utils/folderSyncReport";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import type { DragFileItem, DragFileOptions, DragFilePlan } from "@/directives/dragFile";
import { createFolderAlbumsFromDrag } from "@/utils/dragFileImport";
import {
  buildAlbumMediaNodes,
  loadAlbumMediaPreview,
  type AlbumMediaNode,
} from "@/utils/albumMediaTree";

const { t } = useI18n();
const albumStore = useAlbumStore();
const { albums } = storeToRefs(albumStore);
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function trackAlbumEnter(album: { id: string; name: string }, source: "tree" | "context_menu") {
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

// ---------- 左树宽度 / 紧凑抽屉 ----------
const TREE_DEFAULT_WIDTH = 248;
const treeWidth = useLocalStorage("kabegame-albums-tree-width", TREE_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
const treeDrawer = useModal();

// ---------- 右栏（画册信息面板）宽度 / 开合 / 紧凑抽屉 ----------
const DETAIL_DEFAULT_WIDTH = 288;
const detailWidth = useLocalStorage("kabegame-albums-detail-width", DETAIL_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
const detailOpen = useLocalStorage("kabegame-albums-detail-open", true, {
  mergeDefaults: true,
});
const detailDrawer = useModal();
const toggleDetailPanel = () => {
  if (isCompact.value) detailDrawer.open();
  else detailOpen.value = !detailOpen.value;
};

// ---------- 选中状态：albumIdPath（祖先链）为唯一真源 ----------
const albumDetailRouteStore = useAlbumDetailRouteStore();
const { albumIdPath, set: setAlbumIdPath } = useAlbumIdPathState();
const selectedAlbumId = computed(() => lastAlbumIdOf(albumIdPath.value));
const selectedAlbum = computed<Album | null>(
  () => albums.value.find((a) => a.id === selectedAlbumId.value) ?? null,
);
const selectedAlbumName = computed(() => {
  if (selectedAlbumId.value === HIDDEN_ALBUM_ID) return t("albums.hiddenAlbumName");
  return selectedAlbum.value?.name ?? "";
});

// ---------- 右栏（画册信息面板）派生数据 ----------
const selectedAlbumStats = computed(() => {
  const id = selectedAlbumId.value;
  if (!id) return { imageCount: 0, subAlbumCount: 0 };
  const stats = albumStore.getAlbumStats(false)[id];
  return { imageCount: stats?.imageCount ?? 0, subAlbumCount: stats?.subAlbumCount ?? 0 };
});

const isSelectedAlbumRotating = computed(
  () => wallpaperRotationEnabled.value && currentRotationAlbumId.value === selectedAlbumId.value,
);

const canCreateSubAlbumForSelected = computed(() => {
  const album = selectedAlbum.value;
  if (!album) return false;
  return album.id !== FAVORITE_ALBUM_ID && album.id !== HIDDEN_ALBUM_ID && album.type !== "local_folder";
});

/** 从根到直接父级（不含当前画册），与 AlbumDetail.vue 的 albumAncestorCrumbs 同款逻辑，
 * 但链接改为切换选中态（selectAlbum）而非路由跳转——本页不再整页跳转。 */
const selectedAlbumAncestorCrumbs = computed((): { id: string; name: string }[] => {
  const id = selectedAlbumId.value;
  if (!id) return [];
  const map = new Map(albums.value.map((a) => [a.id, a]));
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

// 封面：按选中画册取 1 张预览图。走 loadAlbumMediaPreview（与子画册卡片同源，
// 自身没图时会递归到子画册补齐）；`get_album_preview` 那条 Tauri 命令的 provider
// 路径已过时（images://gallery/album/<id>/order 不存在），不能用。
const albumCover = ref<ImageInfo | null>(null);
const selectedAlbumMediaNode = computed<AlbumMediaNode | null>(() => {
  const album = selectedAlbum.value;
  if (!album) return null;
  return (
    buildAlbumMediaNodes(
      [album],
      albums.value,
      albumStore.getAlbumDirectCounts(false),
      false,
    )[0] ?? null
  );
});
watch(
  [selectedAlbumId, () => selectedAlbumStats.value.imageCount],
  async ([id]) => {
    const node = selectedAlbumMediaNode.value;
    if (!id || !node) {
      albumCover.value = null;
      return;
    }
    try {
      const preview = await loadAlbumMediaPreview(node, 1);
      if (selectedAlbumId.value !== id) return; // 过期响应
      albumCover.value = preview[0] ?? null;
    } catch (e) {
      console.error("加载画册封面失败:", e);
      if (selectedAlbumId.value === id) albumCover.value = null;
    }
  },
  { immediate: true },
);

const albumExists = (id: string) =>
  !!id && (id === HIDDEN_ALBUM_ID || albums.value.some((a) => a.id === id));

const selectAlbum = (id: string) => {
  const chain = albums.value.find((a) => a.id === id)?.ancestorPath || `/${id}/`;
  void setAlbumIdPath(chain);
  // 换画册就是换数据源：重置查询/排序/页码（存储 path 只含查询体，见 albumDetailRoute）
  void albumDetailRouteStore.navigate({
    query: [],
    sort: { field: "by-album-order", desc: false },
    page: 1,
  });
};

const onTreeSelect = (id: string) => {
  if (id !== selectedAlbumId.value) {
    trackAlbumEnter({ id, name: albums.value.find((a) => a.id === id)?.name ?? "" }, "tree");
  }
  selectAlbum(id);
};

/** 双击树上的画册：选中它并开合详情面板（第一次点击已由 row-click 选中） */
const onTreeDblclick = (id: string) => {
  selectAlbum(id);
  toggleDetailPanel();
};

onMounted(async () => {
  await albumStore.loadAlbums();
  // 「query 优先、localStorage 兜底」在 useAlbumIdPathState 读取端完成；
  // 这里只做存活校验与最终回落收藏。
  if (!albumExists(selectedAlbumId.value)) selectAlbum(FAVORITE_ALBUM_ID);
});

onActivated(async () => {
  await albumStore.loadAlbums();
});

// 选中画册被删（含事件驱动删除）→ 沿祖先链上溯最近存活者，无则回落收藏
watch(
  () => albumExists(selectedAlbumId.value),
  (ok) => {
    if (ok || albumStore.loading) return;
    if (!selectedAlbumId.value) return;
    const chain = segmentsOfAlbumIdPath(albumIdPath.value);
    const fallback = [...chain].reverse().find((cid) => albumExists(cid));
    selectAlbum(fallback ?? FAVORITE_ALBUM_ID);
  },
);

// ---------- 中栏：ImageGrid surface（与 AlbumDetail 共用 album surface） ----------
const analytics = createImageAnalytics(() => ({
  surface: "albums_page",
  albumId: selectedAlbumId.value,
  albumName: selectedAlbumName.value,
  path: albumDetailRouteStore.computedPath,
}));

const surface = createAlbumDetailSurface({
  albumId: () => selectedAlbumId.value,
  albumName: () => selectedAlbumName.value,
  isLocalFolder: () => albumStore.isLocalFolderAlbum(selectedAlbumId.value),
  analytics,
});

const albumViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);
const albumBrowseToolbarRef = ref<InstanceType<typeof GalleryQueryBar> | null>(null);

const albumFilterFeatures: GalleryBrowseDimension[] = [
  "plugin", "mediaType", "date", "size", "aspect",
];
const albumSortFeatures: GallerySortField[] = [
  "by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time", "by-album-order",
];

const onQueryNavigate = (patch: GalleryQueryPatch, options?: { push?: boolean }) => {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberAlbumDetailSearchMode(term.mode);
  void albumDetailRouteStore.navigate(patch, options);
};

// ---------- 虚拟磁盘 ----------
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

// ---------- 新建画册弹窗 ----------
const createDialog = useModal();

/** 树三点菜单 /「+」按钮入口：预填父级后打开创建弹窗。 */
const openCreateDialogWithParent = (parentId: string | null) => {
  newAlbumParentId.value = parentId;
  createDialog.open();
};

const moveDlgAlbum = ref<Album | null>(null);
const moveDialog = useModal();
const moveToRoot = ref(false);
const moveTargetParentId = ref<string | null>(null);

const moveAlbumTree = computed(() => {
  const a = moveDlgAlbum.value;
  if (!a) return [];
  const exclude = [a.id, ...albumStore.getDescendantIds(a.id), FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID];
  return albumStore.getAlbumTreeExcluding(exclude, { excludeLocalFolder: true });
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

const displayedAlbumCountsForPicker = computed(() => ({
  ...albumStore.getAlbumCounts(false),
}));
// 新建画册的父级候选：排除系统画册与文件夹画册（其成员只能经同步产生）
const createAlbumParentTree = computed(() =>
  albumStore.getAlbumTreeExcluding([FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID], { excludeLocalFolder: true }),
);

// 如果删除的画册正在被“壁纸轮播”引用：自动关闭轮播，切回单张壁纸，并尽量保持当前壁纸不变
const handleDeletedRotationAlbum = async (deletedAlbumId: string) => {
  if (currentRotationAlbumId.value !== deletedAlbumId) return;
  try {
    await setWallpaperRotationAlbumId(null);
  } catch {
    // 静默失败
  }
};

const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await albumStore.loadAlbums();
    // 清除画册详情缓存，确保图片流拿到最新内容
    for (const album of albums.value) {
      delete albumStore.albumImages[album.id];
    }
    delete albumStore.albumImages[FAVORITE_ALBUM_ID];
    await albumViewRef.value?.refresh?.();

    const localFolderIds = albums.value
      .filter((a) => a.type === "local_folder")
      .map((a) => a.id);

    if (IS_ANDROID || IS_WEB || localFolderIds.length === 0) {
      ElMessage.success(t("albums.refreshSuccess"));
    } else {
      ElMessage.warning(t("albums.localFolder.refreshSyncProgressing"));
      const results = await syncLocalFolderAlbums(localFolderIds);
      reportBatchSyncResult(results);
    }
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("albums.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

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
      // parent_id 已废弃：文件夹画册的层级由 sync_folder 的祖先串联唯一决定
      await albumStore.createLocalFolderAlbum(
        {
          name: newAlbumName.value.trim(),
          parentId: null,
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

// ---------- 区域级文件拖入（画册页，只收文件夹）----------
const dropZone = computed<DragFileOptions>(() => ({
  plan: (items: DragFileItem[]): DragFilePlan | null => {
    const folders = items.filter((i) => i.isDirectory);
    if (folders.length === 0) return null;
    return {
      label: t("import.dropZone.albumsFolders", { count: folders.length }),
      media: [],
      folders,
      plugins: [],
    };
  },
  onDrop: async (plan: DragFilePlan) => {
    // 画册页拖入的文件夹建成同步画册（层级由磁盘路径串联决定）
    await createFolderAlbumsFromDrag(plan.folders, null);
  },
}));

// ---------- 画册右键菜单（树节点） ----------
const albumActions = computed(() => createAlbumActions());
const albumMenu = useActionMenu<Album>();

const albumMenuContext = computed<AlbumActionContext>(() => {
  const album = albumMenu.context.value.target;
  return {
    target: album,
    selectedIds: new Set<string>(),
    selectedCount: 0,
    currentRotationAlbumId: currentRotationAlbumId.value,
    wallpaperRotationEnabled: wallpaperRotationEnabled.value,
    albumImageCount: album ? (albumStore.getAlbumCounts(false)[album.id] || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
    isLocalFolder: album?.type === "local_folder",
    albumDriveEnabled: albumDriveEnabled.value,
  };
});

const onTreeContextMenu = (album: Album, event: MouseEvent) => {
  if (album.id === HIDDEN_ALBUM_ID) {
    event.preventDefault();
    return;
  }
  albumMenu.show(album, event);
};

type AlbumCommand =
  | "browse"
  | "delete"
  | "setWallpaperRotation"
  | "stopWallpaperRotation"
  | "rename"
  | "moveTo"
  | "syncNow"
  | "syncNowRecursiveExisting"
  | "syncNowRecursiveFull"
  | "openLocalFolder"
  | "convertToNormal"
  | "createSubAlbum"
  | "openVirtualDrive"
  | `setSyncMode:${AlbumSyncMode}`;

/** 画册操作的唯一入口：树右键、右栏「⋯」、右栏精简按钮共用同一份实现。
 * 显式收画册参数（而非隐式读右键目标）——右栏按钮作用于当前选中画册，与右键目标是两回事。 */
const runAlbumCommand = async (command: AlbumCommand, album: Album | null) => {
  if (!album) return;
  const { id, name } = album;
  albumMenu.hide();

  if (command === "browse") {
    trackAlbumEnter({ id, name }, "context_menu");
    selectAlbum(id);
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

  if (command === "convertToNormal") {
    const descendantCount = albumStore.getDescendantIds(id).length;
    try {
      await ElMessageBox.confirm(
        t("albums.localFolder.convertToNormalConfirm", { count: descendantCount }),
        t("albums.localFolder.convertToNormalTitle"),
        { type: "warning" },
      );
      await convertLocalFolderAlbumToNormal(id);
      await albumStore.loadAlbums();
      ElMessage.success(t("albums.localFolder.convertToNormalSuccess"));
    } catch (error) {
      if (error !== "cancel") {
        const errorMessage =
          typeof error === "string" ? error : (error as any)?.message || String(error);
        ElMessage.error(
          t("albums.localFolder.convertToNormalFailed", { error: errorMessage }),
        );
      }
    }
    return;
  }

  if (command === "createSubAlbum") {
    openCreateDialogWithParent(id);
    return;
  }

  if (command === "openVirtualDrive") {
    try {
      await invoke("open_album_virtual_drive_folder", { albumId: id });
    } catch (e: any) {
      console.error("打开画册虚拟盘失败:", e);
      ElMessage.error(`${e?.message || String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
    }
    return;
  }

  if (command.startsWith("setSyncMode:")) {
    const mode = command.slice("setSyncMode:".length) as AlbumSyncMode;
    if (mode === "delegated") return;
    try {
      await setAlbumSyncMode(id, mode);
    } catch (e: any) {
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
        // 递归入口合并后首次可能返回 skippedInFlight（同一画册并发递归的第二次调用）。
        if (report.skippedInFlight) {
          ElMessage.info(t("albums.localFolder.syncInFlight"));
          return;
        }
        await albumStore.loadAlbums();
        if (report.canceled) return; // 取消的提示走 folder-sync-finished 事件
        const skippedText = report.skippedUnchangedDirs > 0
          ? t("albums.localFolder.recursiveSyncSkippedSuffix", { skipped: report.skippedUnchangedDirs })
          : "";
        ElMessage.success(
          t("albums.localFolder.recursiveSyncDone", {
            createdAlbums: report.createdAlbums,
            syncedAlbums: report.syncedAlbums,
            added: report.added,
            deleted: report.deleted,
            skippedText,
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

  if (command === "stopWallpaperRotation") {
    try {
      await setWallpaperRotationEnabled(false);
      ElMessage.success(t("albums.detailStopRotation"));
    } catch (error) {
      console.error("停止桌面轮播失败:", error);
      ElMessage.error(t("albums.setFailed"));
    }
    return;
  }

  if (command === "rename") {
    // 卡片内联改名随卡片下线：树上改名走 prompt（与 AlbumDetail 子画册改名同款）
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
    await albumStore.deleteAlbum(id);
    // 如果删除的是当前轮播画册：自动关闭轮播并切回单张壁纸
    await handleDeletedRotationAlbum(id);
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
  /* 三栏几何的三个常量：整页内缩，以及 PageHeader 的高度与其下外边距
   * （真源在 packages/kabegame-core/src/components/common/PageHeader.vue）。
   * 下面 aside 的 sticky 偏移与高度全部由它们派生，不再各写各的字面量。 */
  --albums-page-pad: 20px;
  --albums-header-h: 64px;
  --albums-header-gap: 20px;
  /* 页头连同其下外边距占掉的高度，也就是 aside 在滚动流里的自然起点 */
  --albums-header-block: calc(var(--albums-header-h) + var(--albums-header-gap));

  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 与 .gallery-page 同口径的整页内缩：页头/树列/内容距窗口四周 20px */
  padding: var(--albums-page-pad) var(--albums-page-pad) var(--albums-page-pad) 0;
}

.albums-grid-body {
  flex: 1;
  min-height: 0;
}

/* 注意：.albums-grid-body / .image-grid-main 等元素由 core ImageGrid 渲染，不带本组件
 * scope 属性，:deep() 必须从本组件根 .albums-page 出发，否则整条规则不命中。 */

/* 三栏模式：aside 树列钉在页头下缘。
 * sticky top 取 aside 的自然起点（页头 + 页头下外边距）而非仅页头高度——两者差 20px
 * 时它还能往上滑那 20px；高度同样从自然起点算到滚动容器底缘，否则内容不溢出时
 * 整页也会凭空多出 20px 可滚区间。两个值同源，改页头常量即整体跟着走。 */
.albums-page :deep(.albums-grid-body.has-aside) {
  --kb-image-grid-aside-top: var(--albums-header-block);
  --kb-image-grid-aside-height: calc(
    100vh - var(--albums-page-pad) * 2 - var(--albums-header-block)
  );
}

/* 三栏模式中栏：树列与内容之间留 20px；右侧靠页内边距收口（与 Gallery 同缘）。
 * 右栏（画册信息面板）开启时中栏与它之间也留 20px，不再靠页内边距收口。 */
.albums-page :deep(.albums-grid-body.has-aside .image-grid-main) {
  padding: 0 0 12px 20px;
}

.albums-page :deep(.albums-grid-body.has-aside.has-detail .image-grid-main) {
  padding: 0 20px 12px 20px;
}

/* 图片区与分页条之间留一点呼吸感 */
.albums-page :deep(.albums-grid-body.has-aside .image-grid-scroll) {
  padding-top: 8px;
}

/* 紧凑模式（无 aside）：留白由 .albums-page 的整页内边距承担，容器本体不再叠加 */
.albums-page :deep(.albums-grid-body:not(.has-aside) .image-grid-root) {
  overflow: visible;
}

/* KbResizable 契约：父级 flex（.image-grid-aside）+ 自身 flex-none，宽度由 clamp 变量收口 */
.albums-tree-pane {
  --kb-resizable-min: 200px;
  --kb-resizable-max: min(420px, 40vw);
  flex: 0 0 var(--kb-resizable-clamped);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--anime-border, rgba(120, 140, 180, 0.14));
}

/* 右栏（画册信息面板）：对称于 .albums-tree-pane，把手在左 */
.albums-detail-pane {
  --kb-resizable-min: 240px;
  --kb-resizable-max: min(420px, 40vw);
  flex: 0 0 var(--kb-resizable-clamped);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--anime-border, rgba(120, 140, 180, 0.14));
}

.album-empty {
  padding: 48px 0;
}

.albums-tree-drawer :deep(.el-drawer__body),
.albums-detail-drawer :deep(.el-drawer__body) {
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
}

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
    cursor: pointer;
    transition: color 0.15s ease;

    &:hover {
      color: var(--el-color-primary);
    }
  }

  .album-breadcrumb-current {
    color: var(--anime-text-primary);
    font-weight: 500;
  }

  .album-breadcrumb-stats {
    margin-left: 6px;
    color: var(--anime-text-muted);
  }
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
</style>
