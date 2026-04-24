/**
 * 画廊 query.path：`<root>/[desc/][x{pageSize}x/]<page>`
 * 当 pageSize === 100（默认值）时省略 x{pageSize}x 段，保持与旧版路径兼容。
 * 示例：all/1、all/desc/2、all/x500x/3、plugin/foo/desc/x1000x/1。
 *
 * 按时间（date）走分层段：`date/YYYYy[/MMm[/DDd]]`，与后端
 * `gallery/date/` provider 树同构；例：date/2025y/1、date/2025y/01m/desc/2、
 * date/2025y/01m/15d/x500x/3。
 */

/** Gallery 持久化路径（不包含 `hide/` 前缀）：与 build/parseGalleryPath 同构。 */
export const GALLERY_STORAGE_KEY_PATH = "kabegame-gallery-path";

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
  pageSize: number;
  /** `display_name` 子串搜索，空串表示不过滤。URL 上编码为 `search/display-name/<encodeURIComponent>/` 前缀 */
  search: string;
}

/** 搜索段前缀（保持 build/parse 对称） */
const SEARCH_PREFIX = "search/display-name/";

/**
 * 画廊"上下文前缀"：非空搜索时返回 `search/display-name/<enc>/`，否则空串。
 * 供 `galleryRoute` store 的 `buildContext` + 调用侧拼 `plugin/` / `date/` 等 filter 根路径使用。
 */
export function buildGalleryContextPrefix(search: string | undefined): string {
  const q = (search ?? "").trim();
  return q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
}

function stripSearchPrefix(segs: string[]): { search: string; rest: string[] } {
  if (segs.length >= 3 && segs[0] === "search" && segs[1] === "display-name") {
    const raw = segs[2] ?? "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return { search: decoded, rest: segs.slice(3) };
  }
  return { search: "", rest: segs };
}

const DEFAULT_SORT: GalleryStoredSort = "";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;

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
      return `date/${encodeDateSegment(filter.segment)}`;
    case "date-range":
      return `date-range/${filter.start}~${filter.end}`;
    case "media-type":
      return `media-type/${filter.kind}`;
  }
}

/** canonical `YYYY[-MM[-DD]]` → 分层路径 `YYYYy[/MMm[/DDd]]`（与后端同构） */
function encodeDateSegment(segment: string): string {
  const [y, m, d] = segment.split("-");
  if (d) return `${y}y/${m}m/${d}d`;
  if (m) return `${y}y/${m}m`;
  return `${y}y`;
}

