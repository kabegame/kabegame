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
  queryRuntimePath,
  GALLERY_ASPECT_BUCKETS,
} from "@/utils/galleryPath";
import {
  type GalleryFilter,
  type GalleryQuery,
  type GalleryFilterDimension,
  type NodePath,
  normalizeQuery,
  notParity,
  serializeQueryBody,
  setFilterDimension,
  updateNode,
} from "@/utils/galleryQuery";
import { filterFromTreeSegment } from "@/components/galleryFilterTree/context";

export type FacetDimension = Exclude<GalleryFilterDimension, "search">;

const FACET_SEGMENTS: Record<FacetDimension, string> = {
  plugin: "plugin",
  mediaType: "media-type",
  date: "date",
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

/**
 * 高级面板 facet 树：枚举与计数分家。
 *
 * - 枚举（listPathForSegment）：纯净路径 `<contextPrefix>/<segment>`，不折叠任何
 *   草稿条件——候选全集与草稿树无关，稳定且可缓存（listProviderDirsPure）。
 *   减格枚举是简单查询「不断收窄 slot」时代的产物；高级查询里其他条件（尤其
 *   取非行的兄弟约束）会把候选列表挤没，反而丢信息。
 * - 计数（pathForSegment）：把候选值写进 NodePath 所指原子的对应维度，序列化
 *   **整棵草稿树**取命中数；节点侧与 baseline（当前整树命中数）作差显示
 *   +N/−N/0。取非、或组的符号由整树语义自然得出，不再需要拆 not 的特判。
 */
export function useDimensionFacet(
  tree: MaybeRefOrGetter<GalleryQuery>,
  nodePath: MaybeRefOrGetter<NodePath>,
  dimension: FacetDimension,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
) {
  const treeRootPath = computed(() =>
    queryRuntimePath(FACET_SEGMENTS[dimension], toValue(contextPrefix))
  );
  const baseline = useAdvancedHitCount(tree, contextPrefix);

  function listPathForSegment(segment: string): string {
    return queryRuntimePath(
      segment.replace(/^\/+|\/+$/g, ""),
      toValue(contextPrefix),
    );
  }

  function pathForSegment(segment: string): string {
    const currentTree = toValue(tree);
    const path = toValue(nodePath);
    const normalized = segment.replace(/^\/+|\/+$/g, "");
    let filter: GalleryFilter | null = null;
    if (normalized && normalized !== "all") {
      filter = filterFromTreeSegment(normalized);
      // 组内/取非行的 plugin extend 贡献受引擎限制，选择时会降级为裸插件
      // （见 GalleryAdvancedQueryConditionRow）；预测保持同一口径。
      if (
        filter.type === "plugin" &&
        filter.extendPath?.trim() &&
        (path.length > 1 || notParity(currentTree, path))
      ) {
        filter = { type: "plugin", pluginId: filter.pluginId };
      }
    }
    const nextTree = updateNode(currentTree, path, (node) => {
      if (!("is" in node)) {
        throw new Error("facet 预测的 NodePath 必须指向原子节点");
      }
      return { is: setFilterDimension(node.is, dimension, filter) };
    });
    const serialized = serializeQueryBody(nextTree);
    return queryRuntimePath(serialized.body, toValue(contextPrefix));
  }

  return {
    treeRootPath,
    listPathForSegment,
    pathForSegment,
    baselineCount: computed(() => baseline.count.value ?? null),
  };
}

export function useAdvancedHitCount(
  tree: MaybeRefOrGetter<GalleryQuery>,
  contextPrefix: MaybeRefOrGetter<string> = "images://gallery/",
) {
  const count = ref<number>();
  const loading = ref(false);
  let requestToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const path = computed(() => {
    const serialized = serializeQueryBody(normalizeQuery(toValue(tree)));
    return queryRuntimePath(serialized.body, toValue(contextPrefix));
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
