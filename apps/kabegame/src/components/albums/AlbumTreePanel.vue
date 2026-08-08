<template>
  <div class="album-tree-panel flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 pb-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--anime-text-primary)]">
        {{ t("albums.treePanelTitle") }}
      </span>
      <el-dropdown trigger="click" placement="bottom-end" @command="onTitleMenuCommand">
        <button class="album-tree-menu-btn" type="button">
          <el-icon><MoreFilled /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="create-album">
              <el-icon style="margin-right: 6px; vertical-align: middle;"><Plus /></el-icon>
              <span>{{ t("albums.treeAddAlbum") }}</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div class="album-tree-filter px-3 pb-2.5">
      <el-input
        v-model="filterText"
        clearable
        :placeholder="t('albums.treeFilterPlaceholder')"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>

    <KbTreePanel
      class="min-h-0 flex-1"
      :model="model"
      :dnd="dnd"
      :row-state="rowState"
      :indent-px="18"
      :get-row-label="(el: AlbumTreeNode) => el.name"
      @row-click="onRowClick"
      @row-dblclick="(el: AlbumTreeNode) => emit('dblclick', el.id)"
      @row-contextmenu="onRowContextMenu"
    >
      <template #section-header="{ sectionId }">
        <span
          v-if="sectionId === 'local-folders'"
          class="album-tree-dim pl-3 text-[11px] tracking-[0.06em]"
        >
          {{ t("albums.treeSectionLocalFolders") }}
        </span>
      </template>
      <template #row="{ element }">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <el-icon class="flex-none text-[14px]" :class="folderIconClass(element)">
            <component :is="folderIconOf(element)" />
          </el-icon>
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ displayNameOf(element) }}</span>
          <span class="flex-1" />
          <el-icon
            v-if="isRotatingAlbum(element)"
            class="flex-none text-[12px] text-[var(--anime-primary)]"
            :title="t('albums.treeRotationTooltip')"
          >
            <Monitor />
          </el-icon>
          <el-tooltip
            v-if="syncModeIconOf(element)"
            :content="syncModeTooltip(syncModeOf(element))"
            placement="top"
          >
            <el-icon
              class="flex-none text-[12px]"
              :class="syncModeIconClass(syncModeOf(element))"
            >
              <component :is="syncModeIconOf(element)!" />
            </el-icon>
          </el-tooltip>
          <el-tooltip
            v-if="folderStatusBad(element)"
            :content="t('albums.treeFolderStatusTooltip', { state: element.folderStatus?.state ?? '' })"
            placement="top"
          >
            <span class="album-tree-status-dot flex-none" />
          </el-tooltip>
          <span class="album-tree-dim flex-none text-[11px]">{{ countOf(element) }}</span>
        </div>
      </template>
    </KbTreePanel>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Folder, MoreFilled, Monitor, Picture, Plus, Search, StarFilled, Delete } from "@kabegame/element-plus-icons";
import KbTreePanel from "@/components/tree/KbTreePanel.vue";
import { useTreeModel } from "@/components/tree/useTreeModel";
import type { TreeDataSource, TreeDndController, TreeRowState } from "@/components/tree/types";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID, type Album } from "@/stores/albums";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { buildAlbumTreeFromFlat, type AlbumTreeNode } from "@kabegame/core/utils/albumTree";
import { segmentsOfAlbumIdPath } from "@/composables/useAlbumIdPathState";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import type { AlbumSyncMode } from "@kabegame/core/types/album";
import { syncModeIcon, syncModeIconClass, syncModeTooltip } from "@/utils/albumSyncMode";

/**
 * 画册树侧栏：系统区（收藏 + 垃圾桶，恒平铺）/ 普通画册树 / 「本地文件夹」小节森林。
 * 数据全部是 useAlbumStore 的 computed 投影；树结构变化时 watch 后 model.reload()
 * （按 key diff 保展开态），计数变化不触发 reload（行模板直接读 computed）。
 */
