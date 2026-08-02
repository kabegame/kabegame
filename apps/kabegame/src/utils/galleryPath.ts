import {
  normalizeQuery,
  parseAdvancedBody,
  serializeAdvancedQuery,
  type GalleryAdvancedQuery,
} from "./galleryQuery.ts";

/**
 * Gallery provider path builder/parser.
 *
 * New desktop filtering uses a composable filter set:
 *   <dim1>[/filter_comb/<dim2>...][/filter_comb/sort/<field>][/desc][/x{n}x]/<page>
 *
 * Old single-dimension paths are still accepted as a subset.
 */

export const GALLERY_STORAGE_KEY_PATH = "kabegame-gallery-path";

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

export interface GalleryFilterSet {
  wallpaperOrder?: boolean;
  noAlbum?: boolean;
  plugin?: { pluginId: string; extendPath?: string };
  mediaType?: { kind: "image" | "video"; format?: string };
  date?: { segment: string };
  name?: { bucket: string };
  size?: { range: string };
  aspect?: { range: string };
}

export type GalleryFilterDimension =
  | "wallpaperOrder"
  | "noAlbum"
  | "plugin"
  | "mediaType"
  | "date"
  | "name"
  | "size"
  | "aspect";

export type GalleryFilter =
  | { type: "all" }
  | { type: "wallpaper-order" }
  | { type: "no-album" }
  | { type: "plugin"; pluginId: string; extendPath?: string }
  | { type: "date"; segment: string }
  | { type: "date-range"; start: string; end: string }
  | { type: "media-type"; kind: "image" | "video"; format?: string }
  | { type: "name"; bucket: string }
  | { type: "size"; range: string }
  | { type: "aspect"; range: string };

export const GALLERY_NAME_LANGUAGE_BUCKETS = [
  { bucket: "english", labelKey: "filterName_english", autonym: "English" },
  { bucket: "chinese", labelKey: "filterName_chinese", autonym: "中文" },
  { bucket: "japanese", labelKey: "filterName_japanese", autonym: "日本語" },
  { bucket: "korean", labelKey: "filterName_korean", autonym: "한국어" },
  { bucket: "other", labelKey: "filterName_other", autonym: "Other" },
] as const;

export const GALLERY_ASPECT_BUCKETS = [
  { range: "landscape-4x3-16x9", labelKey: "filterAspect_landscape" },
  { range: "widescreen-16x9-21x9", labelKey: "filterAspect_widescreen" },
  { range: "square-3x4-4x3", labelKey: "filterAspect_square" },
  { range: "portrait-9x16-3x4", labelKey: "filterAspect_portrait" },
  { range: "other", labelKey: "filterAspect_other" },
] as const;

export type GallerySearchMode = "display-name" | "metadata" | "native-metadata";

/** 下拉菜单顺序：从最常用到最专业。 */
export const GALLERY_SEARCH_MODES: readonly GallerySearchMode[] = [
  "display-name",
  "metadata",
  "native-metadata",
];

export const DEFAULT_GALLERY_SEARCH_MODE: GallerySearchMode = "display-name";

export function isGallerySearchMode(value: string | undefined): value is GallerySearchMode {
  return value === "display-name" || value === "metadata" || value === "native-metadata";
}

export interface ParsedGalleryPath {
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
  searchMode: GallerySearchMode;
  /** Compatibility for compact/legacy controls: first selected dimension or all. */
  filter: GalleryFilter;
  advanced?: GalleryAdvancedQuery;
}

const FILTER_COMB = "filter_comb";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SORT: GalleryStoredSort = "";

export const DEFAULT_GALLERY_FILTER: GalleryFilter = { type: "all" };
export const DEFAULT_GALLERY_FILTER_SET: GalleryFilterSet = {};
export const DEFAULT_GALLERY_SORT: GallerySort = { field: "by-time", desc: false };

export const DIMENSION_ORDER: GalleryFilterDimension[] = [
  "wallpaperOrder",
  "noAlbum",
  "plugin",
  "mediaType",
  "date",
  "name",
  "size",
  "aspect",
];

