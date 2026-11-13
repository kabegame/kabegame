<template>
  <DragFileZone
    class="albums-page"
    :class="{ 'is-compact': isCompact }"
    v-pull-to-refresh="pullToRefreshOpts"
    :plan="planDrop"
    :on-drop="onDropFiles"
  >
    <!-- 单个 ImageGrid、单个滚动容器（sticky 体系与 Gallery 同源）：#header 页头全宽 sticky 钉顶，
         #aside 树列排在页头之下、自身 sticky 钉在页头下缘，中栏 = before-grid（查询行 / sticky 分页）
         + 图片流，图片能滚到页头下方 -->
    <ImageGrid
      ref="albumViewRef"
      class="albums-grid-body"
      :class="{ 'has-detail': !isCompact && detailOpen }"
      :adapter="adapter"
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
          :class="{ 'ml-5': !isCompact }"
          :album-drive-enabled="albumDriveEnabled"
          @view-vd="openVirtualDrive"
          @refresh="handleRefresh"
          @create-album="openCreateDialogWithParent(null)"
          @open-tree="treeDrawerOpen = true"
          @toggle-detail="toggleDetailPanel"
        />
      </template>

      <template v-if="!isCompact" #aside>
        <KbResizable side="right" class="albums-tree-pane" v-model="treeWidth" :default-size="TREE_DEFAULT_WIDTH">
          <AlbumTreePanel
            ref="albumTreePanelRef"
            :selected-id="selectedAlbumId"
            @select="onTreeSelect"
            @create-album="openCreateDialogWithParent"
            @create-label="(pid, directory) => openCreateDialogWithParent(pid, directory ? 'label_dir' : 'label')"
            @contextmenu="onTreeContextMenu"
            @dblclick="onTreeDblclick"
          />
        </KbResizable>
      </template>

      <template v-if="!isCompact && detailOpen" #aside-right>
        <KbResizable side="left" class="albums-detail-pane" v-model="detailWidth" :default-size="DETAIL_DEFAULT_WIDTH">
          <AlbumDetailPanel
            :album="selectedAlbum"
            :is-hidden="selectedAlbumId === HIDDEN_ALBUM_ID"
            :stats="selectedAlbumStats"
            :is-rotating="isSelectedAlbumRotating"
            :can-set-rotation="canSetSelectedAlbumRotation"
            :rotating-screens="selectedAlbumRotatingScreens"
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
          <EmptyState v-if="selectedAlbum?.type === 'label_dir'" :primary-tip="t('albums.labelDirNoImagesHint')" />
          <EmptyState v-else />
        </div>
      </template>

      <template #before-grid="{ totalCount, currentPage, pageSize: gridPageSize, jumpToPage }">
        <nav
          v-if="selectedAlbumId"
          class="mb-3 min-w-0 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
          :aria-label="t('albums.breadcrumbLabel')"
        >
          <ol class="m-0 flex list-none items-center gap-1 whitespace-nowrap p-0 text-[13px] leading-5">
            <li v-for="crumb in selectedAlbumAncestorCrumbs" :key="crumb.id" class="flex items-center gap-1">
              <button
                type="button"
                class="cursor-pointer rounded-kb-sm border-0 bg-transparent px-1 py-0.5 text-kb-fg-muted outline-none transition-colors [font:inherit] hover:bg-kb-hover hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring"
                @click="selectAlbum(crumb.id)"
              >
                {{ crumb.name }}
              </button>
              <ChevronRight class="size-3.5 shrink-0 text-kb-fg-subtle" aria-hidden="true" />
            </li>
            <li class="flex items-center gap-1.5 px-1" aria-current="page">
              <span class="font-600 text-kb-fg">{{ selectedAlbumName || "…" }}</span>
              <span class="tabular-nums text-kb-fg-subtle">
                {{
                  t("albums.detailCrumbStats", {
                    images: selectedAlbumStats.imageCount,
                    subAlbums: selectedAlbumStats.subAlbumCount,
                  })
                }}
              </span>
            </li>
          </ol>
        </nav>

        <GalleryQueryBar
          ref="albumBrowseToolbarRef"
          :query="albumDetailRouteStore.query"
          :no-album="albumDetailRouteStore.effectiveNoAlbum"
          :sort="albumDetailRouteStore.sort"
          :page-size="gridPageSize"
          :search-modes="albumDetailStickySearchModes"
          :provider-context-prefix="albumDetailRouteStore.computedContextPath"
          :context-base="albumDetailRouteStore.contextPathFor({ query: [] })"
          :filter-features="albumFilterFeatures"
          :sort-features="albumSortFeatures"
          enable-clear-all
          @navigate="onQueryNavigate"
          @search-modes-change="rememberAlbumDetailSearchModes"
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

    <!-- 紧凑模式：左树收进左侧面板（Sheet 自己接 Esc、点遮罩与 Android 返回键） -->
    <Sheet
      v-if="isCompact"
      v-model:open="treeDrawerOpen"
      side="left"
      size="min(80vw, 320px)"
      hide-close
      body-class="flex flex-col px-1 py-2"
    >
      <AlbumTreePanel
        ref="compactAlbumTreePanelRef"
        :selected-id="selectedAlbumId"
        @select="
          (id, album) => {
            onTreeSelect(id, album);
            treeDrawerOpen = false;
          }
        "
        @create-album="
          (pid) => {
            openCreateDialogWithParent(pid);
            treeDrawerOpen = false;
          }
        "
        @create-label="
          (pid, directory) => {
            openCreateDialogWithParent(pid, directory ? 'label_dir' : 'label');
            treeDrawerOpen = false;
          }
        "
        @contextmenu="onTreeContextMenu"
        @dblclick="
          (id) => {
            onTreeDblclick(id);
            treeDrawerOpen = false;
          }
        "
      />
    </Sheet>

    <!-- 紧凑模式：画册信息面板收进右侧面板（面板自带关闭按钮） -->
    <Sheet
      v-if="isCompact"
      v-model:open="detailDrawerOpen"
      side="right"
      size="min(85vw, 340px)"
      hide-close
      body-class="flex flex-col px-1 py-2"
    >
      <AlbumDetailPanel
        :album="selectedAlbum"
        :is-hidden="selectedAlbumId === HIDDEN_ALBUM_ID"
        :stats="selectedAlbumStats"
        :is-rotating="isSelectedAlbumRotating"
        :can-set-rotation="canSetSelectedAlbumRotation"
        :rotating-screens="selectedAlbumRotatingScreens"
        :can-create-sub-album="canCreateSubAlbumForSelected"
        :can-rename="selectedAlbumId !== HIDDEN_ALBUM_ID"
        :cover="albumCover"
        @close="detailDrawerOpen = false"
        @more="(e: MouseEvent) => selectedAlbum && albumMenu.show(selectedAlbum, e)"
        @command="(cmd) => runAlbumCommand(cmd, selectedAlbum)"
      />
    </Sheet>

    <ActionRenderer
      :visible="albumMenu.visible.value"
      :position="albumMenu.position.value"
      :actions="albumActions as import('@/actions/types').ActionItem<unknown>[]"
      :context="albumMenuContext"
      :z-index="albumMenu.zIndex.value"
      @close="albumMenu.hide"
      @command="(cmd) => runAlbumCommand(cmd as AlbumCommand, albumMenuContext.target)"
    />

    <Dialog
      v-model:open="createOpen"
      :title="$t('albums.newAlbum')"
      :width="440"
      body-class="flex flex-col gap-3"
      @open-auto-focus="focusFirstInput"
      @close-auto-focus="resetCreateAlbumDialog"
    >
      <SegmentedControl v-model="newAlbumKind" :options="albumKindOptions" class="w-full" />

      <template v-if="isNewLabelForestAlbum">
        <Field :error="newLabelKey && !newLabelKeyValid ? $t('albums.labelKeyInvalidHint') : undefined">
          <Input
            v-model="newLabelKey"
            :placeholder="$t('albums.labelKeyPlaceholder')"
            @keydown.enter="(e: KeyboardEvent) => !e.isComposing && handleCreateAlbum()"
          />
        </Field>
        <Input
          v-model="newAlbumName"
          :placeholder="$t('albums.labelNamePlaceholder')"
          @keydown.enter="(e: KeyboardEvent) => !e.isComposing && handleCreateAlbum()"
        />
      </template>
      <Input
        v-else
        v-model="newAlbumName"
        :placeholder="$t('albums.placeholderName')"
        @keydown.enter="(e: KeyboardEvent) => !e.isComposing && handleCreateAlbum()"
      />

      <AlbumPicker
        v-if="newAlbumKind !== 'local_folder'"
        v-model="newAlbumParentId"
        :scope="createAlbumParentScope"
        :placeholder="isNewLabelForestAlbum ? $t('albums.selectParentLabelDir') : $t('albums.selectParentAlbum')"
        :picker-title="$t('albums.parentAlbum')"
      />

      <div v-if="newAlbumIsLocalFolder" class="flex flex-col gap-2">
        <Field :error="syncFolderDuplicate ? $t('albums.localFolder.duplicatePathHint') : undefined">
          <div class="flex min-w-0 items-center gap-2">
            <Button size="sm" class="shrink-0" @click="pickLocalFolder">
              <FolderOpen />
              {{ $t("albums.localFolder.choosePath") }}
            </Button>
            <span
              class="min-w-0 flex-1 truncate text-[12px] leading-[1.4]"
              :class="newAlbumSyncFolder ? 'kb-selectable text-[var(--kb-fg-regular)]' : 'text-kb-fg-subtle'"
              :title="newAlbumSyncFolder"
            >
              {{ newAlbumSyncFolder || $t("albums.localFolder.noPathSelected") }}
            </span>
          </div>
        </Field>
        <Checkbox v-model="newAlbumRecursive" :label="$t('albums.localFolder.recursive')" />
        <div class="flex flex-col gap-1 text-[12px] leading-[1.5] text-kb-fg-muted">
          <p class="m-0">{{ $t("albums.localFolder.recursiveHint") }}</p>
          <p v-if="newAlbumRecursive" class="m-0">
            {{ $t("albums.localFolder.recursiveLimits", { maxDepth: 16 }) }}
          </p>
          <p class="m-0">{{ $t("albums.localFolder.skipNotice") }}</p>
        </div>
      </div>

      <template #footer>
        <Button @click="createOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="primary" :disabled="!canSubmitCreateAlbum" @click="handleCreateAlbum">
          <Spinner v-if="creatingAlbum" />
          {{ $t("albums.create") }}
        </Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="moveOpen"
      :title="$t('albums.moveToTitle')"
      :width="440"
      body-class="flex flex-col gap-3"
      @close-auto-focus="onMoveAlbumDialogClosed"
    >
      <Checkbox v-model="moveToRoot" :label="$t('albums.moveToRoot')" />
      <AlbumPicker
        v-show="!moveToRoot"
        v-model="moveTargetParentId"
        :scope="moveAlbumScope"
        :clearable="false"
        :placeholder="$t('albums.selectTargetAlbum')"
      />
      <template #footer>
        <Button @click="moveOpen = false">{{ $t("common.cancel") }}</Button>
        <Button variant="primary" @click="confirmMoveAlbum">{{ $t("common.ok") }}</Button>
      </template>
    </Dialog>
  </DragFileZone>
