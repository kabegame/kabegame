/**
 * 画廊 query.path：`<root>/[desc/]<page>`，如 all/1、all/desc/2、plugin/foo/desc/1。
 * 纯函数：由 (filter, sort, page) 拼 path；由 path 解析出三部分。无聚合「状态对象」供业务持有。
 */

export const GALLERY_STORAGE_KEY_ROOT = "kabegame-gallery-browse-root";
export const GALLERY_STORAGE_KEY_SORT = "kabegame-gallery-sort";
export const GALLERY_STORAGE_KEY_PAGE = "kabegame-gallery-page";
export const GALLERY_STORAGE_KEY_HIDE = "kabegame-gallery-hide";

export type GalleryTimeSort = "asc" | "desc";

/** localStorage 中的排序偏好；空字符串表示尚未选择，路径上仍按正序 all/1 处理 */
export type GalleryStoredSort = GalleryTimeSort | "";

export type GalleryFilter =
  | { type: "all" }
  | { type: "wallpaper-order" }
  | { type: "plugin"; pluginId: string }
  | { type: "date"; segment: string }
  | { type: "date-range"; start: string; end: string }
  | { type: "media-type"; kind: "image" | "video" };

/** parseGalleryPath 的返回值，仅用于解析/再拼装，不作为持久化模型 */
export interface ParsedGalleryPath {
  filter: GalleryFilter;
  sort: GalleryTimeSort;
  page: number;
}

const DEFAULT_SORT: GalleryStoredSort = "";
const DEFAULT_PAGE = 1;

/** 默认 filter（与历史 `DEFAULT_ROOT === "all"` 一致） */
export const DEFAULT_GALLERY_FILTER: GalleryFilter = { type: "all" };

export function serializeFilter(filter: GalleryFilter): string {
  switch (filter.type) {
    case "all":
      return "all";
    case "wallpaper-order":
      return "wallpaper-order";
    case "plugin":
      return `plugin/${filter.pluginId}`;
    case "date":
      return `date/${filter.segment}`;
    case "date-range":
      return `date-range/${filter.start}~${filter.end}`;
    case "media-type":
      return `media-type/${filter.kind}`;
  }
}

/** `date/<YYYY|YYYY-MM|YYYY-MM-DD>` 单段，末段含 `-` 时不能用 parseInt 当页码 */
function isDateTimeTailSegment(seg: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(seg) ||
    /^\d{4}-\d{2}$/.test(seg) ||
    /^\d{4}$/.test(seg)
  );
}

/**
 * 将 root 字符串（无 path 中的 sort/page）解析为 `GalleryFilter`。
 * 无法识别时回退为 `all`，与历史 URL/localStorage 兼容。
 */
export function parseFilter(root: string): GalleryFilter {
  const r = (root || "").trim();
  if (!r || r.toLowerCase() === "all") {
    return DEFAULT_GALLERY_FILTER;
  }
  if (r === "wallpaper-order") {
    return { type: "wallpaper-order" };
  }
  const lr = r.toLowerCase();
  if (lr.startsWith("plugin/")) {
    const id = r.slice("plugin/".length).trim();
    return id ? { type: "plugin", pluginId: id } : DEFAULT_GALLERY_FILTER;
  }
  if (lr.startsWith("date-range/")) {
    const rest = r.slice("date-range/".length).trim();
    const tilde = rest.indexOf("~");
    if (tilde > 0) {
      const start = rest.slice(0, tilde).trim();
      const end = rest.slice(tilde + 1).trim();
      if (start && end) return { type: "date-range", start, end };
    }
  }
  if (lr.startsWith("date/")) {
    const seg = (r.slice("date/".length).trim().split("/")[0] ?? "").trim();
    if (seg && isDateTimeTailSegment(seg)) return { type: "date", segment: seg };
  }
  if (lr.startsWith("media-type/")) {
    const kind = (r.slice("media-type/".length).trim().split("/")[0] ?? "")
      .toLowerCase()
      .trim();
    if (kind === "image" || kind === "video") {
      return { type: "media-type", kind };
    }
  }
  return DEFAULT_GALLERY_FILTER;
}

export function filterPluginId(f: GalleryFilter): string | null {
  return f.type === "plugin" ? f.pluginId : null;
}

export function filterDateSegment(f: GalleryFilter): string | null {
  return f.type === "date" ? f.segment : null;
}

