<template>
  <div class="album-tree-view flex min-h-0 flex-1 flex-col">
    <KbTreePanel
      class="min-h-0 flex-1"
      :model="model"
      :dnd="dnd"
      :row-state="rowState"
      :row-click-toggles="expandOnly"
      :indent-px="18"
      :get-row-label="(node: AlbumNode) => node.name"
      @row-click="select"
      @row-dblclick="(node: AlbumNode) => !expandOnly(node) && emit('dblclick', node.id)"
      @row-contextmenu="(node: AlbumNode, event: MouseEvent) => emit('contextmenu', node, event)"
    >
      <template #section-header="{ sectionId }">
        <span class="album-tree-dim pl-3 text-[11px] tracking-[0.06em] text-[var(--anime-text-muted)]">
          {{ sectionLabel(sectionId) }}
        </span>
      </template>
      <template #row="{ element }">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <el-icon class="flex-none text-[14px]" :class="iconClass(element)">
            <component :is="iconOf(element)" />
          </el-icon>
          <span class="min-w-0 truncate" :title="element.labelPath ?? undefined">{{ displayName(element) }}</span>
          <span class="flex-1" />
          <el-icon
            v-if="showStatus && isRotatingAlbum(element)"
            class="flex-none text-[12px] text-[var(--anime-primary)]"
            :title="t('albums.treeRotationTooltip')"
          >
            <Monitor />
          </el-icon>
          <el-tooltip
            v-if="showStatus && syncModeIcon(element.syncMode)"
            :content="syncModeTooltip(element.syncMode)"
            placement="top"
          >
            <el-icon class="flex-none text-[12px]" :class="syncModeIconClass(element.syncMode)">
              <component :is="syncModeIcon(element.syncMode)!" />
            </el-icon>
          </el-tooltip>
          <el-tooltip
            v-if="showStatus && folderStatusBad(element)"
            :content="
              t('albums.treeFolderStatusTooltip', {
                state: element.folderStatus?.state ?? '',
              })
            "
            placement="top"
          >
            <span class="album-tree-status-dot flex-none" />
          </el-tooltip>
          <span class="album-tree-dim flex-none text-[11px] text-[var(--anime-text-muted)]">{{ element.count }}</span>
        </div>
      </template>
    </KbTreePanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Delete, Folder, Monitor, Picture, PriceTag, StarFilled } from "@kabegame/element-plus-icons";
import { useSettingsStore } from "@/stores/settings";
import { syncModeIcon, syncModeIconClass, syncModeTooltip } from "@/utils/albumSyncMode";
import KbTreePanel from "@/components/tree/KbTreePanel.vue";
import type { TreeDataSource, TreeDndController, TreeRowState, TreeSection } from "@/components/tree/types";
import { useTreeModel } from "@/components/tree/useTreeModel";
import { GRID_REFRESH_WAIT_MS } from "@/services/liveQuery";
import { affectsAlbumDir, subscribeChanges } from "@/services/dataChangeHub";
import {
  ALBUM_PAGE_SIZE,
  FAVORITE_ALBUM_ID,
  HIDDEN_ALBUM_ID,
  fetchAlbum,
  fetchAlbumAncestors,
  fetchAlbumCount,
  fetchAlbumPage,
  type Album,
  type AlbumKind,
  type AlbumNode,
  type AlbumRootSection,
} from "@/services/albums";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import type { AlbumTreeViewScope } from "./types";

const props = withDefaults(
  defineProps<{
    selectedId: string | null;
    scope?: AlbumTreeViewScope;
    isSelectable?: (node: AlbumNode) => boolean;
    /** 画册浏览时标签目录只展开；选择器仍可选作标签父目录。 */
    expandLabelDirs?: boolean;
    prependOptions?: { value: string; label: string; desc?: string }[];
    allowCreate?: boolean;
    dnd?: TreeDndController<AlbumNode>;
    searchText: string;
    /** 行尾状态标记（轮播中 / 同步模式 / 文件夹异常）：侧栏才显示，选择器里是噪音 */
    showStatus?: boolean;
  }>(),
  {
    scope: () => ({}),
    prependOptions: () => [],
    allowCreate: false,
    expandLabelDirs: false,
    showStatus: false,
  },
);
const emit = defineEmits<{
  select: [id: string, album: AlbumNode];
  contextmenu: [album: AlbumNode, event: MouseEvent];
  dblclick: [id: string];
  "update:searchText": [value: string];
}>();
const { t } = useI18n();
const route = useGlobalPathRoute();
const prefix = computed(() => (route.hide ? "hide/" : ""));
const allSections: Array<"system" | AlbumRootSection> = ["system", "normal", "label", "local_folder"];
const visibleSections = computed(() => props.scope.sections ?? allSections);

