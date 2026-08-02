<template>
  <div class="rounded-xl border border-[var(--anime-border)] bg-[color-mix(in_srgb,var(--anime-bg-card)_94%,var(--kb-el-bg-color))] p-3">
    <div v-if="compact" class="mb-2 text-xs font-medium text-[var(--anime-text-secondary)]">
      {{ title }}
    </div>
    <div class="flex items-start gap-2">
      <button
        type="button"
        class="h-9 flex-none rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-3 text-sm text-[var(--anime-text-secondary)] transition-colors cursor-pointer"
        :class="{
          '!border-solid !border-[var(--anime-primary)] !bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] !text-[var(--anime-primary)]': negated,
        }"
        :aria-pressed="negated"
        @click="toggleNegation"
      >
        {{ t("gallery.advancedNot") }}
      </button>

      <div class="min-w-0 flex flex-1 flex-wrap items-center gap-2">
        <KbFilterDropdown
          :model-value="atom.search?.query || null"
          :options="[]"
          :chip-label="t('gallery.advancedChipSearch')"
          :any-label="t('gallery.filterAny')"
          :empty-text="t('common.noData')"
          :negated="negated"
          @update:model-value="updateSearchQuery"
        >
          <template #trigger="{ open }">
            <span
              class="inline-flex h-9 max-w-[280px] items-center gap-1.5 rounded-lg border border-[var(--anime-border)] bg-[var(--anime-bg-card)] px-3 text-sm text-[var(--anime-text-secondary)] cursor-pointer"
              :class="{
                '!border-[var(--anime-primary)] !text-[var(--anime-primary)]': !!atom.search?.query,
                'ring-2 ring-[color-mix(in_srgb,var(--anime-primary)_18%,transparent)]': open,
              }"
            >
              <el-icon><Search /></el-icon>
              <span>{{ t("gallery.advancedChipSearch") }}</span>
              <span
                v-if="atom.search?.query"
                class="rounded-md bg-[color-mix(in_srgb,var(--anime-secondary)_14%,transparent)] px-1.5 py-0.5 text-xs"
              >
                {{ searchModeLabel(atom.search.mode) }}
              </span>
              <span class="min-w-0 max-w-28 truncate text-[var(--anime-text-primary)]">
                {{ atom.search?.query || t("gallery.filterAny") }}
              </span>
              <button
                v-if="atom.search?.query"
                type="button"
                class="ml-0.5 inline-flex border-0 bg-transparent p-0 text-inherit cursor-pointer"
                :aria-label="t('gallery.filterAny')"
                @click.stop="updateSearchQuery(null)"
              >
                <el-icon><Close /></el-icon>
              </button>
            </span>
          </template>
          <template #panel="{ close }">
            <div class="w-[360px] max-w-[calc(100vw-48px)] p-3">
              <KbTab v-model="searchMode" :items="searchModeItems" class="w-full" />
              <el-input
                :model-value="atom.search?.query || ''"
                class="mt-3"
                clearable
                :placeholder="searchPlaceholder"
                @update:model-value="updateSearchQuery"
                @keyup.enter="close"
              />
              <p class="mb-0 mt-3 text-xs leading-5 text-[var(--anime-text-secondary)]">
                {{ t("gallery.advancedSearchHelp") }}
              </p>
            </div>
          </template>
        </KbFilterDropdown>

        <KbFilterDropdown
          v-for="item in facetItems"
          :key="item.dimension"
          :model-value="dimensionValue(item.dimension)"
          :chip-label="item.label"
          :selected-label="dimensionValueLabel(item.dimension)"
          :any-label="t('gallery.filterAny')"
          :negated="negated"
          @open="openFacetPanel(item.dimension)"
          @before-hide="closeFacetPanel(item.dimension)"
          @update:model-value="(value) => clearDimensionFromDropdown(item.dimension, value)"
        >
          <template #icon>
            <component :is="item.icon" />
          </template>
          <!-- TODO:树面板暂不支持文本过滤。 -->
          <template #panel="{ close }">
            <AdvancedFacetTreePanel
              :tree="tree"
              :node-path="nodePath"
              :dimension="item.dimension"
              :context-prefix="contextPrefix"
              :visible="openedFacet === item.dimension"
              @select="(filter) => selectDimensionFilter(item.dimension, filter, close)"
            />
          </template>
        </KbFilterDropdown>

        <KbFilterDropdown
          :model-value="atom.wallpaperOrder ? 'selected' : null"
          :options="wallpaperOptions"
          :chip-label="t('gallery.advancedChipWallpaper')"
          :any-label="t('gallery.filterAny')"
          :empty-text="t('common.noData')"
          :negated="negated"
          @update:model-value="updateWallpaper"
        >
          <template #icon><FilterWallpaper /></template>
        </KbFilterDropdown>
      </div>

      <button
        type="button"
        class="mt-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border-0 bg-transparent text-[var(--anime-text-secondary)] hover:bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] hover:text-[var(--anime-primary)] cursor-pointer"
        :aria-label="t('common.delete')"
        @click="removeCondition"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, ref, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  ElIcon,
  ElInput,
  KbFilterDropdown,
  KbTab,
  type KbFilterDropdownOption,
  type KbTabItem,
} from "@kabegame/element-plus";
import {
  Close,
  FilterAspect,
  FilterDate,
  FilterMedia,
  FilterName,
  FilterPlugin,
  FilterSize,
  FilterWallpaper,
  Search,
} from "@kabegame/element-plus-icons";
import {
  facetValueLabel,
  type FacetDimension,
} from "@/composables/useAdvancedQueryFacets";
import { usePluginStore } from "@/stores/plugins";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import {
  getNode,
  notParity,
  removeNode,
  updateNode,
  type GalleryAdvancedQuery,
  type GalleryAtom,
  type GalleryQueryNode,
  type NodePath,
} from "@/utils/galleryQuery";
import {
  DEFAULT_GALLERY_SEARCH_MODE,
  GALLERY_SEARCH_MODES,
  type GalleryFilter,
  type GallerySearchMode,
} from "@/utils/galleryPath";
import AdvancedFacetTreePanel from "./AdvancedFacetTreePanel.vue";