</template>

<script setup lang="ts">
import { useWindowTitlePart } from "@/composables/useWindowTitle";
import {
  albumRotationPath,
  rotatingTargetIds,
  rotationAlbumIdFromPath,
  rotationAlbumIdsFromPaths,
} from "@/utils/wallpaperRotationPath";
import {
  setWallpaperRotationPath,
  useWallpaperRotationSources,
  wallpaperTargetScreenName,
} from "@/composables/useWallpaperTarget";
import { pickWallpaperTarget, pickedScreenName } from "@/composables/useWallpaperTargetPicker";
import { ref, computed, watch } from "vue";
import { kameMessage } from "@/utils/kameMessage";
import { useLocalStorage } from "@vueuse/core";
import { invoke } from "@/api/rpc";
import { createAlbumActions, type AlbumActionContext } from "@/actions/albumActions";
import { useActionMenu } from "@/composables/useActionMenu";
import ActionRenderer from "@/components/ActionRenderer.vue";
import AlbumTreePanel from "@/components/albums/AlbumTreePanel.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import type { AlbumTreeViewScope } from "@/components/albums/types";
import AlbumDetailPanel from "@/components/albums/AlbumDetailPanel.vue";
import type { AlbumPanelCommand } from "@/components/albums/AlbumDetailPanel.vue";
import KbResizable from "@/components/common/KbResizable.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import type { ImageInfo } from "@/types/image";
import { storeToRefs } from "pinia";
import { trackEvent } from "@/track/umami";
import { createImageAnalytics } from "@/track/imageAnalytics";
import AlbumsPageHeader from "@/components/header/AlbumsPageHeader.vue";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { IS_LIGHT_MODE, IS_ANDROID, IS_WEB } from "@/env";
import { useI18n } from "@kabegame/i18n";
import {
  querySearchTerm,
  withPaged,
  type GalleryBrowseDimension,
  type GalleryQueryPatch,
  type GallerySortField,
} from "@/utils/galleryPath";
import { createAlbumDetailAdapter } from "@/components/imageGrid/adapters/album";
import {
  useAlbumDetailRouteStore,
  albumDetailStickySearchModes,
  rememberAlbumDetailSearchModes,
} from "@/stores/albumDetailRoute";
import { useAlbumIdPathState, lastAlbumIdOf, segmentsOfAlbumIdPath } from "@/composables/useAlbumIdPathState";
import { openFilePicker } from "@/api/dialog";
import { convertLocalFolderAlbumToNormal, setAlbumSyncMode, syncLocalFolderAlbum } from "@/api/syncLocalFolder";
import type { AlbumKind, AlbumSyncMode } from "@/types/album";
import { isLabelForestKind } from "@/types/album";
import { isLabelKey } from "@/utils/labelKey";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import DragFileZone from "@/components/common/DragFileZone.vue";
import type { DragFileItem, DragFilePlan } from "@/utils/dragFileZones";
import { buildDropPlan, importDroppedFiles } from "@/utils/dragFileImport";
import { pathqlFetch } from "@/services/pathql";
import { rowToImageInfo } from "@/utils/imageRow";
import { useAlbumQuery } from "@/composables/useAlbumQuery";
import {
  FAVORITE_ALBUM_ID,
  HIDDEN_ALBUM_ID,
  createAlbum,
  createLabelAlbum,
  createLocalFolderAlbum,
  deleteAlbum,
  fetchAlbum,
  fetchDescendantCount,
  fetchLocalFolderAlbums,
  moveAlbum,
  renameAlbum,
  setLabelKey,
  type Album,
  type AlbumNode,
} from "@/services/albums";
import { messageBox } from "@/components/ui/messageBox";
import { ChevronRight, FolderOpen } from "@lucide/vue";
import { Button, Checkbox, Dialog, Field, Input, SegmentedControl, Sheet, Spinner } from "@/components/ui";

