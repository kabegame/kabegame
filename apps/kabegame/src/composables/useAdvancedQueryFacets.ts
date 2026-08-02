import {
  computed,
  type MaybeRefOrGetter,
  onScopeDispose,
  ref,
  toValue,
  watch,
} from "vue";
import { pathqlEntry } from "@/services/pathql";
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

const FACET_SEGMENTS: Record<FacetDimension, string> = {
  plugin: "plugin",
  mediaType: "media-type",
  date: "date",
  name: "name",
  size: "size",
  aspect: "aspect",
};

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

/**
 * 维度选中值 → 本地化展示文案(chip 未打开下拉时也要有正确文案)。
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
    const bucket = GALLERY_NAME_LANGUAGE_BUCKETS.find((item) =>
      item.bucket === value
    );
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

/** 从 facet 列表路径剥掉末尾维度 router，得到该维度的减格树。空串表示 gallery 根。 */
export function reducedFacetTreePath(
  listPath: string,
  dimension: FacetDimension,
): string {
  const normalized = listPath.replace(/^\/+|\/+$/g, "");
  const suffix = FACET_SEGMENTS[dimension];
  if (normalized === suffix) return "";

  const withComb = `/filter_comb/${suffix}`;
  if (normalized.endsWith(withComb)) {
    return normalized.slice(0, -withComb.length);
  }
  const direct = `/${suffix}`;
  if (normalized.endsWith(direct)) {
    return normalized.slice(0, -direct.length);
  }
  throw new Error(`facet 路径缺少维度尾段 ${suffix}: ${listPath}`);
}

/**
 * 把侧栏树节点 segment 接到高级查询减格上下文。
 * `all` 指向减格树本身；根减格树直接从维度 router 起步，绝不生成 all/filter_comb。
 */
export function advancedFacetTreeSegmentPath(
  listPath: string,
  dimension: FacetDimension,
  segment: string,
): string {
  const normalizedSegment = segment.replace(/^\/+|\/+$/g, "");
  const reduced = reducedFacetTreePath(listPath, dimension);
  if (!normalizedSegment || normalizedSegment === "all") {
    return reduced || "all";
  }

  const suffix = FACET_SEGMENTS[dimension];
  if (
    normalizedSegment !== suffix &&
    !normalizedSegment.startsWith(`${suffix}/`)
  ) {
    throw new Error(`树节点路径不属于维度 ${dimension}: ${segment}`);
  }

  if (!reduced) return normalizedSegment;
  const usesFilterComb = listPath.replace(/\/+$/g, "").endsWith(
    `/filter_comb/${suffix}`,
  );
  return `${reduced}${
    usesFilterComb ? "/filter_comb/" : "/"
  }${normalizedSegment}`;
}

/** 为高级查询 facet 树提供减格路径、逐节点路径和取非显示状态。 */
export function useDimensionFacet(
  tree: MaybeRefOrGetter<GalleryAdvancedQuery>,
  nodePath: MaybeRefOrGetter<NodePath>,
  dimension: FacetDimension,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
) {
  const listPath = computed(() =>
    facetListPath(toValue(tree), toValue(nodePath), dimension)
  );
  const reducedTreePath = computed(() =>
    advancedQueryRuntimePath(
      advancedFacetTreeSegmentPath(listPath.value, dimension, "all"),
      toValue(contextPrefix),
    )
  );
  const negated = computed(() => notParity(toValue(tree), toValue(nodePath)));

  function pathForSegment(segment: string): string {
    return advancedQueryRuntimePath(
      advancedFacetTreeSegmentPath(listPath.value, dimension, segment),
      toValue(contextPrefix),
    );
  }

  return { listPath, reducedTreePath, negated, pathForSegment };
}

export function useAdvancedHitCount(
  tree: MaybeRefOrGetter<GalleryAdvancedQuery>,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
) {
  const count = ref<number>();
  const loading = ref(false);
  let requestToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const path = computed(() => {
    const serialized = serializeAdvancedQuery(normalizeQuery(toValue(tree)));
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