export function buildGalleryContextPrefix(
  search: string | undefined,
  searchMode?: GallerySearchMode,
): string {
  return buildComposableContextPrefix("", search, searchMode);
}

export interface ComposablePathParams {
  rootPrefix?: string;
  filters: GalleryFilterSet | GalleryFilter | GalleryAdvancedQuery;
  /**
   * 高级查询树。显式传入时，`filters` 只承载不进入树的随行过滤（当前为 noAlbum）。
   * `filters` 直接传数组的旧调用仍兼容，但新代码应优先使用本字段。
   */
  advanced?: GalleryAdvancedQuery;
  sort: GallerySort | GalleryStoredSort;
  page: number;
  pageSize?: number;
  search?: string;
  searchMode?: GallerySearchMode;
}

interface AdvancedBodyPart {
  body: string;
  endsAtHub: boolean;
}

function appendAdvancedBodyPart(
  current: AdvancedBodyPart,
  next: AdvancedBodyPart,
): AdvancedBodyPart {
  if (!next.body) return current;
  if (!current.body) return next;
  return {
    body: `${current.body}${
      current.endsAtHub ? "/" : `/${FILTER_COMB}/`
    }${next.body}`,
    endsAtHub: next.endsAtHub,
  };
}

function buildAdvancedBody(
  filters: GalleryFilterSet,
  advanced: GalleryAdvancedQuery,
  search: string,
  searchMode: GallerySearchMode,
  trailing?: string,
  emptyFallback = false,
): string {
  let result: AdvancedBodyPart = { body: "", endsAtHub: true };

  if (filters.noAlbum) {
    result = appendAdvancedBodyPart(result, {
      body: "no-album",
      endsAtHub: false,
    });
  }

  const query = search.trim();
  if (query) {
    result = appendAdvancedBodyPart(result, {
      body: `search/${searchMode}/${encodeURIComponent(query)}`,
      // search query provider 会委派回 gallery 根，是枢纽。
      endsAtHub: true,
    });
  }

  const normalized = normalizeQuery(advanced);
  if (normalized.length > 0) {
    result = appendAdvancedBodyPart(result, serializeAdvancedQuery(normalized));
  }

  if (trailing) {
    result = appendAdvancedBodyPart(result, {
      body: trailing,
      endsAtHub: false,
    });
  }

  return result.body || (emptyFallback ? "all" : "");
}

/**
 * 高级弹窗中树体之前的随行上下文。返回值为空或以 `/` 结尾，并始终停在枢纽：
 * `no-album` 叶会先经过 `filter_comb`，全局 search 查询结束后本身回到 gallery 枢纽。
 */
export function buildAdvancedQueryContextPrefix(
  filters: GalleryFilterSet,
  search: string | undefined,
  searchMode: GallerySearchMode = DEFAULT_GALLERY_SEARCH_MODE,
): string {
  const body = buildAdvancedBody(filters, [], search ?? "", searchMode);
  if (!body) return "";
  return body === "no-album" ? `${body}/${FILTER_COMB}/` : `${body}/`;
}

/** 把高级树/列表的相对 body 接到完整 gallery 上下文，供 facet、计数与路径条共用。 */
export function advancedQueryRuntimePath(
  body: string,
  contextPrefix = "images://gallery/",
): string {
  const normalizedBody = body.replace(/^\/+/, "") || "all";
  let prefix = contextPrefix.trim().replace(/\/+$/, "");
  if (!prefix) prefix = "images://gallery";

  // no-album/filter_comb/all 不可路由；no-album 叶自身就是相同集合的合法计数入口。
  if (normalizedBody === "all" && prefix.endsWith("/filter_comb")) {
    return prefix.slice(0, -"/filter_comb".length);
  }
  return `${prefix}/${normalizedBody}`;
}