const props = withDefaults(
  defineProps<{
    selectedId: string | null;
    /** 刷新事件二选一；默认与画册页整体一致 */
    refreshEvent?: "album-images-change" | "images-change";
  }>(),
  { refreshEvent: "album-images-change" },
);

const emit = defineEmits<{
  select: [albumId: string];
  "create-album": [parentId: string | null];
  contextmenu: [album: Album, event: MouseEvent];
  /** 双击画册行：宿主用来开合右侧详情面板 */
  dblclick: [albumId: string];
}>();

const { t } = useI18n();
const albumStore = useAlbumStore();
const settingsStore = useSettingsStore();
const globalPathRoute = useGlobalPathRoute();

const filterText = ref("");

function toTreeLeaf(album: Album, nameOverride?: string): AlbumTreeNode {
  return {
    id: album.id,
    name: nameOverride ?? album.name,
    parentId: null,
    createdAt: album.createdAt,
    type: album.type,
    syncFolder: album.syncFolder,
    folderStatus: album.folderStatus,
    syncMode: album.syncMode,
    children: [],
  };
}

const systemRoots = computed<AlbumTreeNode[]>(() => {
  const out: AlbumTreeNode[] = [];
  const favorite = albumStore.albums.find((a) => a.id === FAVORITE_ALBUM_ID);
  if (favorite) out.push(toTreeLeaf(favorite));
  const hidden = albumStore.albums.find((a) => a.id === HIDDEN_ALBUM_ID);
  if (hidden) out.push(toTreeLeaf(hidden, t("albums.hiddenAlbumName")));
  return out;
});

const normalTreeRoots = computed<AlbumTreeNode[]>(() =>
  albumStore.getAlbumTreeExcluding([FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID], { excludeLocalFolder: true }),
);

const localFolderRoots = computed<AlbumTreeNode[]>(() =>
  buildAlbumTreeFromFlat(albumStore.albums.filter((a) => a.type === "local_folder")),
);

const selectedAncestorIds = computed<Set<string>>(() => {
  const id = props.selectedId;
  if (!id) return new Set();
  const album = albumStore.albums.find((a) => a.id === id);
  if (!album) return new Set([id]);
  return new Set(segmentsOfAlbumIdPath(album.ancestorPath));
});

const dataSource: TreeDataSource<AlbumTreeNode> = {
  getKey: (n) => n.id,
  hasChildren: (n) => n.children.length > 0,
  getChildren: (n) => n.children,
};

const model = useTreeModel<AlbumTreeNode>({
  dataSource,
  sections: () => [
    { id: "system", roots: () => systemRoots.value },
    { id: "normal", separatorBefore: true, roots: () => normalTreeRoots.value },
    { id: "local-folders", header: true, separatorBefore: true, roots: () => localFolderRoots.value },
  ],
  defaultExpanded: (element) => selectedAncestorIds.value.has(element.id),
  filterText,
  getFilterLabel: (element) => element.name,
});

/** 选中态变化（非结构重载）时确保祖先链已展开——defaultExpanded 只在句柄创建时生效一次 */
function ensureSelectedExpanded() {
  for (const id of selectedAncestorIds.value) {
    const handle = model.nodeByKey(id);
    if (handle && handle.hasChildren && !handle.expanded) void model.expand(id);
  }
}
watch(() => props.selectedId, () => ensureSelectedExpanded());

// 树结构变化（增删/改名/移动/类型/同步状态）→ 整体 reload（按 key diff 保展开态）；
// 计数变化不在这个签名里，不触发 reload（行模板直接读 directCounts computed）。
watch(
  () =>
    albumStore.albums
      .map(
        (a) =>
          `${a.id}:${a.parentId}:${a.name}:${a.type}:${a.syncFolder ?? ""}:${a.folderStatus?.state ?? ""}:${a.syncMode}`,
      )
      .join("|"),
  async () => {
    await model.reload();
    ensureSelectedExpanded();
  },
);

