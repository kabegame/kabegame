<template>
  <aside class="gallery-provider-sidebar" :class="[`is-${mode}`, { 'is-collapsed': collapsed }]">
    <div v-if="mode === 'sidebar'" class="provider-sidebar-header">
      <button class="sidebar-toggle" type="button" @click="collapsed = !collapsed">
        <el-icon>
          <ArrowRight />
        </el-icon>
      </button>
      <span v-if="!collapsed" class="sidebar-title">{{ t("gallery.filterByPlugin") }}</span>
    </div>

    <div v-if="mode === 'popover' || !collapsed" class="provider-tree">
      <div v-if="!visibleRows.length" class="provider-tree-state">
        {{ t("gallery.filterByPluginEmpty") }}
      </div>
      <div
        v-for="row in visibleRows"
        v-else
        :key="row.key"
        class="provider-tree-row"
        :class="{ 'is-active': isActive(row), 'is-loading': row.kind === 'loading' }"
        :style="{ '--tree-depth': row.depth }"
      >
        <template v-if="row.kind === 'loading'">
          <span class="tree-toggle-spacer" />
          <span class="tree-label">{{ t("common.loading") }}</span>
        </template>
        <template v-else>
          <button
            class="tree-toggle"
            :class="{ 'is-expanded': expandedKeys.has(row.key) }"
            :disabled="!canExpand(row)"
            type="button"
            @click.stop="toggleRow(row)"
          >
            <el-icon v-if="canExpand(row)">
              <ArrowRight />
            </el-icon>
          </button>
          <button class="tree-select" type="button" @click="selectRow(row)">
            <span class="tree-label">{{ row.label }}</span>
            <span v-if="row.count != null" class="tree-count">({{ row.count }})</span>
          </button>
        </template>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { usePluginStore } from "@/stores/plugins";
import { filterDateSegment, filterMediaKind, type GalleryFilter } from "@/utils/galleryPath";

interface ProviderChildDir {
  kind: "dir";
  name: string;
  meta?: {
    isLeaf?: boolean;
  } | null;
  total?: number | null;
}

interface ProviderCountResult {
  total?: number | null;
}

interface TreeRow {
  kind: "root" | "date" | "media-type" | "plugin" | "extend" | "loading";
  key: string;
  pluginId?: string;
  extendPath?: string;
  filter?: GalleryFilter;
  label?: string;
  depth: number;
  count?: number | null;
  isLeaf?: boolean;
}

const props = withDefaults(defineProps<{
  contextPrefix?: string;
  filter: GalleryFilter;
  mode?: "sidebar" | "popover";
}>(), {
  contextPrefix: "",
  mode: "sidebar",
});

const emit = defineEmits<{
  "update:filter": [filter: GalleryFilter];
}>();

const { t } = useI18n();
const pluginStore = usePluginStore();
const collapsed = ref(props.mode === "sidebar" ? false : false);
const loadingGroups = ref(false);
const pluginGroups = ref<Array<{ pluginId: string; count: number }>>([]);
const childrenByKey = ref<Record<string, ProviderChildDir[]>>({});
const countsByKey = ref<Record<string, number | null>>({});
const loadedKeys = ref(new Set<string>());
const loadingKeys = ref(new Set<string>());
const expandedKeys = ref(new Set<string>());
let loadToken = 0;

const visibleRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = [
    {
      kind: "root",
      key: "all",
      filter: { type: "all" },
      label: t("gallery.filterAll"),
      depth: 0,
      count: countsByKey.value.all ?? null,
      isLeaf: true,
    },
    {
      kind: "root",
      key: "wallpaper-order",
      filter: { type: "wallpaper-order" },
      label: t("gallery.filterWallpaperSet"),
      depth: 0,
      count: countsByKey.value["wallpaper-order"] ?? null,
      isLeaf: true,
    },
  ];
  rows.push({
    kind: "root",
    key: "date",
    label: t("gallery.filterByTime"),
    depth: 0,
    count: countsByKey.value.date ?? null,
  });
  appendRootLoading(rows, "date", 1);
  appendProviderChildren(rows, "date", 1);
  rows.push({
    kind: "root",
    key: "media-type",
    label: t("gallery.filterByMediaType"),
    depth: 0,
    count: countsByKey.value["media-type"] ?? null,
  });
  appendRootLoading(rows, "media-type", 1);
  appendProviderChildren(rows, "media-type", 1);
  rows.push({
    kind: "root",
    key: "plugin-root",
    label: t("gallery.filterByPlugin"),
    depth: 0,
    count: countsByKey.value["plugin-root"] ?? null,
  });
  if (expandedKeys.value.has("plugin-root") && loadingGroups.value && pluginGroups.value.length === 0) {
    rows.push({ kind: "loading", key: "plugin-root:loading", depth: 1 });
  }
  for (const group of pluginGroups.value) {
    const key = nodeKey(group.pluginId);
    if (expandedKeys.value.has("plugin-root")) {
      rows.push({
        kind: "plugin",
        key,
        pluginId: group.pluginId,
        extendPath: "",
        filter: { type: "plugin", pluginId: group.pluginId },
        label: pluginStore.pluginLabel(group.pluginId),
        depth: 1,
        count: group.count,
      });
      appendPluginChildren(rows, group.pluginId, "", 2);
    }
  }
  return rows;
});

