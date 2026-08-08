import { computed, type ComputedRef, type Ref } from "vue";
import type { useI18n } from "@kabegame/i18n";
import type { usePluginStore } from "@/stores/plugins";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import {
  GALLERY_ASPECT_BUCKETS,
  type GalleryBrowseDimension,
  type GalleryFilter,
} from "@/utils/galleryPath";
import {
  buildTimeMenuScopeLabels,
  type TimeMenuScopeLabels,
} from "@/utils/galleryTimeFilterMenu";
import {
  countProviderPath,
  dateFilterSegment,
  isProviderLeaf,
  isProviderPlain,
  isSameGalleryFilter,
  joinProviderPath,
  listProviderDirs,
  listProviderDirsPure,
  normalizeProviderPath,
  unknownOrMatchingPlugin,
  type GalleryFilterTreeContext,
} from "./context";
import type { TreeDataSource } from "@/components/tree/types";

/**
 * 画廊过滤树的节点数据：旧 9 个特化组件（Any/Date/DateChild/MediaType/Size/
 * Aspect/Plugins/Plugin/PluginExtend）的 union 化。枚举与描述逻辑收敛到
 * createGalleryFacetSource，行为逐一对照旧组件迁移。
 */
export type FacetNode =
  | { kind: "any" }
  | { kind: "dim"; dimension: GalleryBrowseDimension }
  | { kind: "date"; segments: string[] }
  | { kind: "media-kind"; mediaKind: "image" | "video" }
  | { kind: "media-format"; mediaKind: "image" | "video"; format: string }
  | { kind: "size"; range: string }
  | { kind: "aspect"; range: string }
  | { kind: "plugin"; pluginId: string; version: string }
  | {
      kind: "plugin-extend";
      pluginId: string;
      name: string;
      extendPath: string;
      isLeaf: boolean;
      isPlain: boolean;
    };

export interface FacetDescriptor {
  name: string;
  /** 计数路径（已经过 ctx.pathForSegment，侧栏=减格计数 / 高级面板=预测计数）。 */
  countPath: string;
  selectable: boolean;
  defaultExpanded: boolean;
  active: boolean;
  /** 行点击要应用的过滤；维度根等不可选行为 null。 */
  filterOnSelect: GalleryFilter | null;
  /** images-change 的节点级过滤（plugin 系按 pluginIds 命中；无则全收）。 */
  imagesFilter?: (payload: ImagesChangePayload) => boolean;
}

/** 旧 SizeProviderChildrenNode 的本地桶表，原样搬入。 */
const SIZE_BUCKETS: Array<{ range: string; labelKey: string }> = [
  { range: "unknown", labelKey: "filterSize_unknown" },
  { range: "1B-512KB", labelKey: "filterSize_lt512k" },
  { range: "512KB-1MB", labelKey: "filterSize_512k_1m" },
  { range: "1MB-2MB", labelKey: "filterSize_1m_2m" },
  { range: "2MB-5MB", labelKey: "filterSize_2m_5m" },
  { range: "5MB-10MB", labelKey: "filterSize_5m_10m" },
  { range: "10MB-50MB", labelKey: "filterSize_10m_50m" },
  { range: "50MB-", labelKey: "filterSize_gte50m" },
];

const DIMENSION_LABEL_KEYS: Record<GalleryBrowseDimension, string> = {
  date: "gallery.filterByTime",
  mediaType: "gallery.filterByMediaType",
  size: "gallery.filterBySize",
  aspect: "gallery.filterByAspect",
  plugin: "gallery.filterByPlugin",
};

export interface GalleryFacetSourceDeps {
  t: ReturnType<typeof useI18n>["t"];
  locale: Ref<unknown>;
  pluginStore: ReturnType<typeof usePluginStore>;
}

export interface GalleryFacetSource {
  dataSource: TreeDataSource<FacetNode>;
  /** 根节点列表：「任意」+ 传入维度的根。 */
  roots(dimensions: GalleryBrowseDimension[]): FacetNode[];
  descriptor(node: FacetNode): FacetDescriptor;
  /** 分支子项重枚举对哪些事件敏感（含 plugin-* 只作用于插件列表分支）。 */
  childrenRefreshFilter(node: FacetNode): (event: string, payload: unknown) => boolean;
  /** 计数刷新对哪些事件敏感（plugin-* 一律不刷计数，与旧行为一致）。 */
  countRefreshFilter(node: FacetNode): (event: string, payload: unknown) => boolean;
}