/** 分层路径段 `YYYYy[/MMm[/DDd]]` → canonical + 消费段数，不合法返回 null */
function decodeDateSegments(
  segs: readonly string[]
): { segment: string; consumed: number } | null {
  const y = segs[0]?.match(/^(\d{4})y$/)?.[1];
  if (!y) return null;
  const m = segs[1]?.match(/^(\d{2})m$/)?.[1];
  if (!m) return { segment: y, consumed: 1 };
  const d = segs[2]?.match(/^(\d{2})d$/)?.[1];
  if (!d) return { segment: `${y}-${m}`, consumed: 2 };
  return { segment: `${y}-${m}-${d}`, consumed: 3 };
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
    const parts = r.slice("date/".length).trim().split("/").filter(Boolean);
    const decoded = decodeDateSegments(parts);
    if (decoded) return { type: "date", segment: decoded.segment };
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

/** 从尾段数组（根已被消费）中解析 sort / pageSize / page。 */
function parseTail(tail: string[]): { sort: GalleryTimeSort; pageSize: number; page: number } {
  let rest = [...tail];
  let sort: GalleryTimeSort = "asc";
  let pageSize = DEFAULT_PAGE_SIZE;

  if (rest[0] === "desc") {
    sort = "desc";
    rest = rest.slice(1);
  }

  const pageSizeMatch = rest[0]?.match(/^x(\d+)x$/);
  if (pageSizeMatch) {
    pageSize = parseInt(pageSizeMatch[1]!, 10) || DEFAULT_PAGE_SIZE;
    rest = rest.slice(1);
  }

  const p = parseInt(rest[0] ?? "", 10);
  const page = Number.isNaN(p) || p < 1 ? DEFAULT_PAGE : p;
  return { sort, pageSize, page };
}

/**
 * 解析 `date/YYYYy[/MMm[/DDd]]/[desc/][x{n}x/]<page>`。
 */
function tryParseDateGalleryPath(segs: string[]): ParsedGalleryPath | null {
  if (segs.length < 2 || segs[0]!.toLowerCase() !== "date") {
    return null;
  }
  const decoded = decodeDateSegments(segs.slice(1));
  if (!decoded) return null;
  const filter: GalleryFilter = { type: "date", segment: decoded.segment };
  const tail = segs.slice(1 + decoded.consumed);
  if (tail.length === 0) {
    return { filter, sort: "asc", page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE, search: "" };
  }
  const { sort, pageSize, page } = parseTail(tail);
  return { filter, sort, page, pageSize, search: "" };
}

/**
 * 解析 `media-type/image|video/[/desc/][x{n}x/]<page>`。
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
    return { filter, sort: "asc", page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE, search: "" };
  }
  const { sort, pageSize, page } = parseTail(tail);
  return { filter, sort, page, pageSize, search: "" };
}

/**
 * 解析 `date-range/<start>~<end>/[desc/][x{n}x/]<page>`。
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
    return { filter, sort: "asc", page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE, search: "" };
  }
  const { sort, pageSize, page } = parseTail(tail);
  return { filter, sort, page, pageSize, search: "" };
}

export function buildGalleryPath(
  filter: GalleryFilter,
  sort: GalleryStoredSort,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
  search: string = ""
): string {
  const r = serializeFilter(filter);
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const s = sort === "desc" ? "desc" : "asc";
  const ps = pageSize === DEFAULT_PAGE_SIZE ? "" : `x${pageSize}x/`;
  const q = (search ?? "").trim();
  const prefix = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
  if (s === "desc") return `${prefix}${r}/desc/${ps}${p}`;
  return `${prefix}${r}/${ps}${p}`;
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    filter: DEFAULT_GALLERY_FILTER,
    sort: "asc",
    page: DEFAULT_PAGE,
    pageSize: DEFAULT_PAGE_SIZE,
    search: "",
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  const rawSegs = trimmed.split("/").filter(Boolean);
  if (rawSegs.length === 0) return base;

  const { search, rest: segs } = stripSearchPrefix(rawSegs);
  if (segs.length === 0) {
    return { ...base, search };
  }

  const dateParsed = tryParseDateGalleryPath(segs);
  if (dateParsed) {
    return { ...dateParsed, search };
  }

  const mediaParsed = tryParseMediaTypeGalleryPath(segs);
  if (mediaParsed) {
    return { ...mediaParsed, search };
  }

  const dateRangeParsed = tryParseDateRangeGalleryPath(segs);
  if (dateRangeParsed) {
    return { ...dateRangeParsed, search };
  }

  // General path: consume known root segments, then parse tail
  // Root can be 1 segment (all, wallpaper-order) or 2 segments (plugin/<id>)
  let rootSegs: string[];
  let tail: string[];

  if (
    segs[0]!.toLowerCase() === "plugin" &&
    segs.length >= 2 &&
    segs[1] !== "desc" &&
    !segs[1]!.match(/^x\d+x$/) &&
    Number.isNaN(parseInt(segs[1]!, 10))
  ) {
    rootSegs = segs.slice(0, 2);
    tail = segs.slice(2);
  } else {
    rootSegs = segs.slice(0, 1);
    tail = segs.slice(1);
  }

  if (tail.length === 0) {
    return { ...base, filter: parseFilter(rootSegs.join("/")), search };
  }

  const { sort, pageSize, page } = parseTail(tail);
  return {
    filter: parseFilter(rootSegs.join("/")),
    sort,
    page,
    pageSize,
    search,
  };
}

/** 仅改排序，保留 filter / pageSize / search，页码归 1 */
export function galleryPathWithSortOnly(
  path: string,
  sort: GalleryTimeSort
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(p.filter, sort, p.page, p.pageSize, p.search);
}

/** 画廊「全部 / 设置过壁纸」等简单过滤：改 filter，保留 sort / pageSize / search，页码回到 1 */
export function galleryPathWithFilterOnly(
  path: string,
  newFilter: GalleryFilter
): string {
  const p = parseGalleryPath(path);
  const sort: GalleryStoredSort = p.sort === "desc" ? "desc" : "asc";
  return buildGalleryPath(newFilter, sort, 1, p.pageSize, p.search);
}

/** 仅改搜索词，保留 filter / sort / pageSize，页码归 1 */
export function galleryPathWithSearchOnly(
  path: string,
  search: string
): string {
  const p = parseGalleryPath(path);
  const sort: GalleryStoredSort = p.sort === "desc" ? "desc" : "asc";
  return buildGalleryPath(p.filter, sort, 1, p.pageSize, search);
}

export const DEFAULT_GALLERY_PATH = buildGalleryPath(
  DEFAULT_GALLERY_FILTER,
  DEFAULT_SORT,
  DEFAULT_PAGE
);