function appendRootLoading(rows: TreeRow[], key: string, depth: number) {
  if (!expandedKeys.value.has(key)) return;
  if (!loadingGroups.value || loadedKeys.value.has(key)) return;
  rows.push({ kind: "loading", key: `${key}:loading`, depth });
}

function appendProviderChildren(rows: TreeRow[], parentKey: string, depth: number) {
  if (!expandedKeys.value.has(parentKey)) return;
  if (loadingKeys.value.has(parentKey)) {
    rows.push({ kind: "loading", key: `${parentKey}:loading`, depth });
    return;
  }
  for (const child of childrenByKey.value[parentKey] ?? []) {
    const key = `${parentKey}/${child.name}`;
    const filter = filterForProviderKey(key);
    rows.push({
      kind: key.startsWith("date/") ? "date" : "media-type",
      key,
      filter: filter ?? undefined,
      label: labelForProviderChild(parentKey, child.name),
      depth,
      count: countsByKey.value[key] ?? null,
      isLeaf: isProviderLeaf(child),
    });
    appendProviderChildren(rows, key, depth + 1);
  }
}

function appendPluginChildren(rows: TreeRow[], pluginId: string, parentPath: string, depth: number) {
  const parentKey = nodeKey(pluginId, parentPath);
  if (!expandedKeys.value.has(parentKey)) return;
  if (loadingKeys.value.has(parentKey)) {
    rows.push({ kind: "loading", key: `${parentKey}:loading`, depth });
    return;
  }
  for (const child of childrenByKey.value[parentKey] ?? []) {
    const path = [normalizePath(parentPath), child.name].filter(Boolean).join("/");
    const key = nodeKey(pluginId, path);
    rows.push({
      kind: "extend",
      key,
      pluginId,
      extendPath: path,
      filter: { type: "plugin", pluginId, extendPath: path },
      label: child.name,
      depth,
      count: countsByKey.value[key] ?? null,
      isLeaf: isProviderLeaf(child),
    });
    appendPluginChildren(rows, pluginId, path, depth + 1);
  }
}

function replaceSet(target: typeof loadedKeys, op: (next: Set<string>) => void) {
  const next = new Set(target.value);
  op(next);
  target.value = next;
}

function normalizePath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function nodeKey(pluginId: string, extendPath = "") {
  const path = normalizePath(extendPath);
  return path ? `${pluginId}\t${path}` : pluginId;
}

