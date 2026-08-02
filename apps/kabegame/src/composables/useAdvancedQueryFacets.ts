import {
  computed,
  type MaybeRefOrGetter,
  onScopeDispose,
  type Ref,
  ref,
  toValue,
  watch,
} from "vue";
import { useI18n } from "@kabegame/i18n";
import type { KbFilterDropdownOption } from "@kabegame/element-plus";
import {
  pathqlEntry,
  pathqlList,
  type ProviderListChild,
} from "@/services/pathql";
import { usePluginStore } from "@/stores/plugins";
import {
  advancedQueryRuntimePath,
  GALLERY_ASPECT_BUCKETS,
  GALLERY_NAME_LANGUAGE_BUCKETS,
} from "@/utils/galleryPath";
import {
  facetListPath,
  type GalleryAdvancedQuery,
  type GalleryAtomDimension,
  type NodePath,
  normalizeQuery,
  notParity,
  serializeAdvancedQuery,
} from "@/utils/galleryQuery";

export type FacetDimension = Exclude<
  GalleryAtomDimension,
  "search" | "wallpaperOrder"
>;

/**
 * 维度选中值 → 本地化展示文案(chip 未打开下拉、options 尚未加载时也要有正确文案)。
 * plugin 由调用侧经 pluginLabel 解析(store 依赖不进本纯函数)。
 */
export function facetValueLabel(
  dimension: FacetDimension,
  value: string,
  t: (key: string) => string,
): string {
  if (dimension === "mediaType") {
    if (value === "image") return t("gallery.filterImageOnlyLabel");
    if (value === "video") return t("gallery.filterVideoOnlyLabel");
    return value;
  }
  if (dimension === "name") {
    const bucket = GALLERY_NAME_LANGUAGE_BUCKETS.find((item) => item.bucket === value);
    return bucket ? t(`gallery.${bucket.labelKey}`) : value;
  }
  if (dimension === "aspect") {
    const bucket = GALLERY_ASPECT_BUCKETS.find((item) => item.range === value);
    return bucket ? t(`gallery.${bucket.labelKey}`) : value;
  }
  if (dimension === "size") {
    const sizeKey = SIZE_LABEL_KEYS[value];
    return sizeKey ? t(`gallery.${sizeKey}`) : value;
  }
  // date 的段值(如 2026 / 2026-08)本身可读;plugin 由调用侧解析。
  return value;
}

export interface UseDimensionFacetOptions {
  /** 为将来需要追加细分 facet 的调用侧保留；当前根 facet 不需要额外参数。 */
  searchable?: boolean;
}

interface FacetCacheEntry {
  entries: ProviderListChild[];
  anyCount: number;
}

const MAX_CACHE_ENTRIES = 128;
const facetCache = new Map<string, FacetCacheEntry>();

const SIZE_LABEL_KEYS: Record<string, string> = {
  unknown: "filterSize_unknown",
  "1B-512KB": "filterSize_lt512k",
  "512KB-1MB": "filterSize_512k_1m",
  "1MB-2MB": "filterSize_1m_2m",
  "2MB-5MB": "filterSize_2m_5m",
  "5MB-10MB": "filterSize_5m_10m",
  "10MB-50MB": "filterSize_10m_50m",
  "50MB-": "filterSize_gte50m",
};

function reducedTreePath(listPath: string, dimension: FacetDimension): string {
  const segments: Record<FacetDimension, string> = {
    plugin: "plugin",
    mediaType: "media-type",
    date: "date",
    name: "name",
    size: "size",
    aspect: "aspect",
  };
  const suffix = segments[dimension];
  const withComb = `/filter_comb/${suffix}`;
  if (listPath.endsWith(withComb)) return listPath.slice(0, -withComb.length);
  const direct = `/${suffix}`;
  return listPath.endsWith(direct) ? listPath.slice(0, -direct.length) : "all";
}

