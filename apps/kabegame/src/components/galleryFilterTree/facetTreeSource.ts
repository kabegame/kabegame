import { computed, type ComputedRef, type Ref } from "vue";
import type { useI18n } from "@kabegame/i18n";
import type { usePluginStore } from "@/stores/plugins";
import { GALLERY_ASPECT_BUCKETS, type GalleryBrowseDimension, type GalleryFilter } from "@/utils/galleryPath";
import { buildTimeMenuScopeLabels, type TimeMenuScopeLabels } from "@/utils/galleryTimeFilterMenu";
import {
  dateFilterSegment,
  isProviderLeaf,
  isProviderPlain,
  isSameGalleryFilter,
  joinProviderPath,
  listProviderDirs,
  listProviderDirsPure,
  normalizeProviderPath,
  type GalleryFilterTreeContext,
  type ProviderChildDir,
} from "./context";
import type { TreeDataSource } from "@/components/tree/types";

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
  dataSource: TreeDataSource<FacetNode>;
  /** 顶层即该维度的子项；没有维度根，也没有「任意」行（清除走 chip 叉号）。 */
  roots(dimension: GalleryBrowseDimension): Promise<FacetNode[]>;
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

  // diff 模式走纯净缓存；侧栏每层只列举一次，计数直接读 meta.count。
  const deltaMode = computed(() => !!ctx.countBaseline);
  const listPathForSegment = (segment: string) => (ctx.listPathForSegment ?? ctx.pathForSegment)(segment);
  const listDirs = (path: string, withCount = false) => {
    if (deltaMode.value && !withCount) return listProviderDirsPure(path);
    return listProviderDirs(joinProviderPath(path, "_kb_co"), withCount);
  };

  function groupedCount(entry: ProviderChildDir): number | null {
    const count = entry.meta?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  }

  function extensionCount(entry: ProviderChildDir): number | null {
    return typeof entry.total === "number" && Number.isFinite(entry.total) ? entry.total : null;
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
  async function listDimension(dimension: GalleryBrowseDimension): Promise<FacetNode[]> {
    switch (dimension) {
      case "date": {
        const entries = await listDirs(listPathForSegment("date"));
        return entries
          .filter((entry) => /^(\d{4})y$/.test(entry.name))
          .map((entry) => ({ kind: "date", segments: [entry.name], count: groupedCount(entry) }));
      }
      case "mediaType": {
        const entries = await listDirs(listPathForSegment("media-type"));
        return entries
          .filter((entry) => entry.name === "image" || entry.name === "video")
          .map((entry) => ({
            kind: "media-kind",
            mediaKind: entry.name as "image" | "video",
            count: groupedCount(entry),
          }));
      }
      case "size": {
        const entries = await listDirs(listPathForSegment("size"));
        return entries.map((entry) => ({ kind: "size", range: entry.name, count: groupedCount(entry) }));
      }
      case "aspect": {
        const entries = await listDirs(listPathForSegment("aspect"));
        return entries.map((entry) => ({ kind: "aspect", range: entry.name, count: groupedCount(entry) }));
      }
      case "plugin": {
        const entries = await listDirs(listPathForSegment("plugin"));
        return entries.map((entry) => ({
          kind: "plugin",
          pluginId: entry.name,
          version: pluginVersion(entry.name),
          count: groupedCount(entry),
        }));
      }
    }
  }

  const dataSource: TreeDataSource<FacetNode> = {
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
    async getChildren(node): Promise<FacetNode[]> {
      try {
        switch (node.kind) {
          case "date": {
            const pattern = dateChildPattern(node.segments);
            const entries = await listDirs(listPathForSegment(["date", ...node.segments].join("/")));
            return entries
              .filter((entry) => !pattern || pattern.test(entry.name))
              .map((entry) => ({
                kind: "date",
                segments: [...node.segments, entry.name],
                count: groupedCount(entry),
              }));
          }
          case "media-kind": {
            const entries = await listDirs(listPathForSegment(`media-type/${node.mediaKind}`));
            return entries.map((entry) => ({
              kind: "media-format",
              mediaKind: node.mediaKind,
              format: entry.name,
              count: groupedCount(entry),
            }));
          }
          case "plugin": {
            const entries = await listDirs(
              listPathForSegment(`plugin/${encodeURIComponent(node.pluginId)}/extend`),
              true,
            );
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
            const entries = await listDirs(listPathForSegment(pluginExtendSegment(node)), true);
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
      } catch {
        // 旧实现：枚举失败 → 空子集 + loaded（不再自动重试）
        return [];
      }
    },
  };

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
    async roots(dimension) {
      try {
        return await listDimension(dimension);
      } catch {
        // 与 getChildren 一致：枚举失败 → 空列表
        return [];
      }
    },
    descriptor,
  };
}