function providerPathSegment(path = "") {
  return normalizePath(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function withContextPrefix(contextPrefix: string, path: string) {
  const prefix = normalizePath(contextPrefix);
  return [prefix, normalizePath(path)].filter(Boolean).join("/");
}

function pluginRootProviderPath(pluginId: string, contextPrefix = props.contextPrefix ?? "") {
  return withContextPrefix(contextPrefix, `plugin/${encodeURIComponent(pluginId)}`);
}

function pluginExtendProviderPath(
  pluginId: string,
  extendPath = "",
  contextPrefix = props.contextPrefix ?? ""
) {
  const childPath = providerPathSegment(extendPath);
  return withContextPrefix(contextPrefix, `plugin/${encodeURIComponent(pluginId)}/extend/${childPath}`);
}

function hasListedChildren(key: string) {
  return (childrenByKey.value[key] ?? []).length > 0;
}

function isProviderLeaf(entry: ProviderChildDir) {
  return entry.meta?.isLeaf === true;
}

function canExpand(row: TreeRow) {
  if (row.kind === "loading") return false;
  if (row.isLeaf) return false;
  if (row.key === "plugin-root") return loadingGroups.value || pluginGroups.value.length > 0;
  if (row.kind === "date" || row.kind === "media-type" || row.kind === "root") {
    return !loadedKeys.value.has(row.key) || hasListedChildren(row.key);
  }
  if (!row.pluginId) return false;
  return !loadedKeys.value.has(row.key) || hasListedChildren(row.key);
}

async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await invoke<ProviderChildDir[]>("list_provider_children", { path });
  return (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is ProviderChildDir =>
      !!entry && entry.kind === "dir" && typeof entry.name === "string" && !!entry.name
  );
}

async function countProviderPath(path: string): Promise<number> {
  const res = await invoke<ProviderCountResult>("browse_gallery_provider", {
    path: path.trim().replace(/\/+$/, ""),
  });
  return typeof res?.total === "number" ? res.total : 0;
}

async function loadGroups() {
  const token = ++loadToken;
  const contextPrefix = props.contextPrefix ?? "";
  loadingGroups.value = true;
  try {
    const [allCount, wallpaperCount, dateEntries, mediaEntries, pluginEntries] = await Promise.all([
      countProviderPath(withContextPrefix(contextPrefix, "all")),
      countProviderPath(withContextPrefix(contextPrefix, "wallpaper-order")),
      listProviderDirs(withContextPrefix(contextPrefix, "date/")),
      listProviderDirs(withContextPrefix(contextPrefix, "media-type/")),
      listProviderDirs(withContextPrefix(contextPrefix, "plugin/")),
    ]);
    const groups = await Promise.all(
      pluginEntries.map(async (entry) => ({
        pluginId: entry.name,
        count: typeof entry.total === "number"
          ? entry.total
          : await countProviderPath(pluginRootProviderPath(entry.name, contextPrefix)),
      }))
    );
    if (token !== loadToken || contextPrefix !== (props.contextPrefix ?? "")) return;
    pluginGroups.value = groups.filter((group) => group.count > 0);
    countsByKey.value = {
      ...countsByKey.value,
      all: allCount,
      "wallpaper-order": wallpaperCount,
      date: allCount,
      "media-type": allCount,
      "plugin-root": allCount,
      ...Object.fromEntries(dateEntries.map((entry) => [`date/${entry.name}`, entry.total ?? null])),
      ...Object.fromEntries(mediaEntries.map((entry) => [`media-type/${entry.name}`, entry.total ?? null])),
      ...Object.fromEntries(groups.map((group) => [nodeKey(group.pluginId), group.count])),
    };
    childrenByKey.value = {
      ...childrenByKey.value,
      date: dateEntries,
      "media-type": mediaEntries,
    };
    replaceSet(loadedKeys, (next) => {
      next.add("date");
      next.add("media-type");
      next.add("plugin-root");
    });
  } catch {
    if (token === loadToken) pluginGroups.value = [];
  } finally {
    if (token === loadToken) loadingGroups.value = false;
  }
}

async function loadProviderChildren(key: string) {
  if (loadedKeys.value.has(key) || loadingKeys.value.has(key)) return;
  const contextPrefix = props.contextPrefix ?? "";
  replaceSet(loadingKeys, (next) => next.add(key));
  try {
    const entries = await listProviderDirs(withContextPrefix(contextPrefix, `${key}/`));
    if (contextPrefix !== (props.contextPrefix ?? "")) return;
    childrenByKey.value = { ...childrenByKey.value, [key]: entries };
    replaceSet(loadedKeys, (next) => next.add(key));
    void loadProviderChildCounts(key, entries, contextPrefix);
  } catch {
    if (contextPrefix === (props.contextPrefix ?? "")) {
      childrenByKey.value = { ...childrenByKey.value, [key]: [] };
      replaceSet(loadedKeys, (next) => next.add(key));
    }
  } finally {
    replaceSet(loadingKeys, (next) => next.delete(key));
  }
}

async function loadChildren(pluginId: string, extendPath = "") {
  const key = nodeKey(pluginId, extendPath);
  if (loadedKeys.value.has(key) || loadingKeys.value.has(key)) return;
  const contextPrefix = props.contextPrefix ?? "";
  replaceSet(loadingKeys, (next) => next.add(key));
  try {
    const entries = await listProviderDirs(pluginExtendProviderPath(pluginId, extendPath, contextPrefix));
    if (contextPrefix !== (props.contextPrefix ?? "")) return;
    childrenByKey.value = { ...childrenByKey.value, [key]: entries };
    replaceSet(loadedKeys, (next) => next.add(key));
    void loadChildCounts(pluginId, extendPath, entries, contextPrefix);
  } catch {
    if (contextPrefix === (props.contextPrefix ?? "")) {
      childrenByKey.value = { ...childrenByKey.value, [key]: [] };
      replaceSet(loadedKeys, (next) => next.add(key));
    }
  } finally {
    replaceSet(loadingKeys, (next) => next.delete(key));
  }
}

async function loadProviderChildCounts(parentKey: string, entries: ProviderChildDir[], contextPrefix: string) {
  const childCounts = await Promise.all(
    entries.map(async (entry) => {
      const childKey = `${parentKey}/${entry.name}`;
      try {
        return [
          childKey,
          typeof entry.total === "number"
            ? entry.total
            : await countProviderPath(withContextPrefix(contextPrefix, childKey)),
        ] as const;
      } catch {
        return [childKey, null] as const;
      }
    })
  );
  if (contextPrefix !== (props.contextPrefix ?? "")) return;
  countsByKey.value = { ...countsByKey.value, ...Object.fromEntries(childCounts) };
}

async function loadChildCounts(
  pluginId: string,
  extendPath: string,
  entries: ProviderChildDir[],
  contextPrefix: string
) {
  const childCounts = await Promise.all(
    entries.map(async (entry) => {
      const childExtendPath = [normalizePath(extendPath), entry.name].filter(Boolean).join("/");
      const childKey = nodeKey(pluginId, childExtendPath);
      try {
        return [
          childKey,
          typeof entry.total === "number"
            ? entry.total
            : await countProviderPath(pluginExtendProviderPath(pluginId, childExtendPath, contextPrefix)),
        ] as const;
      } catch {
        return [childKey, null] as const;
      }
    })
  );
  if (contextPrefix !== (props.contextPrefix ?? "")) return;
  countsByKey.value = { ...countsByKey.value, ...Object.fromEntries(childCounts) };
}

async function toggleRow(row: TreeRow) {
  if (!canExpand(row)) return;
  if (row.key === "plugin-root") {
    if (expandedKeys.value.has(row.key)) {
      replaceSet(expandedKeys, (next) => next.delete(row.key));
    } else {
      replaceSet(expandedKeys, (next) => next.add(row.key));
    }
    return;
  }
  if (row.kind === "root" || row.kind === "date" || row.kind === "media-type") {
    if (!loadedKeys.value.has(row.key)) {
      await loadProviderChildren(row.key);
    }
    if (expandedKeys.value.has(row.key)) {
      replaceSet(expandedKeys, (next) => next.delete(row.key));
      return;
    }
    replaceSet(expandedKeys, (next) => next.add(row.key));
    await loadProviderChildren(row.key);
    return;
  }
  if (!loadedKeys.value.has(row.key)) {
    await loadChildren(row.pluginId!, row.extendPath ?? "");
  }
  if (expandedKeys.value.has(row.key)) {
    replaceSet(expandedKeys, (next) => next.delete(row.key));
    return;
  }
  replaceSet(expandedKeys, (next) => next.add(row.key));
  await loadChildren(row.pluginId!, row.extendPath ?? "");
}

function selectRow(row: TreeRow) {
  if (row.kind === "loading") return;
  if (row.filter) {
    emit("update:filter", row.filter);
    return;
  }
  if (!row.pluginId) return;
  const extendPath = normalizePath(row.extendPath ?? "");
  emit("update:filter", extendPath
    ? { type: "plugin", pluginId: row.pluginId, extendPath }
    : { type: "plugin", pluginId: row.pluginId });
}

function isActive(row: TreeRow) {
  if (row.kind === "loading") return false;
  if (row.filter) {
    return isSameFilter(row.filter, props.filter);
  }
  if (!row.pluginId || props.filter.type !== "plugin") return false;
  return (
    props.filter.pluginId === row.pluginId &&
    normalizePath(props.filter.extendPath ?? "") === normalizePath(row.extendPath ?? "")
  );
}

function labelForProviderChild(parentKey: string, name: string) {
  if (parentKey === "media-type") {
    if (name === "image") return t("gallery.filterImageOnly");
    if (name === "video") return t("gallery.filterVideoOnly");
  }
  const year = /^(\d{4})y$/.exec(name)?.[1];
  if (year) return year;
  const month = /^(\d{2})m$/.exec(name)?.[1];
  if (month) return month;
  const day = /^(\d{2})d$/.exec(name)?.[1];
  if (day) return day;
  return name;
}

function filterForProviderKey(key: string): GalleryFilter | null {
  if (key === "all") return { type: "all" };
  if (key === "wallpaper-order") return { type: "wallpaper-order" };
  if (key.startsWith("media-type/")) {
    const kind = key.split("/")[1];
    if (kind === "image" || kind === "video") return { type: "media-type", kind };
    return null;
  }
  if (key.startsWith("date/")) {
    const parts = key.split("/").slice(1);
    const y = /^(\d{4})y$/.exec(parts[0] ?? "")?.[1];
    if (!y) return null;
    const m = /^(\d{2})m$/.exec(parts[1] ?? "")?.[1];
    const d = /^(\d{2})d$/.exec(parts[2] ?? "")?.[1];
    const segment = d ? `${y}-${m}-${d}` : m ? `${y}-${m}` : y;
    return { type: "date", segment };
  }
  return null;
}

function isSameFilter(a: GalleryFilter, b: GalleryFilter) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "all":
    case "wallpaper-order":
      return true;
    case "date":
      return filterDateSegment(b) === a.segment;
    case "media-type":
      return filterMediaKind(b) === a.kind;
    case "plugin":
      return (
        b.type === "plugin" &&
        b.pluginId === a.pluginId &&
        normalizePath(b.extendPath ?? "") === normalizePath(a.extendPath ?? "")
      );
    case "date-range":
      return b.type === "date-range" && b.start === a.start && b.end === a.end;
  }
}