function touchCache(key: string, value: FacetCacheEntry): void {
  facetCache.delete(key);
  facetCache.set(key, value);
  if (facetCache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = facetCache.keys().next().value as string | undefined;
  if (oldest) facetCache.delete(oldest);
}

/** 每次打开高级查询弹窗时清理，缓存生命周期限定在本次编辑会话。 */
export function clearAdvancedQueryFacetCache(): void {
  facetCache.clear();
}

function metaDisplayName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const record = meta as Record<string, unknown>;
  for (const key of ["display", "displayName", "label", "title", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const plugin = record.plugin;
  if (plugin && typeof plugin === "object") {
    const displayName = (plugin as Record<string, unknown>).displayName;
    if (typeof displayName === "string" && displayName.trim()) {
      return displayName.trim();
    }
  }
  return "";
}

export function useDimensionFacet(
  tree: Ref<GalleryAdvancedQuery>,
  nodePath: MaybeRefOrGetter<NodePath>,
  dimension: FacetDimension,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
  _options: UseDimensionFacetOptions = {},
) {
  const { t } = useI18n();
  const pluginStore = usePluginStore();
  const entries = ref<ProviderListChild[]>([]);
  const anyCount = ref<number>();
  const loading = ref(false);
  let requestToken = 0;

  const relativePath = computed(() =>
    facetListPath(tree.value, toValue(nodePath), dimension)
  );
  const path = computed(() =>
    advancedQueryRuntimePath(relativePath.value, toValue(contextPrefix))
  );
  const negated = computed(() => notParity(tree.value, toValue(nodePath)));

  function labelFor(entry: ProviderListChild): string {
    if (dimension === "plugin") {
      return metaDisplayName(entry.meta) ||
        pluginStore.pluginLabel(entry.name) || entry.name;
    }
    if (dimension === "date") {
      return entry.name.replace(/y$/, "");
    }
    return facetValueLabel(dimension, entry.name, t);
  }

  function valueFor(entry: ProviderListChild): string {
    return dimension === "date" ? entry.name.replace(/y$/, "") : entry.name;
  }

  const options = computed<KbFilterDropdownOption[]>(() =>
    entries.value.map((entry) => ({
      label: labelFor(entry),
      value: valueFor(entry),
      count: entry.total ?? undefined,
    }))
  );

  async function load(): Promise<void> {
    const key = path.value;
    const cached = facetCache.get(key);
    if (cached) {
      touchCache(key, cached);
      entries.value = cached.entries;
      anyCount.value = cached.anyCount;
      return;
    }

    const token = ++requestToken;
    loading.value = true;
    const reducedPath = advancedQueryRuntimePath(
      reducedTreePath(relativePath.value, dimension),
      toValue(contextPrefix),
    );
    try {
      const [nextEntries, entry] = await Promise.all([
        pathqlList(key, true),
        pathqlEntry(reducedPath),
      ]);
      if (token !== requestToken || key !== path.value) return;
      const next = {
        entries: Array.isArray(nextEntries) ? nextEntries : [],
        anyCount: typeof entry.total === "number" ? entry.total : 0,
      };
      touchCache(key, next);
      // fetch-then-overwrite：请求期间保留旧选项，避免切格时列表闪空。
      entries.value = next.entries;
      anyCount.value = next.anyCount;
    } catch (error) {
      console.error(`[advanced-query] facet load failed: ${key}`, error);
    } finally {
      if (token === requestToken) loading.value = false;
    }
  }

  return { options, anyCount, loading, load, negated, path };
}

export function useAdvancedHitCount(
  tree: Ref<GalleryAdvancedQuery>,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
) {
  const count = ref<number>();
  const loading = ref(false);
  let requestToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const path = computed(() => {
    const serialized = serializeAdvancedQuery(normalizeQuery(tree.value));
    return advancedQueryRuntimePath(serialized.body, toValue(contextPrefix));
  });

  watch(
    path,
    (nextPath) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const token = ++requestToken;
      loading.value = true;
      debounceTimer = setTimeout(async () => {
        try {
          const entry = await pathqlEntry(nextPath);
          if (token === requestToken) count.value = entry.total ?? 0;
        } catch (error) {
          if (token === requestToken) count.value = undefined;
          console.error(
            `[advanced-query] hit count failed: ${nextPath}`,
            error,
          );
        } finally {
          if (token === requestToken) loading.value = false;
        }
      }, 300);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    requestToken += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  return { count, loading };
}
