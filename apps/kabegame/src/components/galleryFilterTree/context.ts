import {
  computed,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import { pathqlEntry, pathqlList } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";
import {
  buildDimensionCountPath,
  buildFilterSetCountPath,
  filterDateSegment,
  filterMediaFormat,
  filterMediaKind,
  filterAspectRange,
  filterNameBucket,
  filterSizeRange,
  filterForDimension,
  removeFilterDimension,
  type GalleryFilter,
  type GalleryFilterDimension,
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
  dimension: ComputedRef<GalleryFilterDimension | null>;
  prefix: ComputedRef<string>;
  visible: ComputedRef<boolean>;
  autoExpandRoot: ComputedRef<boolean>;
  pathForSegment: (segment: string) => string;
  registerRefreshTarget: (target: RefreshTarget) => () => void;
}

export const GalleryFilterTreeContextKey: InjectionKey<GalleryFilterTreeContext> =
  Symbol("GalleryFilterTreeContext");

export function provideGalleryFilterTreeContext(context: GalleryFilterTreeContext) {
  provide(GalleryFilterTreeContextKey, context);
}

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

export async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await pathqlList(withGalleryPrefix(path), true);
  return (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is ProviderChildDir =>
      !!entry &&
      typeof entry.name === "string" &&
      entry.name.trim().length > 0
  );
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
    case "wallpaper-order":
      return "wallpaper-order";
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
    case "name":
      return `name/${filter.bucket}`;
    case "size":
      return `size/${filter.range}`;
    case "aspect":
      return `aspect/${filter.range}`;
    case "date-range":
      return "all";
    // no-album 由 header fold 开关控制，不是过滤树维度，无树形片段。
    case "no-album":
      return "all";
  }
}

export function pathForTreeSegment(
  prefix: string,
  filters: GalleryFilterSet,
  dimension: GalleryFilterDimension | null,
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
    case "wallpaper-order":
      return true;
    case "date":
      return filterDateSegment(b) === a.segment;
    case "media-type":
      return filterMediaKind(b) === a.kind && filterMediaFormat(b) === (a.format?.trim() || null);
    case "name":
      return filterNameBucket(b) === a.bucket;
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
  dimension: GalleryFilterDimension | null,
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
