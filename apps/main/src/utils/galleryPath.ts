/**
 * 画廊 query.path：`<root>/[desc/]<page>`，如 all/1、all/desc/2、plugin/foo/desc/1。
 * 纯函数：由 (root, sort, page) 拼 path；由 path 解析出三部分。无聚合「状态对象」供业务持有。
 */

export const GALLERY_STORAGE_KEY_ROOT = "kabegame-gallery-browse-root";
export const GALLERY_STORAGE_KEY_SORT = "kabegame-gallery-sort";
export const GALLERY_STORAGE_KEY_PAGE = "kabegame-gallery-page";

export type GalleryTimeSort = "asc" | "desc";

/** localStorage 中的排序偏好；空字符串表示尚未选择，路径上仍按正序 all/1 处理 */
export type GalleryStoredSort = GalleryTimeSort | "";

/** parseGalleryPath 的返回值，仅用于解析/再拼装，不作为持久化模型 */
export interface ParsedGalleryPath {
  root: string;
  sort: GalleryTimeSort;
  page: number;
}

const DEFAULT_ROOT = "all";
const DEFAULT_SORT: GalleryStoredSort = "";
const DEFAULT_PAGE = 1;

/** `date/<YYYY|YYYY-MM|YYYY-MM-DD>` 单段，末段含 `-` 时不能用 parseInt 当页码 */
function isDateTimeTailSegment(seg: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(seg) ||
    /^\d{4}-\d{2}$/.test(seg) ||
    /^\d{4}$/.test(seg)
  );
}

/**
 * 解析 `date/<时间粒度>/[/desc/]<page>`，避免 `date/2025-01` 被误解析为 root=`date`、page=2025。
 */
function tryParseDateGalleryPath(segs: string[]): ParsedGalleryPath | null {
  if (segs.length < 2 || segs[0]!.toLowerCase() !== "date") {
    return null;
  }
  const t = segs[1]!.trim();
  if (!isDateTimeTailSegment(t)) {
    return null;
  }
  const root = `date/${t}`;
  const tail = segs.slice(2);
  if (tail.length === 0) {
    return { root, sort: "asc", page: DEFAULT_PAGE };
  }
  if (tail[0] === "desc") {
    const p = parseInt(tail[1] ?? "", 10);
    const page =
      Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
    return { root, sort: "desc", page };
  }
  const p = parseInt(tail[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { root, sort: "asc", page };
}

/**
 * 解析 `media-type/image|video/[/desc/]<page>`，与 date 路径同理保留两段 root。
 */
function tryParseMediaTypeGalleryPath(segs: string[]): ParsedGalleryPath | null {
  if (segs.length < 2 || segs[0]!.toLowerCase() !== "media-type") {
    return null;
  }
  const kind = segs[1]!.trim().toLowerCase();
  if (kind !== "image" && kind !== "video") {
    return null;
  }
  const root = `media-type/${kind}`;
  const tail = segs.slice(2);
  if (tail.length === 0) {
    return { root, sort: "asc", page: DEFAULT_PAGE };
  }
  if (tail[0] === "desc") {
    const p = parseInt(tail[1] ?? "", 10);
    const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
    return { root, sort: "desc", page };
  }
  const p = parseInt(tail[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { root, sort: "asc", page };
}

export function buildGalleryPath(
  root: string,
  sort: GalleryStoredSort,
  page: number
): string {
  const r = (root || DEFAULT_ROOT).trim() || DEFAULT_ROOT;
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const s = sort === "desc" ? "desc" : "asc";
  if (s === "desc") return `${r}/desc/${p}`;
  return `${r}/${p}`;
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    root: DEFAULT_ROOT,
    sort: "asc",
    page: DEFAULT_PAGE,
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  const segs = trimmed.split("/").filter(Boolean);
  if (segs.length === 0) return base;

  const dateParsed = tryParseDateGalleryPath(segs);
  if (dateParsed) {
    return dateParsed;
  }

  const mediaParsed = tryParseMediaTypeGalleryPath(segs);
  if (mediaParsed) {
    return mediaParsed;
  }

  const last = segs[segs.length - 1]!;
  const pageNum = parseInt(last, 10);
  if (Number.isNaN(pageNum) || pageNum < 1) return base;

  if (segs.length === 1) {
    return { ...base, page: pageNum };
  }

  const beforePage = segs[segs.length - 2]!;
  if (beforePage === "desc") {
    const rootSegs = segs.slice(0, -2);
    return {
      root: rootSegs.length ? rootSegs.join("/") : DEFAULT_ROOT,
      sort: "desc",
      page: pageNum,
    };
  }

  const rootSegs = segs.slice(0, -1);
  return {
    root: rootSegs.length ? rootSegs.join("/") : DEFAULT_ROOT,
    sort: "asc",
    page: pageNum,
  };
}

/** 仅改排序，保留 root 与 page */
export function galleryPathWithSortOnly(
  path: string,
  sort: GalleryTimeSort
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(p.root, sort, p.page);
}

/** 画廊「全部 / 设置过壁纸」等简单过滤：改 root，保留 sort，页码回到 1 */
export function galleryPathWithRootOnly(path: string, newRoot: string): string {
  const p = parseGalleryPath(path);
  const r = (newRoot || DEFAULT_ROOT).trim() || DEFAULT_ROOT;
  const sort: GalleryStoredSort = p.sort === "desc" ? "desc" : "asc";
  return buildGalleryPath(r, sort, 1);
}

/** 当前 path 的 root 是否属于「全部 / 设置过壁纸 / 按插件 / 按时间」等根级浏览过滤 */
export function isGallerySimpleFilterRoot(root: string): boolean {
  return (
    root === "all" ||
    root === "wallpaper-order" ||
    /^plugin\//i.test(root) ||
    /^date\//i.test(root) ||
    /^media-type\//i.test(root)
  );
}

/** 从 root 解析 `plugin/<pluginId>` 的插件 id；非插件根返回 null */
export function galleryPluginIdFromRoot(root: string): string | null {
  const r = (root || "").trim();
  if (!/^plugin\//i.test(r)) return null;
  const id = r.slice("plugin/".length).trim();
  return id || null;
}

/** 从 root 解析 `date/<YYYY|YYYY-MM|YYYY-MM-DD>` 的时间片段；非 date 根返回 null */
export function galleryDateTailFromRoot(root: string): string | null {
  const r = (root || "").trim();
  if (!/^date\//i.test(r)) return null;
  const tail = r.slice("date/".length).trim();
  return tail || null;
}

/** 从 root 解析 `media-type/image|video`；非该根返回 null */
export function galleryMediaKindFromRoot(root: string): "image" | "video" | null {
  const r = (root || "").trim();
  if (!/^media-type\//i.test(r)) return null;
  const tail = r.slice("media-type/".length).trim().toLowerCase();
  if (tail === "image" || tail === "video") return tail;
  return null;
}

export const DEFAULT_GALLERY_PATH = buildGalleryPath(
  DEFAULT_ROOT,
  DEFAULT_SORT,
  DEFAULT_PAGE
);
