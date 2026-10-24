import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import { queryUsesSearchMode } from "@/utils/galleryQuery";
import { addedTrigger, patchTriggers, hiddenTrigger, type ImageViewState } from "@/services/kbEvents";
import { computed, type ComputedRef, type Ref } from "vue";
import type { useI18n } from "@kabegame/i18n";
import type { usePluginStore } from "@/stores/plugins";
import {
  parseQueryBody,
  queryFromFilterSet,
  removeFilterDimension,
  GALLERY_ASPECT_BUCKETS,
  type GalleryBrowseDimension,
  type GalleryFilter,
} from "@/utils/galleryPath";
import { buildTimeMenuScopeLabels, type TimeMenuScopeLabels } from "@/utils/galleryTimeFilterMenu";
import {
  dateFilterSegment,
  isProviderLeaf,
  isProviderPlain,
  isSameGalleryFilter,
  joinProviderPath,
  normalizeProviderPath,
  type GalleryFilterTreeContext,
  type ProviderChildDir,
} from "./context";
import { withGalleryPrefix } from "@/utils/path";
import { on, albumPatchTriggers, type AlbumImagesPayload } from "@/services/kbEvents/events";
import type { TreeQuerySource } from "@/components/tree/types";

/**
 * 画廊过滤树的节点数据：旧特化组件（Date/DateChild/MediaType/Size/
 * Aspect/Plugins/Plugin/PluginExtend）的 union 化。枚举与描述逻辑收敛到
 * createGalleryFacetSource，行为逐一对照旧组件迁移。树里没有维度根，也没有「任意」行：
 * 顶层直接是该维度的子项，清除维度走 chip 右上角的叉号。
 */
export type FacetNode = (
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
    }
) & { count?: number | null };

export interface FacetDescriptor {
  name: string;
  /** 计数路径（已经过 ctx.pathForSegment，侧栏=减格计数 / 高级面板=预测计数）。 */
  countPath: string;
  selectable: boolean;
  defaultExpanded: boolean;
  active: boolean;
  /** 行点击要应用的过滤；维度根等不可选行为 null。 */
  filterOnSelect: GalleryFilter | null;
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

export interface GalleryFacetSourceDeps {
  t: ReturnType<typeof useI18n>["t"];
  locale: Ref<unknown>;
  pluginStore: ReturnType<typeof usePluginStore>;
}

export interface GalleryFacetSource {
  dataSource: TreeQuerySource<FacetNode>;
  /** 顶层即该维度的子项；没有维度根，也没有「任意」行（清除走 chip 叉号）。 */
  descriptor(node: FacetNode): FacetDescriptor;
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

