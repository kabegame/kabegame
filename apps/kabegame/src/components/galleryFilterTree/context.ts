import {
  computed,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import { invoke } from "@/api/rpc";
import {
  filterDateSegment,
  filterMediaKind,
  type GalleryFilter,
} from "@/utils/galleryPath";

export interface ProviderChildDir {
  kind: "dir";
  name: string;
  meta?: {
    isLeaf?: boolean;
  } | null;
  total?: number | null;
}

export interface ProviderCountResult {
  total?: number | null;
}

export interface RefreshTarget {
  refresh: () => void | Promise<void>;
}

export interface GalleryFilterTreeContext {
  filter: ComputedRef<GalleryFilter>;
  prefix: ComputedRef<string>;
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

export async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await invoke<ProviderChildDir[]>("list_provider_children", {
    path,
  });
  return (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is ProviderChildDir =>
      !!entry &&
      entry.kind === "dir" &&
      typeof entry.name === "string" &&
      entry.name.trim().length > 0
  );
}

export async function countProviderPath(path: string): Promise<number> {
  const p = normalizeProviderPath(path);
  if (!p) return 0;
  const res = await invoke<ProviderCountResult>("browse_gallery_provider", {
    path: p,
  });
  return typeof res?.total === "number" ? res.total : 0;
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
      return filterMediaKind(b) === a.kind;
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
