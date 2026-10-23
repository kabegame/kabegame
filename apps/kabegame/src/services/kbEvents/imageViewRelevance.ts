import { IS_WEB } from "@/env";
import type { ImageInfo } from "@/types/image";
import {
  aspectBucketForDimensions,
  GALLERY_ASPECT_BUCKETS,
  queryUsesDimension,
  queryUsesSearchMode,
  type GalleryQuery,
} from "@/utils/galleryQuery";
import type { GallerySort } from "@/utils/galleryPath";
import { isHiddenAlbumChange, on, type EventTrigger, type ImageFieldPatch } from "./events";

export interface ImageViewState {
  query: GalleryQuery;
  sort: GallerySort;
  hide: boolean;
}

/** 与 gallery_size_range_provider 一致；无法可靠解析时不排除。 */
function sizeMayMatch(size: number | undefined, range: string): boolean {
  if (range === "unknown") return size == null || size <= 0;
  const match = /^([0-9]+[A-Za-z]+)?-([0-9]+[A-Za-z]+)?$/.exec(range);
  if (!match) return true;
  const bytes = (bound: string | undefined, fallback: number): number | null => {
    if (!bound) return fallback;
    const parsed = /^(\d+)(B|KB|MB|GB)$/i.exec(bound);
    if (!parsed) return null;
    const factor = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[parsed[2]!.toUpperCase()]!;
    const value = Number(parsed[1]) * factor;
    return Number.isSafeInteger(value) ? value : null;
  };
  const min = bytes(match[1], 1);
  const max = bytes(match[2], Number.MAX_SAFE_INTEGER);
  if (min === null || max === null) return true;
  return size != null && size >= min && size < max;
}

/** 与 aspect_range_provider 同为左开右闭、整数交叉乘法。 */
function aspectMayMatch(image: ImageInfo, range: string): boolean {
  const { width, height } = image;
  const unknown = width == null || height == null || width <= 0 || height <= 0;
  if (range === "unknown") return unknown;
  const match = /^(?:([1-9][0-9]*)x([1-9][0-9]*))?-(?:([1-9][0-9]*)x([1-9][0-9]*))?$/.exec(range);
  if (!match || (!match[1] && !match[3])) return true;
  if (unknown) return false;
  // 数据库宽高是整数；异常行不拿前端舍入结果排除。
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return true;
  if (GALLERY_ASPECT_BUCKETS.some((bucket) => bucket.range === range)) {
    return aspectBucketForDimensions(width, height) === range;
  }
  const [minW, minH] = match[1] ? [Number(match[1]), Number(match[2])] : [0, 1];
  const [maxW, maxH] = match[3] ? [Number(match[3]), Number(match[4])] : [1, 0];
  const products = [width! * minH!, height! * minW!, width! * maxH!, height! * maxW!];
  if (!products.every(Number.isSafeInteger)) return true;
  return products[0]! > products[1]! && products[2]! <= products[3]!;
}

/** 只检查顶层 AND 原子；any / not、搜索和插件扩展内容都交给后端判断。 */
export function imageMayMatchQuery(image: ImageInfo, query: GalleryQuery): boolean {
  return query.every((node) => {
    if (!("is" in node)) return true;
    const atom = node.is;
    if (atom.plugin && image.pluginId !== atom.plugin.pluginId) return false;
    if (atom.mediaType) {
      // gallery_media_type_provider 还接受旧行里的裸 video，且忽略大小写。
      const type = (image.type ?? "").toLowerCase();
      const kind = type === "video" || type.startsWith("video/") ? "video" : "image";
      if (kind !== atom.mediaType.kind) return false;
      const format = type.slice(type.indexOf("/") + 1);
      if (atom.mediaType.format && format !== atom.mediaType.format) return false;
    }
    if (atom.date && !IS_WEB && Number.isSafeInteger(image.crawledAt)) {
      // crawled_at_seconds 按 i64 除法截断；SQLite localtime 与桌面 / Android 同一系统时区。
      const seconds = image.crawledAt! > 253402300799 ? Math.trunc(image.crawledAt! / 1000) : image.crawledAt!;
      const date = new Date(seconds * 1000);
      const year = date.getFullYear();
      if (Number.isFinite(year) && year >= 0 && year <= 9999) {
        const local = [String(year).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
        if (!local.startsWith(atom.date.segment)) return false;
      }
    }
    if (atom.size && !sizeMayMatch(image.size, atom.size.range)) return false;
    if (atom.aspect && !aspectMayMatch(image, atom.aspect.range)) return false;
    return true;
  });
}

export function addedTrigger(view: () => ImageViewState, accept: (image: ImageInfo) => boolean = () => true): EventTrigger {
  return on("images-added", (payload) => payload.images.some((image) => accept(image) && imageMayMatchQuery(image, view().query)));
}

type FieldDeps = Record<string, (view: ImageViewState) => boolean>;
/** 表外字段保守刷新；这里只列能证明无关的展示字段及其依赖。 */
const FIELD_DEPS: FieldDeps = {
  thumbnailPath: () => false,
  compatiblePath: () => false,
  lastSetWallpaperAt: (v) => v.sort.field === "by-set-time",
  displayName: (v) => v.sort.field === "by-name" || queryUsesSearchMode(v.query, "display-name"),
  metadataId: (v) => queryUsesSearchMode(v.query, "metadata") || queryUsesDimension(v.query, "plugin"),
  imageMetadataId: (v) => queryUsesSearchMode(v.query, "native-metadata"),
  pluginId: (v) => queryUsesDimension(v.query, "plugin"),
  postUrl: (v) => queryUsesSearchMode(v.query, "url"),
};

export function patchTriggers(view: () => ImageViewState, extra: FieldDeps = {}): EventTrigger[] {
  const deps = { ...FIELD_DEPS, ...extra };
  const relevant = (patch: ImageFieldPatch) => Object.keys(patch).some((field) =>
    field !== "id" && (!Object.hasOwn(deps, field) || deps[field]!(view())),
  );
  return [
    on("image-changed", (payload) => relevant(payload.patch)),
    on("images-change", (payload) => payload.patches.some(relevant)),
  ];
}

export function hiddenTrigger(view: () => ImageViewState): EventTrigger {
  return on("album-images-change", (payload) => view().hide && isHiddenAlbumChange(payload));
}
