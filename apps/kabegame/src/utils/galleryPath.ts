import {
  appendQueryBodyPart,
  asSingleFilterSet,
  encodeUserSegment,
  FILTER_COMB,
  type GalleryBrowseDimension,
  type GalleryFilterSet,
  type GalleryQuery,
  isGallerySearchMode,
  parseQueryBody,
  type QueryBodyPart,
  removeFilterDimension,
  serializeFilterSet,
  serializeQueryBody,
} from "./galleryQuery.ts";

// 查询对象模型（维度/原子/树/序列化）在 galleryQuery.ts；从任一模块导入均可。
export * from "./galleryQuery.ts";

/**
 * Gallery provider 整路径的拼装与解析。
 *
 * 画廊一条完整路径 = 随行路由上下文 + 查询体 + 排序 + 分页：
 *
 *   [hide/][<root>/][no-album/filter_comb/]<query body>/sort/<field>[/desc][/x{n}x]/<page>
 *
 * - `hide` 与 `no-album` 都是全局路由参数（值由 globalPathRoute 单例持有、跨页面
 *   共享，工具箱统一开关），不属于查询对象。工厂负责算出扣除赦免后的生效值：
 *   `hide/` 由工厂自己拼在最前，`no-album` 的位置在根前缀之后，故由业务 build 经
 *   本文件的 `noAlbum` 参数插入。详见 stores/pathRoute.ts。
 * - `<query body>` 由 galleryQuery.ts 的 GalleryQuery 序列化而来；简单过滤只是
 *   单原子查询的退化形态，路径层不再区分「简单过滤」与「高级查询」。
 * - 旧形态（搜索前缀在最前、no-album 混在维度序列里）仍可解析，见 parse 各处注释。
 */

export const GALLERY_STORAGE_KEY_PATH = "kabegame-gallery-path";

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

export type GalleryTimeSort = "asc" | "desc";
export type GalleryStoredSort = GalleryTimeSort | "";

export type GallerySortField =
  | "by-id"
  | "by-time"
  | "by-size"
  | "by-name"
  | "by-aspect"
  | "by-set-time"
  | "by-album-order"
  | "random";

export interface GallerySort {
  field: GallerySortField;
  desc: boolean;
  /** 随机排序种子（十进制字符串，1-18 位）；field 为 "random" 时必填。 */
  seed?: string;
}