function allowed(node: Album): boolean {
  if (props.scope.excludeIds?.includes(node.id)) return false;
  return !props.scope.excludeSubtreeOf?.some((id) => node.ancestorPath.includes(`/${id}/`));
}
function sectionKinds(section: AlbumRootSection): AlbumKind[] | undefined {
  const implicit: Record<AlbumRootSection, AlbumKind[]> = {
    normal: ["normal"],
    label: ["label", "label_dir"],
    local_folder: ["local_folder"],
  };
  return props.scope.kinds?.length
    ? implicit[section].filter((kind) => props.scope.kinds!.includes(kind))
    : implicit[section];
}
/**
 * 搜索词（防抖后）。非空时树的每一层查询都叠加 `search/<q>` 过滤：自身或子孙命中才保留，树形不变。
 * 必须在 dataSource 之前声明：useTreeModel 创建时就会同步调用 dataSource。
 */
const searchQuery = ref(props.searchText.trim());
async function systemRows(page: number): Promise<AlbumNode[]> {
  if (page !== 1) return [];
  const ids = [FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].filter((id) => !props.scope.excludeIds?.includes(id));
  const query = searchQuery.value.toLowerCase();
  // 系统画册只有两个，搜索时在前端按显示名过滤
  const albums = (await Promise.all(ids.map(fetchAlbum))).filter(
    (album): album is Album => !!album && (!query || displayName(album).toLowerCase().includes(query)),
  );
  return Promise.all(
    albums.map(async (album) => ({
      ...album,
      childCount: 0,
      count: await fetchAlbumCount(album, album.id === HIDDEN_ALBUM_ID ? "" : prefix.value),
    })),
  );
}
function sectionOf(node: Album): AlbumRootSection {
  if (node.type === "local_folder") return "local_folder";
  if (node.type === "label" || node.type === "label_dir") return "label";
  return "normal";
}
function childrenPage(node: AlbumNode, page: number): Promise<AlbumNode[]> {
  return fetchAlbumPage(
    { parentId: node.id },
    page,
    prefix.value,
    sectionKinds(sectionOf(node)),
    ALBUM_PAGE_SIZE,
    searchQuery.value,
  ).then((rows) => rows.filter(allowed));
}
const dataSource: TreeDataSource<AlbumNode> = {
  getKey: (node) => node.id,
  hasChildren: (node) => node.childCount > 0,
  // 页大小经分页段 x<页大小>x/<页码> 传给 albums:// 查询；当前固定默认值，
  // 将来要让用户可选，只需把这里的 ALBUM_PAGE_SIZE 换成可配值。
  getChildren: (node) => childrenPage(node, 1),
  getChildrenPage: childrenPage,
  totalChildren: (node) => node.childCount,
  getRootsPage: (sectionId, page) => {
    if (sectionId === "system") return systemRows(page);
    const section = sectionId as AlbumRootSection;
    const kinds = sectionKinds(section);
    if (kinds?.length === 0) return Promise.resolve([]);
    return fetchAlbumPage({ section }, page, prefix.value, kinds, ALBUM_PAGE_SIZE, searchQuery.value).then((rows) =>
      rows.filter(allowed),
    );
  },
  pageSize: ALBUM_PAGE_SIZE,
};
const sections = computed<TreeSection<AlbumNode>[]>(() =>
  visibleSections.value.map((id, index) => ({
    id,
    header: id === "label" || id === "local_folder",
    separatorBefore: index > 0,
    roots: () => [],
  })),
);
const selectedPath = ref("");
const selectedAncestors = computed(() => new Set(selectedPath.value.split("/").filter(Boolean)));
const model = useTreeModel<AlbumNode>({
  dataSource,
  sections: () => sections.value,
  defaultExpanded: (node) => selectedAncestors.value.has(node.id),
  isRowHidden: (node) => !allowed(node),
});