// 计数：聚合口径（含全部子孙画册，与 AddToAlbumDialog 的 albumCounts 同源），
// 随全局 hide 开关切换数据集；收藏/垃圾桶无子画册，聚合值即直接值
const aggregateCounts = computed(() => albumStore.getAlbumCounts(globalPathRoute.hide));
function countOf(node: AlbumTreeNode): number {
  // 隐藏画册的成员本就是隐藏图片，hide 口径下恒为 0——固定读全量口径显示真实数量
  if (node.id === HIDDEN_ALBUM_ID) return albumStore.getAlbumCounts(false)[node.id] ?? 0;
  return aggregateCounts.value[node.id] ?? 0;
}

function folderIconOf(node: AlbumTreeNode) {
  if (node.id === FAVORITE_ALBUM_ID) return StarFilled;
  if (node.id === HIDDEN_ALBUM_ID) return Delete;
  // 普通画册用画廊同款 Picture，Folder 留给本地文件夹画册，避免两者混淆
  if (node.type === "local_folder") return Folder;
  return Picture;
}
function folderIconClass(node: AlbumTreeNode): string {
  if (node.type === "local_folder") return "text-[#7c3aed]";
  if (node.id === FAVORITE_ALBUM_ID) return "text-[#e11d48]";
  return "album-tree-dim";
}
function displayNameOf(node: AlbumTreeNode): string {
  return node.id === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : node.name;
}
function isRotatingAlbum(node: AlbumTreeNode): boolean {
  return (
    !!settingsStore.values.wallpaperRotationEnabled &&
    settingsStore.values.wallpaperRotationAlbumId === node.id
  );
}
function folderStatusBad(node: AlbumTreeNode): boolean {
  return !!node.folderStatus && node.folderStatus.state !== "ok";
}
function syncModeOf(node: AlbumTreeNode): AlbumSyncMode {
  return node.syncMode ?? "none";
}
function syncModeIconOf(node: AlbumTreeNode) {
  return syncModeIcon(syncModeOf(node));
}

function rowState(element: AlbumTreeNode): TreeRowState {
  return {
    active: element.id === props.selectedId,
    // 隐藏画册整行灰字弱化：内容是被藏起来的图片，视觉上与常规画册区分
    muted: element.id === HIDDEN_ALBUM_ID,
  };
}

function onRowClick(element: AlbumTreeNode) {
  emit("select", element.id);
}

function onRowContextMenu(element: AlbumTreeNode, event: MouseEvent) {
  const album = albumStore.albums.find((a) => a.id === element.id);
  if (album) emit("contextmenu", album, event);
}

function onTitleMenuCommand(command: string) {
  if (command !== "create-album") return;
  const id = props.selectedId;
  const album = id ? albumStore.albums.find((a) => a.id === id) : null;
  const parentId =
    album && album.type === "normal" && album.id !== FAVORITE_ALBUM_ID && album.id !== HIDDEN_ALBUM_ID
      ? album.id
      : null;
  emit("create-album", parentId);
}