const { t } = useI18n();
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);

const pullToRefreshOpts = computed(() =>
  IS_ANDROID ? { onRefresh: handleRefresh, refreshing: isRefreshing.value } : undefined,
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
const treeDrawerOpen = ref(false);

// ---------- 右栏（画册信息面板）宽度 / 开合 / 紧凑抽屉 ----------
const DETAIL_DEFAULT_WIDTH = 288;
const detailWidth = useLocalStorage("kabegame-albums-detail-width", DETAIL_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
const detailOpen = useLocalStorage("kabegame-albums-detail-open", true, {
  mergeDefaults: true,
});
const detailDrawerOpen = ref(false);
const toggleDetailPanel = () => {
  if (isCompact.value) detailDrawerOpen.value = true;
  else detailOpen.value = !detailOpen.value;
};

// ---------- 选中状态：albumIdPath（祖先链）为唯一真源 ----------
const albumDetailRouteStore = useAlbumDetailRouteStore();
const { albumIdPath, set: setAlbumIdPath } = useAlbumIdPathState();
const selectedAlbumId = computed(() => lastAlbumIdOf(albumIdPath.value));
const {
  album: selectedAlbum,
  ancestors: selectedAlbumAncestors,
  imageCount: selectedAlbumImageCount,
  descendantCount: selectedAlbumDescendantCount,
  loading: selectedAlbumLoading,
  refresh: refreshSelectedAlbum,
} = useAlbumQuery(selectedAlbumId);
const selectedAlbumName = computed(() => {
  if (selectedAlbumId.value === HIDDEN_ALBUM_ID) return t("albums.hiddenAlbumName");
  return selectedAlbum.value?.name ?? "";
});
useWindowTitlePart("subject", () => (selectedAlbumId.value ? selectedAlbumName.value : ""));

// ---------- 右栏（画册信息面板）派生数据 ----------
const selectedAlbumStats = computed(() => {
  return {
    imageCount: selectedAlbumImageCount.value,
    subAlbumCount: selectedAlbumDescendantCount.value,
  };
});

// 正在轮播选中画册的壁纸目标（轮播关着时为空）
const selectedAlbumRotatingTargets = computed(() =>
  wallpaperRotationEnabled.value
    ? rotatingTargetIds(rotationSources.value, (path) => rotationAlbumIdFromPath(path) === selectedAlbumId.value)
    : [],
);
const isSelectedAlbumRotating = computed(() => selectedAlbumRotatingTargets.value.length > 0);
// 还有壁纸目标没在轮播它：仍可「设为轮播」（只有一个目标时就是「没在轮播」）
const canSetSelectedAlbumRotation = computed(
  () => selectedAlbumRotatingTargets.value.length < rotationSources.value.length,
);
// 多个壁纸目标时，徽标上写明是哪几块屏在轮播它
const selectedAlbumRotatingScreens = computed(() =>
  rotationSources.value.length > 1
    ? selectedAlbumRotatingTargets.value
        .map((targetId) => wallpaperTargetScreenName(targetId))
        .filter((name): name is string => !!name)
    : [],
);

const canCreateSubAlbumForSelected = computed(() => {
  const album = selectedAlbum.value;
  if (!album) return false;
  return (
    album.id !== FAVORITE_ALBUM_ID &&
    album.id !== HIDDEN_ALBUM_ID &&
    album.type !== "local_folder" &&
    album.type !== "label"
  );
});

/** 从根到直接父级（不含当前画册），供面包屑中间段；
 * 链接切换选中态（selectAlbum）而非路由跳转——本页不整页跳转。 */
const selectedAlbumAncestorCrumbs = computed((): { id: string; name: string }[] => {
  return selectedAlbumAncestors.value.map(({ id, name }) => ({ id, name }));
});

// 普通画册路径包含整个子树；标签与标签目录仍沿用各自 provider 语义。
const albumCover = ref<ImageInfo | null>(null);
watch(
  [selectedAlbumId, () => selectedAlbumStats.value.imageCount],
  async ([id]) => {
    if (!id) {
      albumCover.value = null;
      return;
    }
    try {
      const rows = await pathqlFetch<Record<string, unknown>>(
        withPaged(`images://gallery/album-tree/${encodeURIComponent(id)}`, 1, 1),
      );
      if (selectedAlbumId.value !== id) return; // 过期响应
      albumCover.value = rows[0] ? rowToImageInfo(rows[0]) : null;
    } catch (e) {
      console.error("加载画册封面失败:", e);
      if (selectedAlbumId.value === id) albumCover.value = null;
    }
  },
  { immediate: true },
);

/**
 * 切换选中画册。默认 push 一条 history 记录（用户主动切换,浏览器可后退回上一个
 * 画册）；自动回落（存活校验、删除上溯）传 `history: "replace"`,修正非法状态
 * 不产生历史记录。
 */
const selectAlbum = async (id: string, opts?: { history?: "push" | "replace" }) => {
  const target = await fetchAlbum(id);
  const chain = target?.ancestorPath || `/${id}/`;
  // 必须先 await album 落地再写查询 path：两者是同一 URL 上的两个 query 参数,
  // 各自发起 router 导航,并发时后发导航会取消先发的(album 写入丢失,点击
  // 「不生效」);且 path 的 hide 前缀(ignoreHide)读 currentAlbumId(),只有
  // album 提交后才能算对,否则跨隐藏边界时 hide/ 反复错写又修正。
  await setAlbumIdPath(chain, { history: opts?.history ?? "push" });
  // 换画册就是换数据源：重置查询/排序（存储 path 只含查询体，见
  // albumDetailRoute）。path 写入保持 replace,与上面 push 出的记录合并成
  // 「一次切换 = 一条完整历史记录」,后退一步即回到上一个画册的完整状态。
  await albumDetailRouteStore.navigate({
    query: [],
    sort: { field: "by-album-order", desc: false },
  });
};

const onTreeSelect = async (id: string, node?: AlbumNode) => {
  if (id !== selectedAlbumId.value) {
    const album = node ?? (await fetchAlbum(id));
    trackAlbumEnter({ id, name: album?.name ?? "" }, "tree");
  }
  if (node?.ancestorPath) {
    await setAlbumIdPath(node.ancestorPath, { history: "push" });
    await albumDetailRouteStore.navigate({
      query: [],
      sort: { field: "by-album-order", desc: false },
    });
  } else {
    await selectAlbum(id);
  }
};

/** 双击树上的画册：选中它并开合详情面板（第一次点击已由 row-click 选中） */
const onTreeDblclick = (id: string) => {
  void selectAlbum(id);
  toggleDetailPanel();
};

// 选中画册被删（含事件驱动删除）→ 沿祖先链上溯最近存活者，无则回落收藏
watch([selectedAlbum, selectedAlbumLoading], async ([album, loading]) => {
  if (album || loading) return;
  if (!selectedAlbumId.value) return;
  const chain = segmentsOfAlbumIdPath(albumIdPath.value);
  let fallback: string | null = null;
  for (const id of [...chain].reverse().slice(1)) {
    if (await fetchAlbum(id)) {
      fallback = id;
      break;
    }
  }
  await selectAlbum(fallback ?? FAVORITE_ALBUM_ID, { history: "replace" });
});

// ---------- 中栏：ImageGrid adapter ----------
const analytics = createImageAnalytics(() => ({
  surface: "albums_page",
  albumId: selectedAlbumId.value,
  albumName: selectedAlbumName.value,
  path: albumDetailRouteStore.computedPath,
}));

const adapter = createAlbumDetailAdapter({
  albumId: () => selectedAlbumId.value,
  albumName: () => selectedAlbumName.value,
  isLocalFolder: () => selectedAlbum.value?.type === "local_folder",
  analytics,
});

const albumViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);
const albumBrowseToolbarRef = ref<InstanceType<typeof GalleryQueryBar> | null>(null);
const albumTreePanelRef = ref<InstanceType<typeof AlbumTreePanel> | null>(null);
const compactAlbumTreePanelRef = ref<InstanceType<typeof AlbumTreePanel> | null>(null);

const albumFilterFeatures: GalleryBrowseDimension[] = ["plugin", "mediaType", "date", "size", "aspect"];
const albumSortFeatures: GallerySortField[] = [
  "by-id",
  "by-time",
  "by-size",
  "by-name",
  "by-aspect",
  "by-set-time",
  "by-color",
  "by-album-order",
];

const onQueryNavigate = (patch: GalleryQueryPatch, options?: { push?: boolean }) => {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberAlbumDetailSearchModes(term.modes);
  void albumDetailRouteStore.navigate(patch, options);
};

// ---------- 虚拟磁盘 ----------
const settingsStore = useSettingsStore();
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const albumDriveEnabled = computed(
  () => !IS_ANDROID && !IS_WEB && !IS_LIGHT_MODE && !!settingsStore.values.albumDriveEnabled,
);
const albumDriveMountPoint = computed(() => settingsStore.values.albumDriveMountPoint || "K:\\");

const openVirtualDrive = async () => {
  try {
    await invoke("open_path", { path: albumDriveMountPoint.value });
  } catch (e) {
    console.error("打开虚拟磁盘失败:", e);
    kameMessage.error(`${String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
  }
};

// 各活跃壁纸目标的轮播来源（逐屏独立下每块屏一个）
const rotationSources = useWallpaperRotationSources();
// 当前轮播画册 id：任一活跃壁纸目标的轮播路径直接以某画册为根时才有
const rotationAlbumIds = computed(() => rotationAlbumIdsFromPaths(rotationSources.value.map((source) => source.path)));
// 每个活跃壁纸目标都在轮播的画册：没有哪块屏还能再「设为轮播」。只有一个目标时与上面相同
const fullRotationAlbumIds = computed(() =>
  rotationAlbumIds.value.filter((id) =>
    rotationSources.value.every((source) => rotationAlbumIdFromPath(source.path) === id),
  ),
);
// 轮播是否开启
const wallpaperRotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

// ---------- 新建画册弹窗 ----------
const createOpen = ref(false);
const albumKindOptions = computed(() => [
  { value: "normal" as AlbumKind, label: t("albums.kindNormal") },
  { value: "label" as AlbumKind, label: t("albums.kindLabel") },
  { value: "label_dir" as AlbumKind, label: t("albums.kindLabelDir") },
  ...(IS_ANDROID ? [] : [{ value: "local_folder" as AlbumKind, label: t("albums.kindLocalFolder") }]),
]);

/** 树三点菜单 /「+」按钮入口：预填父级与类型后打开创建弹窗。 */
const openCreateDialogWithParent = (parentId: string | null, kind: AlbumKind = "normal") => {
  newAlbumKind.value = kind;
  newAlbumParentId.value = parentId;
  createOpen.value = true;
};

const moveDlgAlbum = ref<Album | null>(null);
const moveOpen = ref(false);
const moveToRoot = ref(false);
const moveTargetParentId = ref<string | null>(null);

const moveAlbumScope = computed<AlbumTreeViewScope>(() => {
  const a = moveDlgAlbum.value;
  if (!a) return { sections: [] };
  // 标签森林与普通画册互不嵌套：标签只能移到标签下，普通画册不能移进标签森林
  return isLabelForestKind(a.type)
    ? { sections: ["label"], kinds: ["label_dir"], excludeSubtreeOf: [a.id] }
    : { sections: ["normal"], excludeSubtreeOf: [a.id] };
});

watch(moveOpen, (open) => {
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
  const pid = moveToRoot.value ? null : moveTargetParentId.value?.trim() || null;
  if (!moveToRoot.value && !pid) {
    kameMessage.warning(t("albums.selectTargetAlbum"));
    return;
  }
  try {
    await moveAlbum(album.id, pid);
    moveOpen.value = false;
    moveDlgAlbum.value = null;
    kameMessage.success(t("albums.moveSuccess"));
  } catch (e: unknown) {
    const msg =
      typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
    kameMessage.error(msg || t("albums.moveFailed"));
  }
};
const newAlbumName = ref("");
const newAlbumParentId = ref<string | null>(null);
const newAlbumKind = ref<AlbumKind>("normal");
const newAlbumIsLocalFolder = computed(() => newAlbumKind.value === "local_folder");
const isNewLabelForestAlbum = computed(() => isLabelForestKind(newAlbumKind.value));
const newLabelKey = ref("");
const newLabelKeyValid = computed(() => isLabelKey(newLabelKey.value.trim()));
// 切换类型时，旧父级可能不在新类型的候选森林里，清掉避免提交跨森林的父级
watch(newAlbumKind, (kind, prev) => {
  if (!prev) return;
  void (async () => {
    const parent = newAlbumParentId.value ? await fetchAlbum(newAlbumParentId.value) : null;
    if (parent && isLabelForestKind(parent.type) !== isLabelForestKind(kind)) newAlbumParentId.value = null;
  })();
});
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
const localFolderAlbums = ref<Album[]>([]);
watch([createOpen, newAlbumKind], async ([open, kind]) => {
  if (open && kind === "local_folder") localFolderAlbums.value = await fetchLocalFolderAlbums();
});
const existingSyncFolders = computed(
  () =>
    new Set(
      localFolderAlbums.value
        .map((album) => (album.syncFolder ? normalizeSyncPath(album.syncFolder) : ""))
        .filter(Boolean),
    ),
);
/** 选中的同步目录已存在对应的本地文件夹画册：禁用创建并在弹窗提示。 */
const syncFolderDuplicate = computed(() => {
  if (!newAlbumIsLocalFolder.value || !newAlbumSyncFolder.value) return false;
  return existingSyncFolders.value.has(normalizeSyncPath(newAlbumSyncFolder.value));
});
const canSubmitCreateAlbum = computed(() => {
  if (creatingAlbum.value) return false;
  // 标签的名称可选（缺省等于 key），key 必须合规
  if (isNewLabelForestAlbum.value) return newLabelKeyValid.value;
  if (!newAlbumName.value.trim()) return false;
  if (newAlbumIsLocalFolder.value && !newAlbumSyncFolder.value) return false;
  if (syncFolderDuplicate.value) return false;
  return true;
});
const isRefreshing = ref(false);

// 新建画册的父级候选：排除系统画册与文件夹画册（其成员只能经同步产生）；
// 标签只能建在标签森林里，普通画册不能建进标签森林
const createAlbumParentScope = computed<AlbumTreeViewScope>(() =>
  isNewLabelForestAlbum.value ? { sections: ["label"], kinds: ["label_dir"] } : { sections: ["normal"] },
);

const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await Promise.all([
      refreshSelectedAlbum(),
      albumTreePanelRef.value?.reload(),
      compactAlbumTreePanelRef.value?.reload(),
    ]);
    await albumViewRef.value?.refresh?.();

    const selected = selectedAlbum.value;
    if (IS_ANDROID || IS_WEB || selected?.type !== "local_folder") {
      kameMessage.success(t("albums.refreshSuccess"));
    } else {
      void syncLocalFolderAlbum(selected.id).catch((error) => {
        kameMessage.error(error?.message || String(error));
      });
    }
  } catch (error) {
    console.error("刷新失败:", error);
    kameMessage.error(t("albums.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

/** 打开时焦点落在第一个输入框（key 或名称），而不是最上面的类型切换 */
const focusFirstInput = (e: Event) => {
  const input = (e.target as HTMLElement | null)?.querySelector<HTMLInputElement>("input");
  if (!input) return;
  e.preventDefault();
  input.focus();
};

const resetCreateAlbumDialog = () => {
  newAlbumName.value = "";
  newAlbumParentId.value = null;
  newAlbumKind.value = "normal";
  newLabelKey.value = "";
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
    kameMessage.error(t("albums.selectFolderFailed"));
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
    if (isNewLabelForestAlbum.value) {
      await createLabelAlbum({
        key: newLabelKey.value.trim(),
        name: newAlbumName.value.trim() || null,
        parentId,
        directory: newAlbumKind.value === "label_dir",
      });
    } else if (newAlbumIsLocalFolder.value) {
      // parent_id 已废弃：文件夹画册的层级由 sync_folder 的祖先串联唯一决定
      await createLocalFolderAlbum(
        {
          name: newAlbumName.value.trim(),
          parentId: null,
          syncFolder: newAlbumSyncFolder.value,
          recursive: newAlbumRecursive.value,
        },
        { reload: false },
      );
    } else {
      await createAlbum(newAlbumName.value.trim(), { parentId, reload: false });
    }
    createOpen.value = false;
    kameMessage.success(t("albums.albumCreated"));
  } catch (error: any) {
    console.error("创建画册失败:", error);
    // 提取友好的错误信息
    const errorMessage =
      typeof error === "string" ? error : error?.message || String(error) || t("albums.createAlbumFailed");
    kameMessage.error(errorMessage);
  } finally {
    creatingAlbum.value = false;
  }
};

// ---------- 区域级文件拖入（导入当前选中画册）----------
// 收藏 / 隐藏 / 标签目录 / 无选中的拒绝仍写在 plan() 开头，每次命中都读最新选中态。
const planDrop = (items: DragFileItem[]): DragFilePlan | null => {
  const target = selectedAlbum.value;
  if (!target || target.id === FAVORITE_ALBUM_ID || target.id === HIDDEN_ALBUM_ID || target.type === "label_dir") {
    return null;
  }
  return buildDropPlan(items, selectedAlbumName.value);
};

const onDropFiles = async (plan: DragFilePlan) => {
  const target = selectedAlbum.value;
  if (!target) return;
  await importDroppedFiles(plan, target);
};

// ---------- 画册右键菜单（树节点） ----------
const albumActions = computed(() => createAlbumActions());
const albumMenu = useActionMenu<Album>();

const albumMenuContext = computed<AlbumActionContext>(() => {
  const album = albumMenu.context.value.target;
  return {
    target: album,
    selectedIds: new Set<string>(),
    selectedCount: 0,
    rotationAlbumIds: rotationAlbumIds.value,
    fullRotationAlbumIds: fullRotationAlbumIds.value,
    wallpaperRotationEnabled: wallpaperRotationEnabled.value,
    albumImageCount: album
      ? album.id === selectedAlbumId.value
        ? selectedAlbumImageCount.value
        : ((album as AlbumNode).count ?? 0)
      : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
    isLocalFolder: album?.type === "local_folder",
    isLabel: album?.type === "label",
    isLabelDir: album?.type === "label_dir",
    albumDriveEnabled: albumDriveEnabled.value,
  };
});

const onTreeContextMenu = (album: AlbumNode, event: MouseEvent) => {
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
  | "createSubLabel"
  | "createSubLabelDir"
  | "setLabelKey"
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
    await selectAlbum(id);
    return;
  }

  if (command === "openLocalFolder") {
    const folder = album.syncFolder?.trim();
    if (!folder) return;
    try {
      await invoke("open_path", { path: folder });
    } catch (e: any) {
      console.error("打开本地文件夹失败:", e);
      kameMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "convertToNormal") {
    const descendantCount = await fetchDescendantCount(id);
    try {
      await messageBox.confirm(
        t("albums.localFolder.convertToNormalConfirm", { count: descendantCount }),
        t("albums.localFolder.convertToNormalTitle"),
        { type: "warning" },
      );
      await convertLocalFolderAlbumToNormal(id);
      await refreshSelectedAlbum();
      kameMessage.success(t("albums.localFolder.convertToNormalSuccess"));
    } catch (error) {
      if (error !== "cancel") {
        const errorMessage = typeof error === "string" ? error : (error as any)?.message || String(error);
        kameMessage.error(t("albums.localFolder.convertToNormalFailed", { error: errorMessage }));
      }
    }
    return;
  }

  if (command === "createSubAlbum") {
    openCreateDialogWithParent(id, album.type === "label_dir" ? "label" : "normal");
    return;
  }

  if (command === "createSubLabel" || command === "createSubLabelDir") {
    openCreateDialogWithParent(id, command === "createSubLabelDir" ? "label_dir" : "label");
    return;
  }

  if (command === "setLabelKey") {
    try {
      const { value } = await messageBox.prompt(t("albums.labelKeyPlaceholder"), t("contextMenu.setLabelKey"), {
        inputValue: album.labelKey ?? "",
        inputValidator: (v) => isLabelKey(String(v || "").trim()) || t("albums.labelKeyInvalidHint"),
      });
      const newKey = String(value || "").trim();
      if (!newKey || newKey === album.labelKey) return;
      await setLabelKey(id, newKey);
      kameMessage.success(t("albums.labelKeyUpdated"));
    } catch (error) {
      if (error !== "cancel" && error !== "close") {
        const errorMessage = typeof error === "string" ? error : (error as any)?.message || String(error);
        kameMessage.error(errorMessage);
      }
    }
    return;
  }

  if (command === "openVirtualDrive") {
    try {
      await invoke("open_album_virtual_drive_folder", { albumId: id });
    } catch (e: any) {
      console.error("打开画册虚拟盘失败:", e);
      kameMessage.error(`${e?.message || String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
    }
    return;
  }

  if (command.startsWith("setSyncMode:")) {
    const mode = command.slice("setSyncMode:".length) as AlbumSyncMode;
    if (mode === "delegated") return;
    try {
      await setAlbumSyncMode(id, mode);
    } catch (e: any) {
      kameMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "syncNow") {
    try {
      await syncLocalFolderAlbum(id, "none");
    } catch (e: any) {
      kameMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "syncNowRecursiveExisting" || command === "syncNowRecursiveFull") {
    try {
      await syncLocalFolderAlbum(id, command === "syncNowRecursiveFull" ? "createMissing" : "existing");
    } catch (e: any) {
      kameMessage.error(e?.message || String(e));
    }
    return;
  }

  if (command === "setWallpaperRotation") {
    try {
      // 逐屏独立且不止一块屏时先选给哪块屏轮播；取消就什么都不做。只有一个壁纸目标时不弹
      const target = await pickWallpaperTarget({ action: "setRotation" });
      if (!target) return;
      // 先把选中目标换成该画册默认视图的轮播路径，再开启轮播（开关是全局的，开启时直接按新路径拉起）
      if (!(await setWallpaperRotationPath(albumRotationPath(id), target))) return;
      if (!wallpaperRotationEnabled.value) await setWallpaperRotationEnabled(true);
      // 有多个壁纸目标时提示里带上是哪块屏
      const screen = pickedScreenName(target);
      kameMessage.success(
        screen ? t("albums.rotationStartedOn", { name, screen }) : t("albums.rotationStarted", { name }),
      );
    } catch (error) {
      console.error("设置轮播画册失败:", error);
      kameMessage.error(t("albums.setFailed"));
    }
    return;
  }

  if (command === "stopWallpaperRotation") {
    try {
      await setWallpaperRotationEnabled(false);
      kameMessage.success(t("albums.detailStopRotation"));
    } catch (error) {
      console.error("停止桌面轮播失败:", error);
      kameMessage.error(t("albums.setFailed"));
    }
    return;
  }

  if (command === "rename") {
    // 树上改名走 prompt
    try {
      const { value } = await messageBox.prompt(t("albums.placeholderName"), t("albums.title"), {
        inputValue: name,
        inputValidator: (v) => {
          if (!String(v || "").trim()) return t("albums.albumNameCannotBeEmpty");
          return true;
        },
      });
      const newName = String(value || "").trim();
      if (!newName || newName === name) return;
      await renameAlbum(id, newName);
      kameMessage.success(t("albums.renameSuccess"));
    } catch (error) {
      if (error !== "cancel") {
        const errorMessage = typeof error === "string" ? error : (error as any)?.message || String(error);
        kameMessage.error(errorMessage || t("albums.renameFailed"));
      }
    }
    return;
  }

  if (command === "moveTo") {
    moveDlgAlbum.value = album;
    moveOpen.value = true;
    return;
  }

  // 检查是否为"收藏"画册（使用固定ID）
  if (id === FAVORITE_ALBUM_ID) {
    kameMessage.warning(t("albums.cannotDeleteFavorite"));
    return;
  }

  try {
    await messageBox.confirm(
      album.type === "local_folder"
        ? t("albums.deleteLocalFolderAlbumConfirm", { name })
        : t("albums.deleteAlbumConfirm", { name }),
      t("albums.confirmDelete"),
      { type: "warning" },
    );
    // 删的若是某个壁纸目标的轮播画册，后端把该目标的轮播路径退回默认并发 setting-change
    await deleteAlbum(id);
    kameMessage.success(t("albums.albumDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除画册失败:", error);
      kameMessage.error(t("albums.deleteFailed"));
    }
  }
};
</script>

<style scoped lang="scss">
.albums-page {
  /* 三栏几何的三个常量：整页内缩，以及 PageHeader 的高度与其下外边距
   * （真源在 apps/kabegame/src/components/common/PageHeader.vue）。
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

  /* 左侧 0 是让三栏的树列贴窗口左缘；紧凑模式没有树列，补回左内边距与 Gallery 同缘 */
  &.is-compact {
    padding-left: var(--albums-page-pad);
  }
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
  --kb-image-grid-aside-height: calc(100vh - var(--albums-page-pad) * 2 - var(--albums-header-block));
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
  border-right: 1px solid var(--kb-line);
}

/* 右栏（画册信息面板）：对称于 .albums-tree-pane，把手在左 */
.albums-detail-pane {
  --kb-resizable-min: 240px;
  --kb-resizable-max: min(420px, 40vw);
  flex: 0 0 var(--kb-resizable-clamped);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--kb-line);
}

.album-empty {
  padding: 48px 0;
}
</style>