function reset() {
  pluginGroups.value = [];
  childrenByKey.value = {};
  countsByKey.value = {};
  loadedKeys.value = new Set();
  loadingKeys.value = new Set();
  expandedKeys.value = new Set();
  expandActiveFilter();
}

function expandActiveFilter() {
  const next = new Set(expandedKeys.value);
  if (props.filter.type === "date") {
    const parts = props.filter.segment.split("-");
    if (parts[0]) next.add("date");
    if (parts[0] && parts[1]) next.add(`date/${parts[0]}y`);
    if (parts[0] && parts[1] && parts[2]) next.add(`date/${parts[0]}y/${parts[1]}m`);
  } else if (props.filter.type === "media-type") {
    next.add("media-type");
  } else if (props.filter.type === "plugin") {
    next.add("plugin-root");
    const parentParts = normalizePath(props.filter.extendPath ?? "").split("/").filter(Boolean);
    let parent = "";
    for (const part of parentParts.slice(0, -1)) {
      parent = [parent, part].filter(Boolean).join("/");
      next.add(nodeKey(props.filter.pluginId, parent));
    }
  }
  expandedKeys.value = next;
}

watch(
  () => [props.contextPrefix, pluginStore.plugins.map((p) => `${p.id}:${p.version}`).join("|")] as const,
  () => {
    reset();
    void loadGroups();
  },
  { immediate: true }
);