/** 生成新的随机排序种子：落在后端 `[0-9]{1,18}` 约束与 i64 范围内。 */
export function newRandomSortSeed(): string {
  return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

export const DEFAULT_GALLERY_SORT: GallerySort = { field: "by-time", desc: false };

export function normalizeGallerySort(
  sort: GallerySort | GalleryStoredSort | undefined,
): GallerySort {
  if (sort && typeof sort === "object") {
    const field = isGallerySortField(sort.field) ? sort.field : "by-time";
    return {
      field,
      desc: !!sort.desc,
      ...(field === "random" ? { seed: sort.seed } : {}),
    };
  }
  return { field: "by-time", desc: sort === "desc" };
}

export function isGallerySortField(field: string | undefined): field is GallerySortField {
  return (
    field === "by-id" ||
    field === "by-time" ||
    field === "by-size" ||
    field === "by-name" ||
    field === "by-aspect" ||
    field === "by-set-time" ||
    field === "by-album-order" ||
    field === "random"
  );
}

// ---------------------------------------------------------------------------
// 路径状态
// ---------------------------------------------------------------------------

const NO_ALBUM = "no-album";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;

export interface ParsedGalleryPath {
  /**
   * 随行上下文：不属画册的图片。与 hide 并列，不进查询对象。
   * 值的真源是 globalPathRoute，各 route store 解析时会丢弃这里的结果——保留字段
   * 是为了让解析器把该段正确剥离，而不是让调用方拿它回写状态。
   */
  noAlbum: boolean;
  query: GalleryQuery;
  sort: GallerySort;
  page: number;
  pageSize: number;
}

/**
 * 查询行一次导航要改的字段集合：`GalleryQueryBar` 只发这一种事件，各页把它整体
 * 转交给自己的 path-route store。必须整体传递——跨多个字段的改动拆成多次导航
 * 会互相覆盖。
 */
export interface GalleryQueryPatch {
  query?: GalleryQuery;
  noAlbum?: boolean;
  sort?: GallerySort;
  page?: number;
  pageSize?: number;
}

export interface ComposablePathParams {
  rootPrefix?: string;
  noAlbum?: boolean;
  query: GalleryQuery;
  sort: GallerySort | GalleryStoredSort;
  page: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

function sortBodyPath(sort: GallerySort): string {
  return sort.field === "random"
    ? `sort/random-${sort.seed || newRandomSortSeed()}`
    : `sort/${sort.field}`;
}

/** noAlbum + 查询体 折成一个片段（无排序/分页），count 路径与整路径共用。 */
function foldContextAndQuery(
  noAlbum: boolean,
  query: GalleryQuery,
): QueryBodyPart {
  let result: QueryBodyPart = { body: "", endsAtHub: true };
  if (noAlbum) {
    result = appendQueryBodyPart(result, { body: NO_ALBUM, endsAtHub: false });
  }
  return appendQueryBodyPart(result, serializeQueryBody(query));
}

export function buildComposablePath(params: ComposablePathParams): string {
  const {
    rootPrefix = "",
    noAlbum = false,
    query,
    sort: sortOrOrder,
    page,
    pageSize = DEFAULT_PAGE_SIZE,
  } = params;
  const sort = normalizeGallerySort(sortOrOrder);
  const body = appendQueryBodyPart(foldContextAndQuery(noAlbum, query), {
    body: sortBodyPath(sort),
    endsAtHub: false,
  }).body;
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const ps = pageSize === DEFAULT_PAGE_SIZE ? "" : `x${pageSize}x/`;
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  return sort.desc ? `${rp}${body}/desc/${ps}${p}` : `${rp}${body}/${ps}${p}`;
}

/** 无排序/分页的计数路径；空查询回退 `all`。 */
export function buildComposableCountPath(
  rootPrefix: string,
  noAlbum: boolean,
  query: GalleryQuery,
): string {
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  return `${rp}${foldContextAndQuery(noAlbum, query).body || "all"}`;
}

export function buildGalleryCountPath(
  noAlbum: boolean,
  query: GalleryQuery,
): string {
  return buildComposableCountPath("", noAlbum, query);
}

/**
 * provider 树 / facet 计数的上下文前缀：`[search/<mode>/<q>/][<root>/]`。
 * 只有能被单原子表达的查询才贡献搜索上下文（高级弹窗的 facet 走
 * useDimensionFacet 的整树预测，不经过本前缀）。
 * 返回值为空或以 `/` 结尾；搜索段在 root 之前（search provider 是全局枢纽，
 * 与既有后端路由形态一致）。
 */
export function buildComposableContextPrefix(
  rootPrefix: string,
  query: GalleryQuery,
): string {
  const term = asSingleFilterSet(query)?.search;
  const searchPrefix = term?.query.trim()
    ? `search/${term.mode}/${encodeUserSegment(term.query)}/`
    : "";
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  return `${searchPrefix}${rp}`;
}

export function buildGalleryContextPrefix(query: GalleryQuery): string {
  return buildComposableContextPrefix("", query);
}

/** 高级弹窗上下文前缀里的 no-album 随行段（应用后仍生效的部分）。 */
export function noAlbumContextPrefix(noAlbum: boolean): string {
  return noAlbum ? `${NO_ALBUM}/${FILTER_COMB}/` : "";
}

/** 把查询体/列表的相对 body 接到完整 gallery 上下文，供 facet、计数与路径条共用。 */
export function queryRuntimePath(
  body: string,
  contextPrefix = "images://gallery/",
): string {
  const normalizedBody = body.replace(/^\/+/, "") || "all";
  let prefix = contextPrefix.trim().replace(/\/+$/, "");
  if (!prefix) prefix = "images://gallery";

  // no-album/filter_comb/all 不可路由；no-album 叶自身就是相同集合的合法计数入口。
  if (normalizedBody === "all" && prefix.endsWith(`/${FILTER_COMB}`)) {
    return prefix.slice(0, -`/${FILTER_COMB}`.length);
  }
  return `${prefix}/${normalizedBody}`;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export function parseComposablePath(
  path: string,
  rootSegs: string[] = [],
  defaultSort: GallerySortField = "by-time",
): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    noAlbum: false,
    query: [],
    sort: { field: defaultSort, desc: false },
    page: DEFAULT_PAGE,
    pageSize: DEFAULT_PAGE_SIZE,
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  let segs = trimmed.split("/").filter(Boolean);
  if (segs.length === 0) return base;

  if (rootSegs.length > 0) {
    if (segs.length < rootSegs.length) return base;
    for (let i = 0; i < rootSegs.length; i++) {
      if (segs[i] !== rootSegs[i]) return base;
    }
    segs = segs.slice(rootSegs.length);
  }
  if (segs.length === 0) return base;

  const { body, tail } = splitBodyAndTail(segs);
  const { sort: order, pageSize, page } = parseTail(tail);

  // no-album 随行上下文：规范形态在体首（后跟 filter_comb 回枢纽）。
  let rest = [...body];
  let noAlbum = false;
  if (rest[0] === NO_ALBUM) {
    noAlbum = true;
    rest = rest.slice(1);
    if (rest[0] === FILTER_COMB) rest = rest.slice(1);
  }

  const sortIndex = findSortIndex(rest);
  const parsedSort = sortIndex < 0 ? {} : parseSortChunk(rest.slice(sortIndex));
  const bodySegs = rest.slice(0, sortIndex < 0 ? rest.length : sortIndex);
  if (bodySegs.at(-1) === FILTER_COMB) bodySegs.pop();

  // 旧形态兼容：搜索前缀（search/<mode>/<q> 在最前）本就是合法的搜索原子段，
  // 由 parseQueryBody 统一吸收进查询，无需特判。
  let query = parseQueryBody(bodySegs);
  if (query === null) {
    // 回退为空查询而不是部分解析: 部分解析会展示错误的部分语义。
    console.warn("无法解析画廊查询路径，已降级为空查询");
    query = [];
  }

  const sortField = parsedSort.sortField ?? defaultSort;
  const sort: GallerySort = {
    field: sortField,
    desc: order === "desc",
    ...(sortField === "random" && parsedSort.sortSeed
      ? { seed: parsedSort.sortSeed }
      : {}),
  };
  return { noAlbum, query, sort, page, pageSize };
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  return parseComposablePath(path, []);
}

export function stripComposablePathTail(path: string): string {
  const trimmed = (path || "").trim().replace(/\/+$/g, "");
  if (!trimmed) return "";
  const segs = trimmed.split("/").filter(Boolean);
  let i = segs.length;
  if (i > 0 && /^[1-9][0-9]*$/.test(segs[i - 1]!)) {
    i--;
    if (i > 0 && /^x[1-9][0-9]*x$/.test(segs[i - 1]!)) {
      i--;
    }
    if (i > 0 && segs[i - 1] === "desc") {
      i--;
    }
  }
  return segs.slice(0, i).join("/");
}

/** 从原始(未 decode)路径段数组中剥离形如 `search/<mode>/<q>/` 的前缀(若存在)。
 *  旧形态的路径把搜索段放在 root 之前，`extractRootIdAndBody` 靠它兼容。 */
function splitLeadingSearchSegments(segs: string[]): { segments: string[]; rest: string[] } {
  if (segs.length >= 3 && segs[0] === "search" && isGallerySearchMode(segs[1])) {
    return {
      segments: [segs[0]!, segs[1]!, segs[2]!],
      rest: segs.slice(3),
    };
  }
  return { segments: [], rest: segs };
}

/**
 * 供 3 个 detail route store(album/task/surf)复用:从完整 path 中定位
 * `<rootSeg>/<id>/` 形式的根前缀，返回 `{ id, body }`。旧形态里搜索段在根前缀
 * 之前，此时把它重新拼回 body 前面（新形态搜索原子本就在 body 里）。
 * `rootSeg` 不匹配时返回 `{ id: "", body: 原始 trimmed path }`。
 */
export function extractRootIdAndBody(path: string, rootSeg: string): { id: string; body: string } {
  const trimmed = (path || "").trim();
  const allSegs = trimmed.split("/").filter(Boolean);
  const { segments: searchSegs, rest } = splitLeadingSearchSegments(allSegs);
  if (rest.length >= 2 && rest[0] === rootSeg) {
    const id = rest[1]!;
    const body = rest.slice(2).join("/");
    const prefix = searchSegs.length ? `${searchSegs.join("/")}/` : "";
    return { id, body: prefix + body };
  }
  return { id: "", body: trimmed };
}

// ---------------------------------------------------------------------------
// facet / count 辅助（FilterSet 级，chip 行的树面板用）
// ---------------------------------------------------------------------------

export function buildFilterSetCountPath(filters: GalleryFilterSet): string {
  return serializeFilterSet(filters) || "all";
}

export function buildDimensionCountPath(
  filters: GalleryFilterSet,
  dimSeg: string,
): string {
  const segment = normalizePath(dimSeg);
  if (!segment || segment === "all") {
    return buildFilterSetCountPath(filters);
  }
  // 本维度自身段必须是最后一段：引擎据此落到该维度 provider 去 list children；
  // 其余已选维度作前缀（WHERE 可交换，结果不变）。
  const dimension =
    dimensionForIncompletePathSegment(segment) ?? dimensionForPathSegment(segment);
  const base = serializeQueryBody([
    { is: dimension ? removeFilterDimension(filters, dimension) : filters },
  ]);
  if (!base.body) return segment;
  return `${base.body}${base.endsAtHub ? "/" : `/${FILTER_COMB}/`}${segment}`;
}

function dimensionForIncompletePathSegment(segment: string): GalleryBrowseDimension | null {
  const parts = normalizePath(segment).split("/").filter(Boolean);
  const root = parts[0]?.toLowerCase();
  if ((root === "plugin" || root === "plugins") && (!parts[1] || parts[2] === "extend" && !parts[3])) {
    return "plugin";
  }
  if ((root === "media-type") && !parts[1]) return "mediaType";
  if ((root === "date" || root === "dates") && !parts[1]) return "date";
  if (root === "size" && !parts[1]) return "size";
  if ((root === "aspect" || root === "dimension" || root === "dimensions") && !parts[1]) {
    return "aspect";
  }
  return null;
}

function dimensionForPathSegment(segment: string): GalleryBrowseDimension | null {
  const root = normalizePath(segment).split("/").filter(Boolean)[0]?.toLowerCase();
  switch (root) {
    case "plugin":
    case "plugins":
      return "plugin";
    case "media-type":
      return "mediaType";
    case "date":
    case "dates":
    case "date-range":
      return "date";
    case "size":
      return "size";
    case "aspect":
    case "dimension":
    case "dimensions":
      return "aspect";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function parseSortChunk(chunk: readonly string[]): {
  sortField?: GallerySortField;
  sortSeed?: string;
} {
  const field = chunk[1];
  const randomMatch = /^random-([0-9]{1,18})$/.exec(field ?? "");
  if (randomMatch) return { sortField: "random", sortSeed: randomMatch[1] };
  return isGallerySortField(field) ? { sortField: field } : {};
}

function findSortIndex(body: readonly string[]): number {
  for (let index = body.length - 2; index >= 0; index--) {
    if (body[index] !== "sort") continue;
    const parsed = parseSortChunk(body.slice(index));
    if (parsed.sortField) return index;
  }
  return -1;
}

function splitBodyAndTail(segs: string[]): { body: string[]; tail: string[] } {
  if (!segs.length || !/^[1-9][0-9]*$/.test(segs[segs.length - 1]!)) {
    return { body: segs, tail: [] };
  }
  let tailStart = segs.length - 1;
  if (tailStart > 0 && /^x[1-9][0-9]*x$/.test(segs[tailStart - 1]!)) tailStart -= 1;
  if (tailStart > 0 && segs[tailStart - 1] === "desc") tailStart -= 1;
  return { body: segs.slice(0, tailStart), tail: segs.slice(tailStart) };
}

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

function normalizePath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

export const DEFAULT_GALLERY_PATH = buildComposablePath({
  query: [],
  sort: "",
  page: DEFAULT_PAGE,
});
