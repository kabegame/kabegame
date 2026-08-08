import {
  computed,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import { pathqlEntry, pathqlList } from "@/services/pathql";
import { listen } from "@/api/rpc";
import { withGalleryPrefix } from "@/utils/path";
import {
  buildDimensionCountPath,
  buildFilterSetCountPath,
  filterDateSegment,
  filterMediaFormat,
  filterMediaKind,
  filterAspectRange,
  filterSizeRange,
  filterForDimension,
  removeFilterDimension,
  type GalleryFilter,
  type GalleryBrowseDimension,
  type GalleryFilterSet,
} from "@/utils/galleryPath";

export interface ProviderChildDir {
  name: string;
  meta: {
    isLeaf?: boolean;
    plain?: boolean;
  } | null;
  total: number | null;
}

export interface RefreshTarget {
  refresh: () => void | Promise<void>;
}

export interface GalleryFilterTreeContext {
  filter: ComputedRef<GalleryFilter>;
  filters: ComputedRef<GalleryFilterSet>;
  dimension: ComputedRef<GalleryBrowseDimension | null>;
  prefix: ComputedRef<string>;
  visible: ComputedRef<boolean>;
  autoExpandRoot: ComputedRef<boolean>;
  /** 计数路径：侧栏 = 减格绝对计数；高级面板 = 候选写进原子后的整树预测。 */
  pathForSegment: (segment: string) => string;
  /** 枚举路径。缺省回退 pathForSegment（侧栏减格语义）；高级面板给纯净路径。 */
  listPathForSegment?: (segment: string) => string;
  /**
   * 当前整树命中数基线。提供即进入 diff 模式：节点计数显示
   * `count − baseline`（+N/−N/0），且枚举走纯净列表（可缓存、不带 count）。
   */
  countBaseline?: ComputedRef<number | null>;
  registerRefreshTarget: (target: RefreshTarget) => () => void;
}

export const GalleryFilterTreeContextKey: InjectionKey<GalleryFilterTreeContext> =
  Symbol("GalleryFilterTreeContext");

/**
 * @deprecated 树基座迁移后 ctx 改为显式传参（createGalleryFacetSource(ctx, deps)），
 * 注入链已无消费者；保留导出仅为过渡，勿在新代码中使用。
 */
export function provideGalleryFilterTreeContext(context: GalleryFilterTreeContext) {
  provide(GalleryFilterTreeContextKey, context);
}

/**
 * @deprecated 同 provideGalleryFilterTreeContext——ctx 请显式传参。
 */
export function useGalleryFilterTreeContext() {
  const context = inject(GalleryFilterTreeContextKey);
  if (!context) {
    throw new Error("GalleryFilterTree context is not provided");
  }
  return context;
}

export function normalizeProviderPath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

export function joinProviderPath(...parts: Array<string | undefined | null>) {
  return parts
    .map((part) => normalizeProviderPath(part ?? ""))
    .filter(Boolean)
    .join("/");
}

export function providerPathSegment(path = "") {
  return normalizeProviderPath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function pluginExtendKey(pluginId: string, extendPath = "") {
  const path = normalizeProviderPath(extendPath);
  return path ? `${pluginId}\t${path}` : pluginId;
}

export function parsePluginExtendKey(key: string) {
  const tab = key.indexOf("\t");
  if (tab < 0) return { pluginId: key, extendPath: "" };
  return { pluginId: key.slice(0, tab), extendPath: key.slice(tab + 1) };
}

export function pluginPath(prefix: string, pluginId: string) {
  return joinProviderPath(prefix, "plugin", encodeURIComponent(pluginId));
}

export function pluginExtendPath(prefix: string, pluginId: string, extendPath = "") {
  return joinProviderPath(
    prefix,
    "plugin",
    encodeURIComponent(pluginId),
    "extend",
    providerPathSegment(extendPath)
  );
}

export function isProviderLeaf(entry: ProviderChildDir) {
  return entry.meta?.isLeaf === true;
}

export function isProviderPlain(entry: ProviderChildDir) {
  return entry.meta?.plain === true;
}

export async function listProviderDirs(
  path: string,
  withCount = true,
): Promise<ProviderChildDir[]> {
  const entries = await pathqlList(withGalleryPrefix(path), withCount);
  return (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is ProviderChildDir =>
      !!entry &&
      typeof entry.name === "string" &&
      entry.name.trim().length > 0
  );
}

// 纯净枚举缓存：diff 模式下列表路径与草稿树无关，同一 (context, 维度) 的候选
// 全集在弹窗反复开合间不变，可整段复用；数据变更事件到达时整体失效。
const pureListCache = new Map<string, Promise<ProviderChildDir[]>>();
let pureListCacheInvalidationReady = false;

function ensurePureListCacheInvalidation() {
  if (pureListCacheInvalidationReady) return;
  pureListCacheInvalidationReady = true;
  const clear = () => pureListCache.clear();
  for (const eventName of [
    "images-change",
    "album-images-change",
    "plugin-added",
    "plugin-updated",
    "plugin-deleted",
  ]) {
    void listen(eventName, clear);
  }
}

export function listProviderDirsPure(path: string): Promise<ProviderChildDir[]> {
  ensurePureListCacheInvalidation();
  const key = normalizeProviderPath(path);
  const cached = pureListCache.get(key);
  if (cached) return cached;
  const promise = listProviderDirs(path, false);
  pureListCache.set(key, promise);
  promise.catch(() => {
    if (pureListCache.get(key) === promise) pureListCache.delete(key);
  });
  return promise;
}

/** 树节点的枚举出口：diff 模式走纯净缓存列表，侧栏保持减格 + 带 count。 */
export function useProviderTreeList() {
  const context = useGalleryFilterTreeContext();
  const deltaMode = computed(() => !!context.countBaseline);
  const listPathForSegment = (segment: string) =>
    (context.listPathForSegment ?? context.pathForSegment)(segment);
  const listDirs = (path: string) =>
    deltaMode.value ? listProviderDirsPure(path) : listProviderDirs(path);
  return { deltaMode, listPathForSegment, listDirs };
}

export async function countProviderPath(path: string): Promise<number> {
  const p = normalizeProviderPath(path);
  if (!p) return 0;
  const res = await pathqlEntry(withGalleryPrefix(p));
  return typeof res?.total === "number" ? res.total : 0;
}

export function useProviderSegmentPath(segment: ComputedRef<string>) {
  const { pathForSegment } = useGalleryFilterTreeContext();
  return computed(() => pathForSegment(segment.value));
}

export function useProviderPathForFilter(filter: ComputedRef<GalleryFilter>) {
  const { pathForSegment } = useGalleryFilterTreeContext();
  return computed(() => pathForSegment(serializeFilterForTree(filter.value)));
}

export function serializeFilterForTree(filter: GalleryFilter): string {
  switch (filter.type) {
    case "all":
      return "all";
    case "plugin": {
      const id = encodeURIComponent(filter.pluginId);
      const extendPath = providerPathSegment(filter.extendPath ?? "");
      return extendPath ? `plugin/${id}/extend/${extendPath}` : `plugin/${id}`;
    }
    case "date": {
      const [y, m, d] = filter.segment.split("-");
      if (d) return `date/${y}y/${m}m/${d}d`;
      if (m) return `date/${y}y/${m}m`;
      return `date/${y}y`;
    }
    case "media-type":
      return filter.format
        ? `media-type/${filter.kind}/${encodeURIComponent(filter.format)}`
        : `media-type/${filter.kind}`;
    case "size":
      return `size/${filter.range}`;
    case "aspect":
      return `aspect/${filter.range}`;
    case "date-range":
      return "all";
  }
}

/** serializeFilterForTree 的逆：树节点 segment → GalleryFilter。识别不了的回退 all。 */
export function filterFromTreeSegment(segment: string): GalleryFilter {
  const segs = normalizeProviderPath(segment).split("/").filter(Boolean);
  switch (segs[0]) {
    case undefined:
    case "all":
      return { type: "all" };
    case "plugin": {
      const pluginId = decodeURIComponent(segs[1] ?? "");
      if (!pluginId) return { type: "all" };
      const extendPath = segs[2] === "extend"
        ? segs.slice(3).map(decodeURIComponent).join("/")
        : "";
      return extendPath
        ? { type: "plugin", pluginId, extendPath }
        : { type: "plugin", pluginId };
    }
    case "date": {
      const dateSegment = dateFilterSegment(segs.slice(1));
      return dateSegment ? { type: "date", segment: dateSegment } : { type: "all" };
    }
    case "media-type": {
      const kind = segs[1];
      if (kind !== "image" && kind !== "video") return { type: "all" };
      const format = segs[2] ? decodeURIComponent(segs[2]) : "";
      return format
        ? { type: "media-type", kind, format }
        : { type: "media-type", kind };
    }
    case "size":
      return segs[1] ? { type: "size", range: segs[1] } : { type: "all" };
    case "aspect":
      return segs[1] ? { type: "aspect", range: segs[1] } : { type: "all" };
    default:
      return { type: "all" };
  }
}

export function pathForTreeSegment(
  prefix: string,
  filters: GalleryFilterSet,
  dimension: GalleryBrowseDimension | null,
  segment: string,
) {
  const normalized = normalizeProviderPath(segment);
  if (!dimension) {
    return joinProviderPath(prefix, normalized || "all");
  }
  if (!normalized || normalized === "all") {
    return joinProviderPath(
      prefix,
      buildFilterSetCountPath(removeFilterDimension(filters, dimension)),
    );
  }
  return joinProviderPath(prefix, buildDimensionCountPath(filters, normalized));
}

export function isSameGalleryFilter(a: GalleryFilter, b: GalleryFilter) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "all":
      return true;
    case "date":
      return filterDateSegment(b) === a.segment;
    case "media-type":
      return filterMediaKind(b) === a.kind && filterMediaFormat(b) === (a.format?.trim() || null);
    case "size":
      return filterSizeRange(b) === a.range;
    case "aspect":
      return filterAspectRange(b) === a.range;
    case "plugin":
      return (
        b.type === "plugin" &&
        b.pluginId === a.pluginId &&
        normalizeProviderPath(b.extendPath ?? "") ===
          normalizeProviderPath(a.extendPath ?? "")
      );
    case "date-range":
      return b.type === "date-range" && b.start === a.start && b.end === a.end;
  }
}

export function activeFilterForDimension(
  filters: GalleryFilterSet,
  dimension: GalleryBrowseDimension | null,
  fallback: GalleryFilter,
) {
  return dimension ? filterForDimension(filters, dimension) : fallback;
}

export function dateFilterSegment(segments: readonly string[]) {
  const y = /^(\d{4})y$/.exec(segments[0] ?? "")?.[1];
  if (!y) return "";
  const m = /^(\d{2})m$/.exec(segments[1] ?? "")?.[1];
  const d = /^(\d{2})d$/.exec(segments[2] ?? "")?.[1];
  return d ? `${y}-${m}-${d}` : m ? `${y}-${m}` : y;
}

export function usePrefixPath(path: ComputedRef<string>) {
  const { prefix } = useGalleryFilterTreeContext();
  return computed(() => joinProviderPath(prefix.value, path.value));
}

export function unknownOrMatchingPlugin(pluginId: string) {
  return (pluginIds?: string[] | null) => {
    const ids = (pluginIds ?? []).map((id) => id.trim()).filter(Boolean);
    return ids.length === 0 || ids.includes(pluginId);
  };
}