const props = defineProps<{
  tree: GalleryAdvancedQuery;
  nodePath: NodePath;
  contextPrefix?: string;
  negationWrapperPath?: NodePath;
  compact?: boolean;
  title?: string;
}>();

const emit = defineEmits<{
  "update:tree": [tree: GalleryAdvancedQuery];
}>();

const { t } = useI18n();
const pluginStore = usePluginStore();
const openedFacet = ref<FacetDimension | null>(null);
const atom = computed<GalleryAtom>(() => {
  const node = getNode(props.tree, props.nodePath);
  return "is" in node ? node.is : {};
});
const negated = computed(() => notParity(props.tree, props.nodePath));

const facetItems = computed<Array<{
  dimension: FacetDimension;
  label: string;
  icon: Component;
}>>(() => [
  { dimension: "date", label: t("gallery.advancedChipTime"), icon: markRaw(FilterDate) },
  { dimension: "plugin", label: t("gallery.advancedChipPlugin"), icon: markRaw(FilterPlugin) },
  { dimension: "mediaType", label: t("gallery.advancedChipMediaType"), icon: markRaw(FilterMedia) },
  { dimension: "aspect", label: t("gallery.advancedChipAspect"), icon: markRaw(FilterAspect) },
  { dimension: "size", label: t("gallery.advancedChipSize"), icon: markRaw(FilterSize) },
  { dimension: "name", label: t("gallery.advancedChipName"), icon: markRaw(FilterName) },
]);

const wallpaperOptions = computed<KbFilterDropdownOption[]>(() => [{
  label: t("gallery.filterWallpaperSet"),
  value: "selected",
}]);

const searchMode = computed<GallerySearchMode>({
  get: () => atom.value.search?.mode ?? DEFAULT_GALLERY_SEARCH_MODE,
  set: (mode) => updateSearch(atom.value.search?.query ?? "", mode, true),
});

const searchModeItems = computed<KbTabItem<GallerySearchMode>[]>(() =>
  GALLERY_SEARCH_MODES.map((mode) => ({ name: mode, label: searchModeLabel(mode) }))
);

const searchPlaceholder = computed(() => {
  if (searchMode.value === "metadata") return t("gallery.searchPlaceholderMetadata");
  if (searchMode.value === "native-metadata") return t("gallery.searchPlaceholderNativeMetadata");
  return t("gallery.searchPlaceholder");
});

function searchModeLabel(mode: GallerySearchMode): string {
  if (mode === "metadata") return t("gallery.searchModeMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeNativeMetadata");
  return t("gallery.searchModeDisplayName");
}