// ---------- DnD：合法性=移动弹窗排除集 + 新类型规则；提交=albumStore.moveAlbum ----------
const dnd: TreeDndController<AlbumTreeNode> = {
  canDrag: (n) => n.id !== FAVORITE_ALBUM_ID && n.id !== HIDDEN_ALBUM_ID && n.type !== "local_folder",
  getDragLabel: (n) => n.name,
  onDragOver: (src, target) => {
    if (target == null) return { accept: src.parentId != null, position: "inside" };
    if (target.id === src.id || target.id === src.parentId) return false;
    if (target.id === FAVORITE_ALBUM_ID || target.id === HIDDEN_ALBUM_ID) return false;
    if (target.type === "local_folder") return false;
    if (albumStore.getDescendantIds(src.id).includes(target.id)) return false;
    return { accept: true, position: "inside", autoExpand: true };
  },
  drop: async (src, target) => {
    try {
      await albumStore.moveAlbum(src.id, target?.id ?? null);
      ElMessage.success(t("albums.moveSuccess"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ElMessage.error(msg || t("albums.moveFailed"));
    }
  },
};

// ---------- 刷新：refreshEvent 二选一，兜底重拉计数 ----------
// store 对 album-images-change 已按 directCounts 增量 patch；这里的监听主要
// 兜 images-change 型场景（如整图删除未必带精确 albumIds）与手动指定的 refreshEvent。
const refreshEnabled = ref(true);
const refreshCounts = () => {
  void albumStore.refreshAlbumDirectCounts(false);
  void albumStore.refreshAlbumDirectCounts(true);
};
if (props.refreshEvent === "images-change") {
  useImagesChangeRefresh({ enabled: refreshEnabled, waitMs: 1000, onRefresh: refreshCounts });
} else {
  useAlbumImagesChangeRefresh({ enabled: refreshEnabled, waitMs: 1000, onRefresh: refreshCounts });
}
</script>

<style scoped>
.album-tree-panel {
  --kb-tree-sticky-bg: var(--anime-surface, #fff);
  --kb-tree-sticky-backdrop: none;

  /* 树行几何：对齐设计稿 kabegame-albums-1b（行 padding 7/8、13px 字、18px 缩进、
   * 14px 折叠三角列）。这些是 KbTreeRow 的 token，不缺省即画廊树原样。 */
  --kb-tree-row-font-size: 13px;
  --kb-tree-row-padding-x: 8px;
  --kb-tree-row-radius: 8px;
  --kb-tree-row-gap: 8px;
  /* 设计稿是 14px 列；这里取 16px 换一点点击面积，图标左缘只差 2px */
  --kb-tree-twistie-size: 16px;
  --kb-tree-twistie-icon-size: 9px;
  --kb-tree-separator-color: rgba(120, 140, 180, 0.14);

  /* 选中态：设计稿是淡紫底 + 深色加粗字，而非画廊树那套粉底粉字
   * （粉底粉字在本页粉色背景上对比度不足，糊成一团） */
  --kb-tree-row-active-bg: rgba(167, 139, 250, 0.18);
  --kb-tree-row-active-color: var(--anime-text-primary);
  --kb-tree-row-active-weight: 600;
}

/* 次要信息（计数 / 中性文件夹图标 / 小节标题）：设计稿是主文字色 45% 的灰。
 * --anime-text-muted(#a78bfa) 在本页浅色底上太淡，改用主文字色调透明度。 */
.album-tree-dim {
  color: color-mix(in srgb, var(--anime-text-primary) 52%, transparent);
}

/* 行区左右内缩：行高亮成内缩圆角胶囊（对齐设计稿），比过滤框再往外 4px */
.album-tree-panel :deep(.kb-tree-panel__scroller) {
  padding: 2px 8px 8px;
}

/* sticky overlay 行默认 inset-x-0 贴边，跟随行区同步内缩，避免吸顶瞬间宽度跳变 */
.album-tree-panel :deep(.kb-tree-panel__sticky-row) {
  inset-inline: 8px;
}

/* 过滤框：设计稿 30px 高、12px 字。高度经 el 的 component-size 走正规链路
 * （--el-input-height 由它派生），不去写死 .el-input__wrapper 的 height。 */
.album-tree-filter {
  --el-component-size: 30px;
}

.album-tree-filter :deep(.el-input__inner) {
  font-size: 12px;
}

/* 标题右侧三点：设计稿是一枚低调图标，不要 el-button 的圆形 hover 块 */
.album-tree-menu-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--anime-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.album-tree-menu-btn:hover {
  color: var(--anime-text-secondary);
  background: rgba(167, 139, 250, 0.16);
}

.album-tree-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef4444;
}
</style>