export function buildComposablePath(params: ComposablePathParams): string {
  const {
    rootPrefix = "",
    sort: sortOrOrder,
    page,
    pageSize = DEFAULT_PAGE_SIZE,
    search = "",
    searchMode = DEFAULT_GALLERY_SEARCH_MODE,
  } = params;
  const sort = normalizeGallerySort(sortOrOrder);
  const sortPath = sort.field === "random"
    ? `sort/random-${sort.seed || newRandomSortSeed()}`
    : `sort/${sort.field}`;
  let body: string;
  const legacyAdvanced = Array.isArray(params.filters)
    ? params.filters
    : undefined;
  const advanced = params.advanced ?? legacyAdvanced;
  if (advanced !== undefined) {
    const contextFilters = Array.isArray(params.filters)
      ? {}
      : isGalleryFilter(params.filters)
      ? singleFilterToSet(params.filters)
      : params.filters;
    body = buildAdvancedBody(
      contextFilters,
      advanced,
      search,
      searchMode,
      sortPath,
    );
  } else {
    const simpleFilters = params.filters as GalleryFilterSet | GalleryFilter;
    const filters = isGalleryFilter(simpleFilters)
      ? singleFilterToSet(simpleFilters)
      : simpleFilters;
    const filterPath = serializeFilterSet(filters);
    const bodyParts = filterPath ? [filterPath, sortPath] : [sortPath];
    body = bodyParts.join(`/${FILTER_COMB}/`);
  }
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const ps = pageSize === DEFAULT_PAGE_SIZE ? "" : `x${pageSize}x/`;
  const q = (search ?? "").trim();
  const searchPrefix = advanced === undefined && q
    ? `search/${searchMode}/${encodeURIComponent(q)}/`
    : "";
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  return sort.desc ? `${searchPrefix}${rp}${body}/desc/${ps}${p}` : `${searchPrefix}${rp}${body}/${ps}${p}`;
}

export function parseComposablePath(
  path: string,
  rootSegs: string[] = [],
  defaultSort: GallerySortField = "by-time",
): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    filters: {},
    filter: DEFAULT_GALLERY_FILTER,
    sort: { field: defaultSort, desc: false },
    page: DEFAULT_PAGE,
    pageSize: DEFAULT_PAGE_SIZE,
    search: "",
    searchMode: DEFAULT_GALLERY_SEARCH_MODE,
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  const rawSegs = trimmed.split("/").filter(Boolean);
  if (rawSegs.length === 0) return base;

  const { search, searchMode, rest: segs } = stripSearchPrefix(rawSegs);

  let restSegs = segs;
  if (rootSegs.length > 0) {
    if (restSegs.length < rootSegs.length) return { ...base, search, searchMode };
    for (let i = 0; i < rootSegs.length; i++) {
      if (restSegs[i] !== rootSegs[i]) return { ...base, search, searchMode };
    }
    restSegs = segs.slice(rootSegs.length);
  }

  if (restSegs.length === 0) return { ...base, search, searchMode };

  const { body, tail } = splitBodyAndTail(restSegs);
  const { sort: order, pageSize, page } = parseTail(tail);
  const {
    filters,
    sortField,
    sortSeed,
    legacyFilter,
    advanced,
    search: bodySearch,
    searchMode: bodySearchMode,
  } = parseBody(body);
  const sort: GallerySort = {
    field: sortField ?? defaultSort,
    desc: order === "desc",
    ...(sortField === "random" && sortSeed ? { seed: sortSeed } : {}),
  };
  const filter = advanced ? DEFAULT_GALLERY_FILTER : legacyFilter ?? filterSetToSingleFilter(filters);
  return {
    filters,
    filter,
    sort,
    page,
    pageSize,
    search: bodySearch ?? search,
    searchMode: bodySearchMode ?? searchMode,
    ...(advanced ? { advanced } : {}),
  };
}

export function buildComposableContextPrefix(
  rootPrefix: string,
  search: string | undefined,
  searchMode: GallerySearchMode = DEFAULT_GALLERY_SEARCH_MODE,
): string {
  const q = (search ?? "").trim();
  const searchPrefix = q ? `search/${searchMode}/${encodeURIComponent(q)}/` : "";
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  return `${searchPrefix}${rp}`;
}