function updateAtom(updater: (atom: GalleryAtom) => GalleryAtom): void {
  emit("update:tree", updateNode(props.tree, props.nodePath, (node) => {
    if (!("is" in node)) return node;
    return { is: updater(node.is) };
  }));
}

function updateSearch(
  query: string,
  mode = searchMode.value,
  preserveEmpty = false,
): void {
  updateAtom((current) => {
    const next = { ...current };
    const trimmed = query.trim();
    if (trimmed || preserveEmpty) next.search = { mode, query };
    else delete next.search;
    return next;
  });
}

function updateSearchQuery(value: string | null): void {
  updateSearch(value ?? "");
}

function dimensionValue(dimension: FacetDimension): string | null {
  const current = atom.value;
  if (dimension === "date") return current.date?.segment ?? null;
  if (dimension === "plugin") return current.plugin?.pluginId ?? null;
  if (dimension === "mediaType") return current.mediaType?.kind ?? null;
  if (dimension === "aspect") return current.aspect?.range ?? null;
  if (dimension === "size") return current.size?.range ?? null;
  return current.name?.bucket ?? null;
}

/** chip 选中值的本地化文案：树面板未打开时也不能依赖节点数据反查。 */
function dimensionValueLabel(dimension: FacetDimension): string | undefined {
  const value = dimensionValue(dimension);
  if (!value) return undefined;
  if (dimension === "plugin") {
    return pluginStore.pluginLabel(value) || value;
  }
  return facetValueLabel(dimension, value, t);
}

function openFacetPanel(dimension: FacetDimension): void {
  openedFacet.value = dimension;
}

function closeFacetPanel(dimension: FacetDimension): void {
  if (openedFacet.value === dimension) openedFacet.value = null;
}

function clearDimensionFromDropdown(
  dimension: FacetDimension,
  value: string | null,
): void {
  if (value === null) updateDimensionFilter(dimension, null);
}

function selectDimensionFilter(
  dimension: FacetDimension,
  filter: GalleryFilter,
  close: () => void,
): void {
  let nextFilter = filter;
  if (
    filter.type === "plugin" &&
    filter.extendPath?.trim() &&
    (props.nodePath.length > 1 || negated.value)
  ) {
    ElMessage.warning(t("gallery.advancedPluginExtendRestricted"));
    nextFilter = { type: "plugin", pluginId: filter.pluginId };
  }
  updateDimensionFilter(dimension, nextFilter);
  openedFacet.value = null;
  close();
}

function updateDimensionFilter(
  dimension: FacetDimension,
  filter: GalleryFilter | null,
): void {
  updateAtom((current) => {
    const next: GalleryAtom = { ...current };
    delete next[dimension];
    if (!filter || filter.type === "all") return next;

    if (dimension === "date" && filter.type === "date") {
      next.date = { segment: filter.segment };
    } else if (dimension === "plugin" && filter.type === "plugin") {
      next.plugin = {
        pluginId: filter.pluginId,
        ...(filter.extendPath ? { extendPath: filter.extendPath } : {}),
      };
    } else if (dimension === "mediaType" && filter.type === "media-type") {
      next.mediaType = {
        kind: filter.kind,
        ...(filter.format ? { format: filter.format } : {}),
      };
    } else if (dimension === "aspect" && filter.type === "aspect") {
      next.aspect = { range: filter.range };
    } else if (dimension === "size" && filter.type === "size") {
      next.size = { range: filter.range };
    } else if (dimension === "name" && filter.type === "name") {
      next.name = { bucket: filter.bucket };
    }
    return next;
  });
}

function updateWallpaper(value: string | null): void {
  updateAtom((current) => ({ ...current, wallpaperOrder: value === "selected" || undefined }));
}

function toggleNegation(): void {
  if (props.negationWrapperPath) {
    const next = updateNode(props.tree, props.negationWrapperPath, (node) => {
      if (!("not" in node) || node.not.length !== 1) return node;
      return node.not[0] as GalleryQueryNode;
    });
    emit("update:tree", next);
    return;
  }
  emit("update:tree", updateNode(props.tree, props.nodePath, (node) => ({ not: [node] })));
}

function removeCondition(): void {
  emit("update:tree", removeNode(props.tree, props.negationWrapperPath ?? props.nodePath));
}
</script>
