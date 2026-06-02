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
  | "by-set-time";

export interface GallerySort {
  field: GallerySortField;
  desc: boolean;
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

export interface ParsedGalleryPath {
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
  /** Compatibility for compact/legacy controls: first selected dimension or all. */
  filter: GalleryFilter;
}

const SEARCH_PREFIX = "search/display-name/";
const FILTER_COMB = "filter_comb";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SORT: GalleryStoredSort = "";

export const DEFAULT_GALLERY_FILTER: GalleryFilter = { type: "all" };
export const DEFAULT_GALLERY_FILTER_SET: GalleryFilterSet = {};
export const DEFAULT_GALLERY_SORT: GallerySort = { field: "by-time", desc: false };

const DIMENSION_ORDER: GalleryFilterDimension[] = [
  "wallpaperOrder",
  "noAlbum",
  "plugin",
  "mediaType",
  "date",
  "name",
  "size",
  "aspect",
];

export function buildGalleryContextPrefix(search: string | undefined): string {
  const q = (search ?? "").trim();
  return q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
}

function stripSearchPrefix(segs: string[]): { search: string; rest: string[] } {
  if (segs.length >= 3 && segs[0] === "search" && segs[1] === "display-name") {
    const raw = segs[2] ?? "";
    return { search: decodePathSegment(raw), rest: segs.slice(3) };
  }
  return { search: "", rest: segs };
}

function isGalleryFilter(value: GalleryFilter | GalleryFilterSet): value is GalleryFilter {
  return typeof (value as GalleryFilter).type === "string";
}

export function normalizeGallerySort(
  sort: GallerySort | GalleryStoredSort | undefined,
): GallerySort {
  if (sort && typeof sort === "object") {
    return {
      field: isGallerySortField(sort.field) ? sort.field : "by-time",
      desc: !!sort.desc,
    };
  }
  return { field: "by-time", desc: sort === "desc" };
}

function isGallerySortField(field: string | undefined): field is GallerySortField {
  return (
    field === "by-id" ||
    field === "by-time" ||
    field === "by-size" ||
    field === "by-name" ||
    field === "by-aspect" ||
    field === "by-set-time"
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
): string {
  const filters = isGalleryFilter(filtersOrFilter)
    ? singleFilterToSet(filtersOrFilter)
    : filtersOrFilter;
  const sort = normalizeGallerySort(sortOrOrder);
  const filterPath = serializeFilterSet(filters);
  const bodyParts: string[] = [];

  if (filterPath) bodyParts.push(filterPath);
  if (sort.field !== "by-time") {
    bodyParts.push(`sort/${sort.field}`);
  }

  const body = bodyParts.length ? bodyParts.join(`/${FILTER_COMB}/`) : "all";
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const ps = pageSize === DEFAULT_PAGE_SIZE ? "" : `x${pageSize}x/`;
  const q = (search ?? "").trim();
  const prefix = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
  return sort.desc ? `${prefix}${body}/desc/${ps}${p}` : `${prefix}${body}/${ps}${p}`;
}

export function buildGalleryCountPath(
  filtersOrFilter: GalleryFilterSet | GalleryFilter,
  search: string = "",
): string {
  const filters = isGalleryFilter(filtersOrFilter)
    ? singleFilterToSet(filtersOrFilter)
    : filtersOrFilter;
  const q = (search ?? "").trim();
  const prefix = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
  return `${prefix}${buildFilterSetCountPath(filters)}`;
}

export function parseGalleryPath(path: string): ParsedGalleryPath {
  const base: ParsedGalleryPath = {
    filters: {},
    filter: DEFAULT_GALLERY_FILTER,
    sort: DEFAULT_GALLERY_SORT,
    page: DEFAULT_PAGE,
    pageSize: DEFAULT_PAGE_SIZE,
    search: "",
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  const rawSegs = trimmed.split("/").filter(Boolean);
  if (rawSegs.length === 0) return base;

  const { search, rest: segs } = stripSearchPrefix(rawSegs);
  if (segs.length === 0) return { ...base, search };

  const { body, tail } = splitBodyAndTail(segs);
  const { sort: order, pageSize, page } = parseTail(tail);
  const { filters, sortField, legacyFilter } = parseBody(body);
  const sort: GallerySort = {
    field: sortField ?? "by-time",
    desc: order === "desc",
  };
  const filter = legacyFilter ?? filterSetToSingleFilter(filters);
  return { filters, filter, sort, page, pageSize, search };
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
  );
}

export function galleryPathWithFilterOnly(
  path: string,
  newFilter: GalleryFilter,
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(singleFilterToSet(newFilter), p.sort, 1, p.pageSize, p.search);
}

export function galleryPathWithSearchOnly(
  path: string,
  search: string,
): string {
  const p = parseGalleryPath(path);
  return buildGalleryPath(p.filters, p.sort, 1, p.pageSize, search);
}

function parseBody(body: string[]): {
  filters: GalleryFilterSet;
  sortField?: GallerySortField;
  legacyFilter?: GalleryFilter;
} {
  let filters: GalleryFilterSet = {};
  let sortField: GallerySortField | undefined;
  let legacyFilter: GalleryFilter | undefined;

  for (const chunk of splitFilterChunks(body)) {
    if (chunk.length === 0) continue;
    const root = chunk[0]?.toLowerCase();
    if (root === "all") continue;
    if (root === "sort") {
      const field = chunk[1];
      if (isGallerySortField(field)) sortField = field;
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

  return { filters, sortField, legacyFilter };
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

function parseDimensionChunk(
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