/** 按选中画册的祖先链逐级展开（必要时逐页加载更多）；不重载整树，切换选中只付祖先链的代价。 */
async function ensureSelectedExpanded() {
  const selected = props.selectedId ? await fetchAlbum(props.selectedId) : null;
  selectedPath.value = selected?.ancestorPath ?? "";
  // 搜索中选中项可能被过滤掉，逐页找它只会白发请求；清空搜索时再展开
  if (!selected || searchQuery.value) return;
  await ensureAlbumExpanded(selected);
}
async function ensureAlbumExpanded(selected: Album) {
  const rootSection =
    selected.id === FAVORITE_ALBUM_ID || selected.id === HIDDEN_ALBUM_ID ? "system" : sectionOf(selected);
  const ids =
    rootSection === "system"
      ? [selected.id]
      : [...(await fetchAlbumAncestors(selected.id)), selected]
          .filter((album) => sectionOf(album) === rootSection)
          .map((album) => album.id);
  for (const [index, id] of ids.entries()) {
    let attempts = 0;
    while (!model.nodeByKey(id) && attempts++ < 200)
      await model.loadMore(index === 0 ? { sectionId: rootSection } : ids[index - 1]);
    const handle = model.nodeByKey(id);
    if (handle?.hasChildren && !handle.expanded) await model.expand(id);
  }
}
/** 计数口径（hide 前缀）或裁剪规则变化：整树重载后再展开选中链。 */
async function reloadAndExpand() {
  await model.reload();
  await ensureSelectedExpanded();
}
watch(
  () => props.selectedId,
  () => void ensureSelectedExpanded(),
  { immediate: true },
);
watch(prefix, () => void reloadAndExpand());
watch(
  () => props.scope,
  () => void reloadAndExpand(),
  { deep: true },
);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.searchText,
  (text) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (searchQuery.value = text.trim()), 300);
  },
);
// 按 key diff 重载：仍在的节点保留句柄与展开态，被过滤掉的节点清空搜索后按 key 恢复用户的展开态
watch(searchQuery, () => void reloadAndExpand());
function selectable(node: AlbumNode) {
  return props.isSelectable?.(node) ?? true;
}
function expandOnly(node: AlbumNode) {
  return props.expandLabelDirs && node.type === "label_dir";
}
function select(node: AlbumNode) {
  if (!selectable(node)) return;
  emit("select", node.id, node);
}
function rowState(node: AlbumNode): TreeRowState {
  return {
    active: node.id === props.selectedId,
    disabled: !selectable(node),
    clickable: selectable(node) && !expandOnly(node),
    muted: node.id === HIDDEN_ALBUM_ID,
  };
}
function iconOf(node: Album) {
  if (node.id === FAVORITE_ALBUM_ID) return StarFilled;
  if (node.id === HIDDEN_ALBUM_ID) return Delete;
  if (node.type === "local_folder" || node.type === "label_dir") return Folder;
  if (node.type === "label") return PriceTag;
  return Picture;
}
function iconClass(node: Album) {
  if (node.type === "local_folder") return "text-[#7c3aed]";
  if (node.type === "label_dir") return "text-[#0891b2]";
  if (node.type === "label") return "text-[#0d9488]";
  if (node.id === FAVORITE_ALBUM_ID) return "text-[#e11d48]";
  return "album-tree-dim text-[var(--anime-text-muted)]";
}
function displayName(node: Album) {
  return node.id === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : node.name;
}
const settings = useSettingsStore();
function isRotatingAlbum(node: Album) {
  return !!settings.values.wallpaperRotationEnabled && settings.values.wallpaperRotationAlbumId === node.id;
}
function folderStatusBad(node: Album) {
  return !!node.folderStatus && node.folderStatus.state !== "ok";
}
function sectionLabel(id: string) {
  return id === "label"
    ? t("albums.treeSectionLabels")
    : id === "local_folder"
      ? t("albums.treeSectionLocalFolders")
      : "";
}

const unsubscribe = subscribeChanges({
  waitMs: GRID_REFRESH_WAIT_MS,
  onBatch: async (batch) => {
    if (affectsAlbumDir(batch, null)) await model.reloadRoots();
    await Promise.all(
      model
        .loadedHandles()
        .filter((handle) => affectsAlbumDir(batch, handle.element.ancestorPath))
        .map((handle) => model.refreshChildren(handle.key)),
    );
  },
});
onBeforeUnmount(() => {
  unsubscribe();
  if (searchTimer) clearTimeout(searchTimer);
});
defineExpose({
  reload: model.reload,
  ensureSelectedExpanded,
  nodeByKey: model.nodeByKey,
});
</script>