export function filterMediaKind(f: GalleryFilter): "image" | "video" | null {
  return f.type === "media-type" ? f.kind : null;
}

/** 当前 filter 是否属于「全部 / 设置过壁纸 / 按插件 / 按时间 / 日期范围 / 媒体类型」等根级浏览过滤 */
export function isSimpleFilter(f: GalleryFilter): boolean {
  switch (f.type) {
    case "all":
    case "wallpaper-order":
    case "plugin":
    case "date":
    case "date-range":
    case "media-type":
      return true;
    default:
      return false;
  }
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
  const filter: GalleryFilter = { type: "date", segment: t };
  const tail = segs.slice(2);
  if (tail.length === 0) {
    return { filter, sort: "asc", page: DEFAULT_PAGE };
  }
  if (tail[0] === "desc") {
    const p = parseInt(tail[1] ?? "", 10);
    const page =
      Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
    return { filter, sort: "desc", page };
  }
  const p = parseInt(tail[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { filter, sort: "asc", page };
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
  const filter: GalleryFilter = { type: "media-type", kind };
  const tail = segs.slice(2);
  if (tail.length === 0) {
    return { filter, sort: "asc", page: DEFAULT_PAGE };
  }
  if (tail[0] === "desc") {
    const p = parseInt(tail[1] ?? "", 10);
    const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
    return { filter, sort: "desc", page };
  }
  const p = parseInt(tail[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { filter, sort: "asc", page };
}

/**
 * 解析 `date-range/<start>~<end>/[/desc/]<page>`。
 */
function tryParseDateRangeGalleryPath(segs: string[]): ParsedGalleryPath | null {
  if (segs.length < 2 || segs[0]!.toLowerCase() !== "date-range") {
    return null;
  }
  const rangeSeg = segs[1]!.trim();
  const tilde = rangeSeg.indexOf("~");
  if (tilde <= 0) {
    return null;
  }
  const start = rangeSeg.slice(0, tilde).trim();
  const end = rangeSeg.slice(tilde + 1).trim();
  if (!start || !end) {
    return null;
  }
  const filter: GalleryFilter = { type: "date-range", start, end };
  const tail = segs.slice(2);
  if (tail.length === 0) {
    return { filter, sort: "asc", page: DEFAULT_PAGE };
  }
  if (tail[0] === "desc") {
    const p = parseInt(tail[1] ?? "", 10);
    const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
    return { filter, sort: "desc", page };
  }
  const p = parseInt(tail[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { filter, sort: "asc", page };
}

export function buildGalleryPath(
  filter: GalleryFilter,
  sort: GalleryStoredSort,
  page: number
): string {
  const r = serializeFilter(filter);
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const s = sort === "desc" ? "desc" : "asc";
  if (s === "desc") return `${r}/desc/${p}`;
  return `${r}/${p}`;
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    filter: DEFAULT_GALLERY_FILTER,
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

  const dateRangeParsed = tryParseDateRangeGalleryPath(segs);
  if (dateRangeParsed) {
    return dateRangeParsed;
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
    const rootStr = rootSegs.length ? rootSegs.join("/") : "all";
    return {
      filter: parseFilter(rootStr),
      sort: "desc",
      page: pageNum,
    };
  }

  const rootSegs = segs.slice(0, -1);
  const rootStr = rootSegs.length ? rootSegs.join("/") : "all";
  return {
    filter: parseFilter(rootStr),
    sort: "asc",
    page: pageNum,
  };
}

/** 仅改排序，保留 filter 与 page */
export function galleryPathWithSortOnly(
  path: string,
  sort: GalleryTimeSort
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(p.filter, sort, p.page);
}

/** 画廊「全部 / 设置过壁纸」等简单过滤：改 filter，保留 sort，页码回到 1 */
export function galleryPathWithFilterOnly(
  path: string,
  newFilter: GalleryFilter
): string {
  const p = parseGalleryPath(path);
  const sort: GalleryStoredSort = p.sort === "desc" ? "desc" : "asc";
  return buildGalleryPath(newFilter, sort, 1);
}

export const DEFAULT_GALLERY_PATH = buildGalleryPath(
  DEFAULT_GALLERY_FILTER,
  DEFAULT_SORT,
  DEFAULT_PAGE
);