watch(() => props.filter, expandActiveFilter, { immediate: true });
</script>

<style scoped lang="scss">
.gallery-provider-sidebar {
  flex: 0 0 252px;
  width: 252px;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--anime-border);
  background: var(--anime-bg);
  transition: flex-basis 0.2s ease, width 0.2s ease;

  &.is-collapsed {
    flex-basis: 42px;
    width: 42px;
  }

  &.is-popover {
    width: 320px;
    height: min(60vh, 420px);
    flex: none;
    border-right: 0;
    background: transparent;
  }
}

.provider-sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 8px;
  border-bottom: 1px solid var(--anime-border);
}

.sidebar-toggle {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  color: var(--anime-text-secondary);
  background: transparent;
  cursor: pointer;

  .is-collapsed & {
    transform: rotate(180deg);
  }

  &:hover {
    background: var(--el-fill-color-light);
    color: var(--anime-text-primary);
  }
}

.sidebar-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--anime-text-primary);
}

.provider-tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}

.provider-tree-state {
  padding: 12px 6px;
  color: var(--anime-text-secondary);
  font-size: 13px;
}

.provider-tree-row {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding-left: calc(var(--tree-depth) * 16px);
  border-radius: 6px;
  color: var(--anime-text-primary);

  &:hover {
    background: var(--el-fill-color-light);
  }

  &.is-active {
    background: rgba(255, 107, 157, 0.14);
    color: var(--anime-primary);
  }

  &.is-loading {
    color: var(--anime-text-secondary);
  }
}

.tree-toggle,
.tree-select {
  border: 0;
  background: transparent;
  color: inherit;
}

.tree-toggle {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s ease;

  &.is-expanded {
    transform: rotate(90deg);
  }

  &:disabled {
    cursor: default;
  }
}

.tree-toggle-spacer {
  flex: 0 0 26px;
}

.tree-select {
  min-width: 0;
  flex: 1;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 4px;
  text-align: left;
  cursor: pointer;
}

.tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-count {
  flex: 0 0 auto;
  color: var(--anime-text-secondary);
  font-size: 12px;
}
</style>