/**
 * ctx 显式传参（不再 provide/inject）：特化组件删除后注入链唯一的消费者
 * 就是本源；GalleryFilterTreeContext 的字段语义原封不动。
 */
export function createGalleryFacetSource(
  ctx: GalleryFilterTreeContext,
  deps: GalleryFacetSourceDeps,
): GalleryFacetSource {
  const { t, pluginStore } = deps;

  // 旧 useProviderTreeList 的显式版：diff 模式走纯净缓存列表，侧栏减格 + 带 count。
  const deltaMode = computed(() => !!ctx.countBaseline);
  const listPathForSegment = (segment: string) =>
    (ctx.listPathForSegment ?? ctx.pathForSegment)(segment);
  const listDirs = (path: string) =>
    deltaMode.value ? listProviderDirsPure(path) : listProviderDirs(path);

  const timeLabels: ComputedRef<TimeMenuScopeLabels> = computed(() =>
    buildTimeMenuScopeLabels(t, String(deps.locale.value)),
  );

  function pluginVersion(pluginId: string): string {
    return pluginStore.plugins.find((plugin) => plugin.id === pluginId)?.version ?? "";
  }

  /** 旧 DateChildProviderChildrenNode.labelForSegments 原样。 */
  function dateLabel(segments: string[]): string {
    const current = dateFilterSegment(segments);
    const labels = timeLabels.value;
    if (!current) return segments[segments.length - 1] ?? "";
    if (/^\d{4}$/.test(current)) return labels.labelFullYearRow(current);
    if (/^\d{4}-\d{2}$/.test(current)) return labels.labelMonthRow(current);
    return labels.labelDayRow(current);
  }

  function dateChildPattern(segments: string[]): RegExp | null {
    switch (segments.length) {
      case 1:
        return /^(\d{2})m$/;
      case 2:
        return /^(\d{2})d$/;
      default:
        return null;
    }
  }

  function pluginExtendSegment(node: Extract<FacetNode, { kind: "plugin-extend" }>): string {
    return [
      "plugin",
      encodeURIComponent(node.pluginId),
      "extend",
      normalizeProviderPath(node.extendPath)
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/"),
    ]
      .filter(Boolean)
      .join("/");
  }

  function countSegment(node: FacetNode): string {
    switch (node.kind) {
      case "any":
      case "dim":
        return "all";
      case "date":
        return ["date", ...node.segments].join("/");
      case "media-kind":
        return `media-type/${node.mediaKind}`;
      case "media-format":
        // 旧 MediaTypeProviderChildrenNode 未对 format 做 encode，保持原样
        return `media-type/${node.mediaKind}/${node.format}`;
      case "size":
        return `size/${node.range}`;
      case "aspect":
        return `aspect/${node.range}`;
      case "plugin":
        return `plugin/${encodeURIComponent(node.pluginId)}`;
      case "plugin-extend":
        return pluginExtendSegment(node);
    }
  }

  function filterOnSelect(node: FacetNode): GalleryFilter | null {
    switch (node.kind) {
      case "any":
        return { type: "all" };
      case "dim":
        return null;
      case "date":
        return { type: "date", segment: dateFilterSegment(node.segments) };
      case "media-kind":
        return { type: "media-type", kind: node.mediaKind };
      case "media-format":
        return { type: "media-type", kind: node.mediaKind, format: node.format };
      case "size":
        return { type: "size", range: node.range };
      case "aspect":
        return { type: "aspect", range: node.range };
      case "plugin":
        return { type: "plugin", pluginId: node.pluginId };
      case "plugin-extend":
        return {
          type: "plugin",
          pluginId: node.pluginId,
          extendPath: normalizeProviderPath(node.extendPath),
        };
    }
  }

  function nodeName(node: FacetNode): string {
    switch (node.kind) {
      case "any":
        return t("gallery.filterAny");
      case "dim":
        return t(DIMENSION_LABEL_KEYS[node.dimension]);
      case "date":
        return dateLabel(node.segments);
      case "media-kind":
        return node.mediaKind === "image"
          ? t("gallery.filterImageOnly")
          : t("gallery.filterVideoOnly");
      case "media-format":
        return node.format;
      case "size":
        return t(`gallery.${SIZE_BUCKETS.find((b) => b.range === node.range)?.labelKey ?? ""}`);
      case "aspect":
        return t(
          `gallery.${GALLERY_ASPECT_BUCKETS.find((b) => b.range === node.range)?.labelKey ?? ""}`,
        );
      case "plugin":
        return pluginStore.pluginLabel(node.pluginId);
      case "plugin-extend":
        return node.name;
    }
  }

  /** 旧各组件的 defaultExpanded computed 原样搬入（active 祖先链展开）。 */
  function defaultExpanded(node: FacetNode): boolean {
    const filter = ctx.filter.value;
    switch (node.kind) {
      case "dim":
        switch (node.dimension) {
          case "date":
            return filter.type === "date";
          case "mediaType":
            return filter.type === "media-type";
          case "size":
            return filter.type === "size";
          case "aspect":
            return filter.type === "aspect";
          case "plugin":
            return filter.type === "plugin";
        }
        return false;
      case "date": {
        const activeSegment = filter.type === "date" ? filter.segment : "";
        const current = dateFilterSegment(node.segments);
        return !!current && activeSegment.startsWith(`${current}-`);
      }
      case "media-kind":
        return (
          filter.type === "media-type" && filter.kind === node.mediaKind && !!filter.format
        );
      case "plugin":
        return (
          filter.type === "plugin" &&
          filter.pluginId === node.pluginId &&
          !!filter.extendPath?.trim()
        );
      case "plugin-extend": {
        if (filter.type !== "plugin" || filter.pluginId !== node.pluginId) return false;
        const current = normalizeProviderPath(node.extendPath);
        const activePath = normalizeProviderPath(filter.extendPath ?? "");
        return !!current && activePath.startsWith(`${current}/`);
      }
      default:
        return false;
    }
  }

  function imagesFilterOf(node: FacetNode): FacetDescriptor["imagesFilter"] {
    if (node.kind === "plugin" || node.kind === "plugin-extend") {
      const matches = unknownOrMatchingPlugin(node.pluginId);
      return (payload) => matches(payload.pluginIds);
    }
    return undefined;
  }

  const dataSource: TreeDataSource<FacetNode> = {
    getKey(node) {
      switch (node.kind) {
        case "any":
          return "any";
        case "dim":
          return `dim:${node.dimension}`;
        case "date":
          return `date:${node.segments.join("/")}`;
        case "media-kind":
          return `mk:${node.mediaKind}`;
        case "media-format":
          return `mf:${node.mediaKind}:${node.format}`;
        case "size":
          return `size:${node.range}`;
        case "aspect":
          return `aspect:${node.range}`;
        case "plugin":
          // 版本进 key：插件更新后子树重挂（旧 v-for pluginKey 的行为）
          return `plugin:${node.pluginId}:${node.version}`;
        case "plugin-extend":
          return `ext:${node.pluginId}:${node.extendPath}`;
      }
    },
    hasChildren(node) {
      switch (node.kind) {
        case "any":
        case "media-format":
        case "size":
        case "aspect":
          return false;
        case "dim":
          return true;
        case "date":
          return node.segments.length < 3;
        case "media-kind":
          return true;
        case "plugin":
          return true;
        case "plugin-extend":
          return !node.isLeaf;
      }
    },
    async getChildren(node): Promise<FacetNode[]> {
      try {
        switch (node.kind) {
          case "dim":
            switch (node.dimension) {
              case "date": {
                const entries = await listDirs(`${listPathForSegment("date")}/`);
                return entries
                  .filter((entry) => /^(\d{4})y$/.test(entry.name))
                  .map((entry) => ({ kind: "date", segments: [entry.name] }));
              }
              case "mediaType":
                return [
                  { kind: "media-kind", mediaKind: "image" },
                  { kind: "media-kind", mediaKind: "video" },
                ];
              case "size":
                return SIZE_BUCKETS.map((b) => ({ kind: "size", range: b.range }));
              case "aspect":
                return GALLERY_ASPECT_BUCKETS.map((b) => ({
                  kind: "aspect",
                  range: b.range,
                }));
              case "plugin": {
                const entries = await listDirs(`${listPathForSegment("plugin")}/`);
                // diff 模式列的是纯净全集，不按绝对数量过滤（预测为 0 的项灰显但仍可选）；
                // 侧栏保持「只列有图的插件」。
                let ids: string[];
                if (deltaMode.value) {
                  ids = entries.map((entry) => entry.name).filter(Boolean);
                } else {
                  const groups = await Promise.all(
                    entries.map(async (entry) => ({
                      pluginId: entry.name,
                      count:
                        typeof entry.total === "number"
                          ? entry.total
                          : await countProviderPath(
                              ctx.pathForSegment(
                                `plugin/${encodeURIComponent(entry.name)}`,
                              ),
                            ),
                    })),
                  );
                  ids = groups
                    .filter((group) => group.pluginId && group.count > 0)
                    .map((group) => group.pluginId);
                }
                return ids.map((pluginId) => ({
                  kind: "plugin",
                  pluginId,
                  version: pluginVersion(pluginId),
                }));
              }
            }
            return [];
          case "date": {
            const pattern = dateChildPattern(node.segments);
            const entries = await listDirs(
              `${listPathForSegment(["date", ...node.segments].join("/"))}/`,
            );
            return entries
              .filter((entry) => !pattern || pattern.test(entry.name))
              .map((entry) => ({ kind: "date", segments: [...node.segments, entry.name] }));
          }
          case "media-kind": {
            const entries = await listDirs(
              `${listPathForSegment(`media-type/${node.mediaKind}`)}/`,
            );
            return entries.map((entry) => ({
              kind: "media-format",
              mediaKind: node.mediaKind,
              format: entry.name,
            }));
          }
          case "plugin": {
            const entries = await listDirs(
              `${listPathForSegment(`plugin/${encodeURIComponent(node.pluginId)}/extend`)}/`,
            );
            return entries.map((entry) => ({
              kind: "plugin-extend",
              pluginId: node.pluginId,
              name: entry.name,
              extendPath: entry.name,
              isLeaf: isProviderLeaf(entry),
              isPlain: isProviderPlain(entry),
            }));
          }
          case "plugin-extend": {
            if (node.isLeaf) return [];
            const entries = await listDirs(`${listPathForSegment(pluginExtendSegment(node))}/`);
            return entries.map((entry) => ({
              kind: "plugin-extend",
              pluginId: node.pluginId,
              name: entry.name,
              extendPath: joinProviderPath(node.extendPath, entry.name),
              isLeaf: isProviderLeaf(entry),
              isPlain: isProviderPlain(entry),
            }));
          }
          default:
            return [];
        }
      } catch {
        // 旧实现：枚举失败 → 空子集 + loaded（不再自动重试）
        return [];
      }
    },
  };

  function descriptor(node: FacetNode): FacetDescriptor {
    const selectable =
      node.kind !== "dim" && !(node.kind === "plugin-extend" && node.isPlain);
    const filter = filterOnSelect(node);
    return {
      name: nodeName(node),
      countPath: ctx.pathForSegment(countSegment(node)),
      selectable,
      defaultExpanded: defaultExpanded(node),
      active: selectable && !!filter && isSameGalleryFilter(filter, ctx.filter.value),
      filterOnSelect: selectable ? filter : null,
      imagesFilter: imagesFilterOf(node),
    };
  }

  function childrenRefreshFilter(node: FacetNode) {
    const isPluginList = node.kind === "dim" && node.dimension === "plugin";
    const imagesFilter = imagesFilterOf(node);
    return (event: string, payload: unknown) => {
      if (event === "images-change") {
        return imagesFilter ? imagesFilter(payload as ImagesChangePayload) : true;
      }
      if (event === "album-images-change") return true;
      // plugin-added / plugin-updated / plugin-deleted 只驱动插件列表分支
      return isPluginList;
    };
  }

  function countRefreshFilter(node: FacetNode) {
    const imagesFilter = imagesFilterOf(node);
    return (event: string, payload: unknown) => {
      if (event === "images-change") {
        return imagesFilter ? imagesFilter(payload as ImagesChangePayload) : true;
      }
      return event === "album-images-change";
    };
  }

  return {
    dataSource,
    roots(dimensions) {
      return [
        { kind: "any" },
        ...dimensions.map((dimension) => ({ kind: "dim", dimension }) as FacetNode),
      ];
    },
    descriptor,
    childrenRefreshFilter,
    countRefreshFilter,
  };
}