  // 侧栏的前缀包含根归属与追加高级查询；当前维度要从简单条件中扣掉（减格计数）。
  const contextQuery = computed(() => {
    const body = normalizeProviderPath(ctx.prefix.value)
      .replace(/^images:\/\//, "")
      .replace(/^gallery(?:\/|$)/, "")
      .replace(/^hide(?:\/|$)/, "")
      .replace(/^(?:album|album-tree|task|surf)\/[^/]+(?:\/|$)/, "")
      .replace(/^no-album(?:\/_kb_fc)?(?:\/|$)/, "");
    return parseQueryBody(body.split("/").filter(Boolean));
  });
  const view = (): ImageViewState => ({
    query: [
      ...(contextQuery.value ?? []),
      ...queryFromFilterSet(
        ctx.dimension.value ? removeFilterDimension(ctx.filters.value, ctx.dimension.value) : ctx.filters.value,
      ),
    ],
    sort: { field: "by-time", desc: false },
    hide: /(^|\/)hide(?:\/|$)/.test(ctx.prefix.value),
  });

  const deltaMode = computed(() => !!ctx.countBaseline);
  const listPathForSegment = (segment: string) => (ctx.listPathForSegment ?? ctx.pathForSegment)(segment);

  function hasAlbumSensitiveContext() {
    const path = normalizeProviderPath(ctx.prefix.value).replace(/^images:\/\//, "");
    return (
      contextQuery.value === null ||
      /(^|\/)(?:album|album-tree|no-album)(?:\/|$)/.test(path) ||
      queryUsesSearchMode(view().query, "label")
    );
  }

  function memberAffectsContext(p: AlbumImagesPayload) {
    if (contextQuery.value === null || queryUsesSearchMode(view().query, "label")) return true;
    // 隐藏由 hiddenTrigger 按 hide 开关处理；收藏只影响收藏 / 无画册上下文。
    if (p.albumId === HIDDEN_ALBUM_ID) return false;
    if (p.albumId === FAVORITE_ALBUM_ID) {
      const path = normalizeProviderPath(ctx.prefix.value).replace(/^images:\/\//, "");
      return (
        /(^|\/)no-album(?:\/|$)/.test(path) ||
        new RegExp(`(^|/)(?:album|album-tree)/${FAVORITE_ALBUM_ID}(?:/|$)`).test(path)
      );
    }
    return hasAlbumSensitiveContext();
  }

  function groupedCount(entry: ProviderChildDir): number | null {
    const count = entry.meta?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  }

  /** 插件 router 惯用 `meta.image_count`，宿主维度用 `meta.count`；都没有就不显示，不补 COUNT。 */
  function extensionCount(entry: ProviderChildDir): number | null {
    const count = entry.meta?.count ?? entry.meta?.image_count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  }

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
      normalizeProviderPath(node.extendPath).split("/").filter(Boolean).map(encodeURIComponent).join("/"),
    ]
      .filter(Boolean)
      .join("/");
  }

  function countSegment(node: FacetNode): string {
    switch (node.kind) {
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
      case "date":
        return dateLabel(node.segments);
      case "media-kind":
        return node.mediaKind === "image" ? t("gallery.filterImageOnly") : t("gallery.filterVideoOnly");
      case "media-format":
        return node.format;
      case "size":
        return t(`gallery.${SIZE_BUCKETS.find((b) => b.range === node.range)?.labelKey ?? ""}`);
      case "aspect":
        return t(`gallery.${GALLERY_ASPECT_BUCKETS.find((b) => b.range === node.range)?.labelKey ?? ""}`);
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
      case "date": {
        const activeSegment = filter.type === "date" ? filter.segment : "";
        const current = dateFilterSegment(node.segments);
        return !!current && activeSegment.startsWith(`${current}-`);
      }
      case "media-kind":
        return filter.type === "media-type" && filter.kind === node.mediaKind && !!filter.format;
      case "plugin":
        return filter.type === "plugin" && filter.pluginId === node.pluginId && !!filter.extendPath?.trim();
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

  /** 列出某维度的第一层，即面板顶层。 */
  function parseDimension(dimension: GalleryBrowseDimension, entries: ProviderChildDir[]): FacetNode[] {
    switch (dimension) {
      case "date": {
        return entries
          .filter((entry) => /^(\d{4})y$/.test(entry.name))
          .map((entry) => ({ kind: "date", segments: [entry.name], count: groupedCount(entry) }));
      }
      case "mediaType": {
        return entries
          .filter((entry) => entry.name === "image" || entry.name === "video")
          .map((entry) => ({
            kind: "media-kind",
            mediaKind: entry.name as "image" | "video",
            count: groupedCount(entry),
          }));
      }
      case "size": {
        return entries.map((entry) => ({ kind: "size", range: entry.name, count: groupedCount(entry) }));
      }
      case "aspect": {
        return entries.map((entry) => ({ kind: "aspect", range: entry.name, count: groupedCount(entry) }));
      }
      case "plugin": {
        return entries.map((entry) => ({
          kind: "plugin",
          pluginId: entry.name,
          version: pluginVersion(entry.name),
          count: groupedCount(entry),
        }));
      }
    }
  }

  const dataSource: TreeQuerySource<FacetNode> = {
    getKey(node) {
      switch (node.kind) {
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
        case "media-format":
        case "size":
        case "aspect":
          return false;
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
    page(branch, page) {
      if (page !== 1) return null;
      let segment: string;
      if (branch.kind === "section") {
        const segments: Record<GalleryBrowseDimension, string> = {
          date: "date",
          mediaType: "media-type",
          size: "size",
          aspect: "aspect",
          plugin: "plugin",
        };
        segment = segments[branch.sectionId as GalleryBrowseDimension];
      } else {
        const node = branch.parent;
        switch (node.kind) {
          case "date":
            segment = ["date", ...node.segments].join("/");
            break;
          case "media-kind":
            segment = `media-type/${node.mediaKind}`;
            break;
          case "plugin":
            segment = `plugin/${encodeURIComponent(node.pluginId)}/extend`;
            break;
          case "plugin-extend":
            if (node.isLeaf) return null;
            segment = pluginExtendSegment(node);
            break;
          default:
            return null;
        }
      }
      const path = listPathForSegment(segment);
      return {
        queries: [
          {
            kind: "list",
            // 侧栏与高级候选都列 `_kb_co`；两者只差路径是否带草稿（listPathForSegment 已处理）
            path: withGalleryPrefix(joinProviderPath(path, "_kb_co")),
            withCount: false,
          },
        ],
        parse(results) {
          const entries = (Array.isArray(results[0]) ? results[0] : []).filter(
            (entry): entry is ProviderChildDir => !!entry && typeof entry.name === "string" && !!entry.name.trim(),
          );
          return branch.kind === "section"
            ? parseDimension(branch.sectionId as GalleryBrowseDimension, entries)
            : parseChildren(branch.parent, entries);
        },
      };
    },
    refreshOn(branch) {
      const pluginFacet =
        branch.kind === "section"
          ? branch.sectionId === "plugin"
          : branch.parent.kind === "plugin" || branch.parent.kind === "plugin-extend";
      // 插件分面自身也依赖分组键与扩展 metadata，不能只看减格后的查询条件。
      const extra = pluginFacet ? { pluginId: () => true, metadataId: () => true } : undefined;
      // 无法解析上下文时保留刷新，不能把未知条件当成没有依赖。
      const imageTriggers = [addedTrigger(view), ...patchTriggers(view, extra)].map((trigger) => ({
        ...trigger,
        relevant: (payload: unknown) => contextQuery.value === null || trigger.relevant(payload),
      }));
      return deltaMode.value
        ? []
        : [
            ...imageTriggers,
            on("images-deleted"),
            ...hiddenTrigger(view),
            on("album-images-added", memberAffectsContext),
            on("album-images-deleted", (p) => !p.imagesDeleted && memberAffectsContext(p)),
            ...albumPatchTriggers((_patch, kinds) => hasAlbumSensitiveContext() && kinds.structure),
            on("album-moved", () => hasAlbumSensitiveContext()),
            on("albums-added", () => hasAlbumSensitiveContext()),
            on("albums-deleted", () => hasAlbumSensitiveContext()),
          ];
    },
  };

  function parseChildren(node: FacetNode, entries: ProviderChildDir[]): FacetNode[] {
    switch (node.kind) {
      case "date": {
        const pattern = dateChildPattern(node.segments);
        return entries
          .filter((entry) => !pattern || pattern.test(entry.name))
          .map((entry) => ({
            kind: "date",
            segments: [...node.segments, entry.name],
            count: groupedCount(entry),
          }));
      }
      case "media-kind": {
        return entries.map((entry) => ({
          kind: "media-format",
          mediaKind: node.mediaKind,
          format: entry.name,
          count: groupedCount(entry),
        }));
      }
      case "plugin": {
        return entries.map((entry) => ({
          kind: "plugin-extend",
          pluginId: node.pluginId,
          name: entry.name,
          extendPath: entry.name,
          isLeaf: isProviderLeaf(entry),
          isPlain: isProviderPlain(entry),
          count: extensionCount(entry),
        }));
      }
      case "plugin-extend": {
        if (node.isLeaf) return [];
        return entries.map((entry) => ({
          kind: "plugin-extend",
          pluginId: node.pluginId,
          name: entry.name,
          extendPath: joinProviderPath(node.extendPath, entry.name),
          isLeaf: isProviderLeaf(entry),
          isPlain: isProviderPlain(entry),
          count: extensionCount(entry),
        }));
      }
      default:
        return [];
    }
  }

  function descriptor(node: FacetNode): FacetDescriptor {
    const selectable = !(node.kind === "plugin-extend" && node.isPlain);
    const filter = filterOnSelect(node);
    return {
      name: nodeName(node),
      countPath: ctx.pathForSegment(countSegment(node)),
      selectable,
      defaultExpanded: defaultExpanded(node),
      active: selectable && !!filter && isSameGalleryFilter(filter, ctx.filter.value),
      filterOnSelect: selectable ? filter : null,
    };
  }

  return {
    dataSource,
    descriptor,
  };
}