export function buildComposableCountPath(
  rootPrefix: string,
  filters: GalleryFilterSet | GalleryFilter | GalleryAdvancedQuery,
  search: string = "",
  searchMode: GallerySearchMode = DEFAULT_GALLERY_SEARCH_MODE,
  advanced?: GalleryAdvancedQuery,
): string {
  const rp = rootPrefix ? `${normalizePath(rootPrefix)}/` : "";
  const legacyAdvanced = Array.isArray(filters) ? filters : undefined;
  const advancedTree = advanced ?? legacyAdvanced;
  if (advancedTree !== undefined) {
    const contextFilters = Array.isArray(filters)
      ? {}
      : isGalleryFilter(filters)
      ? singleFilterToSet(filters)
      : filters;
    return `${rp}${
      buildAdvancedBody(
        contextFilters,
        advancedTree,
        search,
        searchMode,
        undefined,
        true,
      )
    }`;
  }
  const q = (search ?? "").trim();
  const searchPrefix = q ? `search/${searchMode}/${encodeURIComponent(q)}/` : "";
  const simpleFilters = filters as GalleryFilterSet | GalleryFilter;
  const filterset = isGalleryFilter(simpleFilters)
    ? singleFilterToSet(simpleFilters)
    : simpleFilters;
  return `${searchPrefix}${rp}${buildFilterSetCountPath(filterset)}`;
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
 *  返回的 3 段仍保持原始 percent-encoding,真正的 decode 统一发生在 `stripSearchPrefix` 里。 */
function splitLeadingSearchSegments(segs: string[]): { segments: string[]; rest: string[] } {
  if (segs.length >= 3 && segs[0] === "search" && isGallerySearchMode(segs[1])) {
    let queryEnd = 2;
    while (queryEnd + 1 < segs.length && hasEscapedSlash(segs[queryEnd]!)) {
      queryEnd += 1;
    }
    return {
      segments: [segs[0]!, segs[1]!, segs.slice(2, queryEnd + 1).join("/")],
      rest: segs.slice(queryEnd + 1),
    };
  }
  return { segments: [], rest: segs };
}

function stripSearchPrefix(
  segs: string[],
): { search: string; searchMode: GallerySearchMode; rest: string[] } {
  const { segments, rest } = splitLeadingSearchSegments(segs);
  if (segments.length === 0 || rest[0] === FILTER_COMB) {
    return { search: "", searchMode: DEFAULT_GALLERY_SEARCH_MODE, rest: segs };
  }
  const searchMode = segments[1] as GallerySearchMode;
  const raw = segments[2] ?? "";
  return { search: decodePathSegment(raw), searchMode, rest };
}

/**
 * 供 3 个 detail route store(album/task/surf)复用:从完整 path 中先剥离(若存在的)
 * `search/<mode>/<q>/` 前缀,再定位 `<rootSeg>/<id>/` 形式的根前缀,返回 `{ id, body }`——
 * `body` 是把 search 前缀重新拼回"根前缀之后剩余部分"前面得到的字符串,可以直接交给
 * `parseComposablePath` 解析(由它统一完成 search 的实际 decode)。`rootSeg` 不匹配时
 * 返回 `{ id: "", body: 原始 trimmed path }`。
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

function isGalleryFilter(value: GalleryFilter | GalleryFilterSet): value is GalleryFilter {
  return typeof (value as GalleryFilter).type === "string";
}

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

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== ""),
  ) as T;
}

export function singleFilterToSet(filter: GalleryFilter): GalleryFilterSet {
  switch (filter.type) {
    case "all":
    case "date-range":
      return {};
    case "wallpaper-order":
      return { wallpaperOrder: true };
    case "no-album":
      return { noAlbum: true };
    case "plugin":
      return {
        plugin: cleanObject({
          pluginId: filter.pluginId,
          extendPath: normalizePath(filter.extendPath ?? ""),
        }),
      };
    case "media-type":
      return {
        mediaType: cleanObject({
          kind: filter.kind,
          format: filter.format?.trim(),
        }),
      };
    case "date":
      return { date: { segment: filter.segment } };
    case "name":
      return { name: { bucket: filter.bucket } };
    case "size":
      return { size: { range: filter.range } };
    case "aspect":
      return { aspect: { range: filter.range } };
  }
}

export function filterSetToSingleFilter(filters: GalleryFilterSet): GalleryFilter {
  for (const dim of DIMENSION_ORDER) {
    const filter = filterForDimension(filters, dim);
    if (filter.type !== "all") return filter;
  }
  return DEFAULT_GALLERY_FILTER;
}

export function filterForDimension(
  filters: GalleryFilterSet,
  dimension: GalleryFilterDimension,
): GalleryFilter {
  switch (dimension) {
    case "wallpaperOrder":
      return filters.wallpaperOrder ? { type: "wallpaper-order" } : DEFAULT_GALLERY_FILTER;
    case "noAlbum":
      return filters.noAlbum ? { type: "no-album" } : DEFAULT_GALLERY_FILTER;
    case "plugin":
      return filters.plugin?.pluginId
        ? {
            type: "plugin",
            pluginId: filters.plugin.pluginId,
            ...(filters.plugin.extendPath ? { extendPath: filters.plugin.extendPath } : {}),
          }
        : DEFAULT_GALLERY_FILTER;
    case "mediaType":
      return filters.mediaType
        ? {
            type: "media-type",
            kind: filters.mediaType.kind,
            ...(filters.mediaType.format ? { format: filters.mediaType.format } : {}),
          }
        : DEFAULT_GALLERY_FILTER;
    case "date":
      return filters.date?.segment
        ? { type: "date", segment: filters.date.segment }
        : DEFAULT_GALLERY_FILTER;
    case "name":
      return filters.name?.bucket
        ? { type: "name", bucket: filters.name.bucket }
        : DEFAULT_GALLERY_FILTER;
    case "size":
      return filters.size?.range
        ? { type: "size", range: filters.size.range }
        : DEFAULT_GALLERY_FILTER;
    case "aspect":
      return filters.aspect?.range
        ? { type: "aspect", range: filters.aspect.range }
        : DEFAULT_GALLERY_FILTER;
  }
}

export function setFilterDimension(
  filters: GalleryFilterSet,
  dimension: GalleryFilterDimension,
  filter: GalleryFilter | null,
): GalleryFilterSet {
  const next = removeFilterDimension(filters, dimension);
  if (!filter || filter.type === "all") return next;
  return { ...next, ...singleFilterToSet(filter) };
}

export function removeFilterDimension(
  filters: GalleryFilterSet,
  dimension: GalleryFilterDimension,
): GalleryFilterSet {
  const next: GalleryFilterSet = { ...filters };
  delete next[dimension];
  return next;
}

export function hasActiveGalleryFilters(filters: GalleryFilterSet): boolean {
  return DIMENSION_ORDER.some((dim) => filterForDimension(filters, dim).type !== "all");
}

export function serializeFilter(filter: GalleryFilter): string {
  switch (filter.type) {
    case "all":
      return "all";
    case "wallpaper-order":
      return "wallpaper-order";
    case "no-album":
      return "no-album";
    case "plugin": {
      const id = encodeURIComponent(filter.pluginId.trim());
      const extendPath = providerPathSegment(filter.extendPath ?? "");
      return extendPath ? `plugin/${id}/extend/${extendPath}` : `plugin/${id}`;
    }
    case "date":
      return `date/${encodeDateSegment(filter.segment)}`;
    case "date-range":
      return `date-range/${filter.start}~${filter.end}`;
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
  }
}

export function serializeFilterSet(filters: GalleryFilterSet): string {
  const parts = DIMENSION_ORDER
    .map((dim) => filterForDimension(filters, dim))
    .filter((filter) => filter.type !== "all")
    .map(serializeFilter);
  return parts.join(`/${FILTER_COMB}/`);
}

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
  const base = dimension
    ? serializeFilterSet(removeFilterDimension(filters, dimension))
    : serializeFilterSet(filters);
  return base ? `${base}/${FILTER_COMB}/${segment}` : segment;
}

function dimensionForIncompletePathSegment(segment: string): GalleryFilterDimension | null {
  const parts = normalizePath(segment).split("/").filter(Boolean);
  const root = parts[0]?.toLowerCase();
  if ((root === "plugin" || root === "plugins") && (!parts[1] || parts[2] === "extend" && !parts[3])) {
    return "plugin";
  }
  if ((root === "media-type") && !parts[1]) return "mediaType";
  if ((root === "date" || root === "dates") && !parts[1]) return "date";
  if ((root === "name" || root === "names") && !parts[1]) return "name";
  if (root === "size" && !parts[1]) return "size";
  if ((root === "aspect" || root === "dimension" || root === "dimensions") && !parts[1]) {
    return "aspect";
  }
  return null;
}

function dimensionForPathSegment(segment: string): GalleryFilterDimension | null {
  const root = normalizePath(segment).split("/").filter(Boolean)[0]?.toLowerCase();
  switch (root) {
    case "wallpaper-order":
      return "wallpaperOrder";
    case "no-album":
      return "noAlbum";
    case "plugin":
    case "plugins":
      return "plugin";
    case "media-type":
      return "mediaType";
    case "date":
    case "dates":
    case "date-range":
      return "date";
    case "name":
    case "names":
      return "name";
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

export function buildGalleryPath(
  filtersOrFilter: GalleryFilterSet | GalleryFilter,
  sortOrOrder: GallerySort | GalleryStoredSort,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
  search: string = "",
  searchMode: GallerySearchMode = DEFAULT_GALLERY_SEARCH_MODE,
): string {
  return buildComposablePath({
    filters: filtersOrFilter,
    sort: sortOrOrder,
    page,
    pageSize,
    search,
    searchMode,
  });
}

export function buildGalleryCountPath(
  filtersOrFilter: GalleryFilterSet | GalleryFilter,
  search: string = "",
  searchMode: GallerySearchMode = DEFAULT_GALLERY_SEARCH_MODE,
  advanced?: GalleryAdvancedQuery,
): string {
  return buildComposableCountPath(
    "",
    filtersOrFilter,
    search,
    searchMode,
    advanced,
  );
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  return parseComposablePath(path, []);
}

export function parseFilter(root: string): GalleryFilter {
  const chunk = normalizePath(root).split("/").filter(Boolean);
  return parseDimensionChunk(chunk)?.filter ?? DEFAULT_GALLERY_FILTER;
}

export function galleryPathWithSortOnly(
  path: string,
  sort: GalleryTimeSort,
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(
    p.filters,
    { ...p.sort, desc: sort === "desc" },
    p.page,
    p.pageSize,
    p.search,
    p.searchMode,
  );
}

export function galleryPathWithFilterOnly(
  path: string,
  newFilter: GalleryFilter,
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(singleFilterToSet(newFilter), p.sort, 1, p.pageSize, p.search, p.searchMode);
}

export function galleryPathWithSearchOnly(
  path: string,
  search: string,
  searchMode?: GallerySearchMode,
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(p.filters, p.sort, 1, p.pageSize, search, searchMode ?? p.searchMode);
}

function parseBody(body: string[]): {
  filters: GalleryFilterSet;
  sortField?: GallerySortField;
  sortSeed?: string;
  legacyFilter?: GalleryFilter;
  advanced?: GalleryAdvancedQuery;
  search?: string;
  searchMode?: GallerySearchMode;
} {
  let queryBody = body;
  let filters: GalleryFilterSet = {};
  let contextSearch: string | undefined;
  let contextSearchMode: GallerySearchMode | undefined;

  if (queryBody[0] === "no-album" && queryBody[1] === FILTER_COMB) {
    filters.noAlbum = true;
    queryBody = queryBody.slice(2);

    // no-album 不属于树，因此紧随其后的 search 是全局随行上下文。
    const searchPrefix = splitLeadingSearchSegments(queryBody);
    if (searchPrefix.segments.length > 0) {
      contextSearchMode = searchPrefix.segments[1] as GallerySearchMode;
      contextSearch = decodePathSegment(searchPrefix.segments[2] ?? "");
      queryBody = searchPrefix.rest;
    }
  }

  if (
    queryBody.some((segment) =>
      segment === "~any" || segment === "~not" || segment === "~or" ||
      segment === "~end"
    )
  ) {
    const sortIndex = findAdvancedSortIndex(queryBody);
    const treeBody = queryBody.slice(
      0,
      sortIndex < 0 ? queryBody.length : sortIndex,
    );
    if (treeBody.at(-1) === FILTER_COMB) treeBody.pop();
    const advanced = parseAdvancedBody(treeBody);
    if (advanced) {
      const parsedSort = sortIndex < 0
        ? {}
        : parseSortChunk(queryBody.slice(sortIndex));
      return {
        filters,
        advanced,
        ...parsedSort,
        ...(contextSearch !== undefined ? { search: contextSearch } : {}),
        ...(contextSearchMode ? { searchMode: contextSearchMode } : {}),
      };
    }
    // 回退为空过滤而不是走老的平铺解析: 平铺解析会把组内维度摊平成简单过滤,
    // 展示出错误的部分语义。
    console.warn("无法解析画廊高级查询路径，已降级为空过滤");
    const parsedSort = sortIndex < 0
      ? {}
      : parseSortChunk(queryBody.slice(sortIndex));
    return {
      filters,
      ...parsedSort,
      ...(contextSearch !== undefined ? { search: contextSearch } : {}),
      ...(contextSearchMode ? { searchMode: contextSearchMode } : {}),
    };
  }

  let sortField: GallerySortField | undefined;
  let sortSeed: string | undefined;
  let legacyFilter: GalleryFilter | undefined;

  for (const chunk of splitFilterChunks(queryBody)) {
    if (chunk.length === 0) continue;
    const root = chunk[0]?.toLowerCase();
    if (root === "all") continue;
    if (root === "sort") {
      const field = chunk[1];
      const randomMatch = /^random-([0-9]{1,18})$/.exec(field ?? "");
      if (randomMatch) {
        sortField = "random";
        sortSeed = randomMatch[1];
      } else if (isGallerySortField(field)) {
        sortField = field;
      }
      continue;
    }
    const parsed = parseDimensionChunk(chunk);
    if (!parsed) continue;
    if (parsed.filter.type === "date-range") {
      legacyFilter = parsed.filter;
      continue;
    }
    filters = setFilterDimension(filters, parsed.dimension, parsed.filter);
  }

  return {
    filters,
    sortField,
    sortSeed,
    legacyFilter,
    ...(contextSearch !== undefined ? { search: contextSearch } : {}),
    ...(contextSearchMode ? { searchMode: contextSearchMode } : {}),
  };
}

function parseSortChunk(chunk: readonly string[]): {
  sortField?: GallerySortField;
  sortSeed?: string;
} {
  const field = chunk[1];
  const randomMatch = /^random-([0-9]{1,18})$/.exec(field ?? "");
  if (randomMatch) return { sortField: "random", sortSeed: randomMatch[1] };
  return isGallerySortField(field) ? { sortField: field } : {};
}

function findAdvancedSortIndex(body: readonly string[]): number {
  for (let index = body.length - 2; index >= 0; index--) {
    if (body[index] !== "sort") continue;
    const parsed = parseSortChunk(body.slice(index));
    if (parsed.sortField) return index;
  }
  return -1;
}

function splitFilterChunks(body: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const seg of body) {
    if (seg === FILTER_COMB) {
      chunks.push(current);
      current = [];
    } else {
      current.push(seg);
    }
  }
  chunks.push(current);
  return chunks;
}

export function parseDimensionChunk(
  chunk: readonly string[],
): { filter: GalleryFilter; dimension: GalleryFilterDimension } | null {
  const root = chunk[0]?.toLowerCase();
  if (!root || root === "all") return null;

  if (root === "wallpaper-order") {
    return { filter: { type: "wallpaper-order" }, dimension: "wallpaperOrder" };
  }

  if (root === "no-album") {
    return { filter: { type: "no-album" }, dimension: "noAlbum" };
  }

  if (root === "plugin" || root === "plugins") {
    const pluginId = decodePathSegment(chunk[1] ?? "").trim();
    if (!pluginId) return null;
    const extendIndex = chunk[2] === "extend" ? 3 : -1;
    const extendPath =
      extendIndex >= 0 ? chunk.slice(extendIndex).map(decodePathSegment).join("/") : "";
    return {
      filter: extendPath
        ? { type: "plugin", pluginId, extendPath: normalizePath(extendPath) }
        : { type: "plugin", pluginId },
      dimension: "plugin",
    };
  }

  if (root === "media-type") {
    const kind = chunk[1]?.toLowerCase();
    if (kind !== "image" && kind !== "video") return null;
    const format = decodePathSegment(chunk[2] ?? "").trim();
    return {
      filter: format ? { type: "media-type", kind, format } : { type: "media-type", kind },
      dimension: "mediaType",
    };
  }

  if (root === "date" || root === "dates") {
    const decoded = decodeDateSegments(chunk.slice(1));
    if (!decoded) return null;
    return { filter: { type: "date", segment: decoded.segment }, dimension: "date" };
  }

  if (root === "date-range") {
    const rangeSeg = chunk[1] ?? "";
    const tilde = rangeSeg.indexOf("~");
    if (tilde <= 0) return null;
    const start = rangeSeg.slice(0, tilde).trim();
    const end = rangeSeg.slice(tilde + 1).trim();
    if (!start || !end) return null;
    return { filter: { type: "date-range", start, end }, dimension: "date" };
  }

  if (root === "name" || root === "names") {
    const bucket = chunk[1]?.trim();
    return bucket ? { filter: { type: "name", bucket }, dimension: "name" } : null;
  }

  if (root === "size") {
    const range = chunk[1]?.trim();
    return range ? { filter: { type: "size", range }, dimension: "size" } : null;
  }

  if (root === "aspect" || root === "dimension" || root === "dimensions") {
    const range = chunk[1]?.trim();
    return range ? { filter: { type: "aspect", range }, dimension: "aspect" } : null;
  }

  return null;
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

function encodeDateSegment(segment: string): string {
  const [y, m, d] = segment.split("-");
  if (d) return `${y}y/${m}m/${d}d`;
  if (m) return `${y}y/${m}m`;
  return `${y}y`;
}

function decodeDateSegments(
  segs: readonly string[],
): { segment: string; consumed: number } | null {
  const y = segs[0]?.match(/^(\d{4})y$/)?.[1];
  if (!y) return null;
  const m = segs[1]?.match(/^(\d{2})m$/)?.[1];
  if (!m) return { segment: y, consumed: 1 };
  const d = segs[2]?.match(/^(\d{2})d$/)?.[1];
  if (!d) return { segment: `${y}-${m}`, consumed: 2 };
  return { segment: `${y}-${m}-${d}`, consumed: 3 };
}

function decodePathSegment(segment: string): string {
  if (!segment) return "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function hasEscapedSlash(segment: string): boolean {
  let backslashes = 0;
  for (let index = segment.length - 1; index >= 0 && segment[index] === "\\"; index--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function normalizePath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function providerPathSegment(path = "") {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function fromFilterLike(input: GalleryFilter | GalleryFilterSet): GalleryFilterSet {
  return isGalleryFilter(input) ? singleFilterToSet(input) : input;
}

export function filterPluginId(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.plugin?.pluginId ?? null;
}

export function filterDateSegment(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.date?.segment ?? null;
}

export function filterMediaKind(
  input: GalleryFilter | GalleryFilterSet,
): "image" | "video" | null {
  const f = fromFilterLike(input);
  return f.mediaType?.kind ?? null;
}

export function filterMediaFormat(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.mediaType?.format?.trim() || null;
}

export function filterNameBucket(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.name?.bucket ?? null;
}

export function filterSizeRange(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.size?.range ?? null;
}

export function filterAspectRange(input: GalleryFilter | GalleryFilterSet): string | null {
  const f = fromFilterLike(input);
  return f.aspect?.range ?? null;
}

export function filterNoAlbum(input: GalleryFilter | GalleryFilterSet): boolean {
  const f = fromFilterLike(input);
  return !!f.noAlbum;
}

export function isSimpleFilter(_f: GalleryFilter | GalleryFilterSet): boolean {
  return true;
}

export const DEFAULT_GALLERY_PATH = buildGalleryPath(
  DEFAULT_GALLERY_FILTER_SET,
  DEFAULT_SORT,
  DEFAULT_PAGE,
);
