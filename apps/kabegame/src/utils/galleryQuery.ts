import { decodeSeg, encodeSeg } from "@kabegame/pathql-client";

/**
 * GalleryQuery —— 画廊查询的唯一对象模型。
 *
 * 一个查询是一串节点（AND 序列）；节点要么是原子 `is`（一组维度取值的 AND，
 * 即 `GalleryFilterSet`，搜索也是其中一个维度），要么是组合器 `any`（OR 分支）/
 * `not`（取非），组合器的孩子仍是 `GalleryQuery`。旧的「简单过滤 FilterSet」与
 * 「高级查询树 AdvancedQuery」不再是两种状态：FilterSet 只是单原子查询的退化形态，
 * 用 `queryFromFilterSet` / `asSingleFilterSet` 在两种视图间投影。
 *
 * 本模块只关心查询体（维度 chunk、原子、树、`filter_comb`/`~` 组合器的序列化与
 * 解析），不关心排序 / 分页 / hide / no-album / 根前缀——那些是整条路径的事，
 * 在 `galleryPath.ts` 里基于本模块拼装。依赖方向恒为 galleryPath → galleryQuery。
 */

// ---------------------------------------------------------------------------
// 路径段编码
// ---------------------------------------------------------------------------

/** 用户数据 → 路径段：先 pathql 反斜线转义（逻辑层），再 percent（传输层）。
 *  后端边界解一次 percent，引擎解反斜线，各解各的。 */
export function encodeUserSegment(value: string): string {
  return encodeURIComponent(encodeSeg(value));
}

/** encodeUserSegment 的逆。无效 percent（旧逻辑形态的孤立 %）原样保留，再解反斜线。 */
export function decodeUserSegment(segment: string): string {
  let once = segment;
  try {
    once = decodeURIComponent(segment);
  } catch {
    /* 旧数据孤立 % → 原样 */
  }
  return decodeSeg(once);
}

function normalizePath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function providerPathSegment(path = "") {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeUserSegment)
    .join("/");
}

// ---------------------------------------------------------------------------
// 搜索维度
// ---------------------------------------------------------------------------

export type GallerySearchMode =
  | "display-name"
  | "metadata"
  | "native-metadata"
  | "local-path"
  | "url";

/** 下拉顺序：名称类三项在前（显示名 → 路径 → 链接），内容类元数据在后。 */
export const GALLERY_SEARCH_MODES: readonly GallerySearchMode[] = [
  "display-name",
  "local-path",
  "url",
  "metadata",
  "native-metadata",
];

/** 任务详情 / 畅游详情只暴露基础三项。 */
export const GALLERY_SEARCH_MODES_BASIC: readonly GallerySearchMode[] = [
  "display-name",
  "metadata",
  "native-metadata",
];

export const DEFAULT_GALLERY_SEARCH_MODE: GallerySearchMode = "display-name";

export function isGallerySearchMode(value: string | undefined): value is GallerySearchMode {
  return GALLERY_SEARCH_MODES.includes(value as GallerySearchMode);
}

export interface GallerySearchTerm {
  mode: GallerySearchMode;
  query: string;
}

// ---------------------------------------------------------------------------
// 查询对象
// ---------------------------------------------------------------------------

/**
 * 查询原子：各维度取值的 AND。搜索（`search`）与其它维度同级。
 * 单独一个 FilterSet 就是一条退化的 GalleryQuery（`[{ is: filters }]`）。
 * no-album 不在这里——它与 hide 一样是随行路由上下文，见 galleryPath.ts。
 */
export interface GalleryFilterSet {
  plugin?: { pluginId: string; extendPath?: string };
  mediaType?: { kind: "image" | "video"; format?: string };
  date?: { segment: string };
  size?: { range: string };
  aspect?: { range: string };
  search?: GallerySearchTerm;
}

export type GalleryQueryNode =
  | { is: GalleryFilterSet }
  | { any: GalleryQuery[] }
  | { not: GalleryQuery };

export type GalleryQuery = GalleryQueryNode[];

/** 维度键从查询原子派生；`search` 也是一个维度。 */
export type GalleryFilterDimension = keyof GalleryFilterSet;

/** chip / 树可浏览的维度（搜索有独立的输入组件，不在此列）。 */
export type GalleryBrowseDimension = Exclude<GalleryFilterDimension, "search">;

/**
 * 每个序列先取节点索引；进入 any 时再取 `[branchIndex, nodeIndex]`，
 * 进入 not 时再取 `[nodeIndex]`，随后按同一规则递归。
 */
export type NodePath = number[];

export const MAX_GROUP_DEPTH = 3;

export const DIMENSION_ORDER: GalleryBrowseDimension[] = [
  "plugin",
  "mediaType",
  "date",
  "size",
  "aspect",
];

// ---------------------------------------------------------------------------
// 单维度取值（chip 行 / 树面板用的 per-dimension 值对象）
// ---------------------------------------------------------------------------

export type GalleryFilter =
  | { type: "all" }
  | { type: "plugin"; pluginId: string; extendPath?: string }
  | { type: "date"; segment: string }
  | { type: "date-range"; start: string; end: string }
  | { type: "media-type"; kind: "image" | "video"; format?: string }
  | { type: "size"; range: string }
  | { type: "aspect"; range: string };

export const DEFAULT_GALLERY_FILTER: GalleryFilter = { type: "all" };
export const DEFAULT_GALLERY_FILTER_SET: GalleryFilterSet = {};

export const GALLERY_ASPECT_BUCKETS = [
  { range: "landscape-4x3-16x9", labelKey: "filterAspect_landscape" },
  { range: "widescreen-16x9-21x9", labelKey: "filterAspect_widescreen" },
  { range: "square-3x4-4x3", labelKey: "filterAspect_square" },
  { range: "portrait-9x16-3x4", labelKey: "filterAspect_portrait" },
  { range: "other", labelKey: "filterAspect_other" },
] as const;

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
  dimension: GalleryBrowseDimension,
): GalleryFilter {
  switch (dimension) {
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
  dimension: GalleryBrowseDimension,
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

function hasSearch(atom: GalleryFilterSet): boolean {
  return !!atom.search?.query.trim();
}

function hasDimension(
  atom: GalleryFilterSet,
  dimension: GalleryBrowseDimension,
): boolean {
  return filterForDimension(atom, dimension).type !== "all";
}

function isEmptyAtom(atom: GalleryFilterSet): boolean {
  return !hasSearch(atom) &&
    !DIMENSION_ORDER.some((dimension) => hasDimension(atom, dimension));
}

/** FilterSet 是否有任何生效条件（含搜索）。 */
export function hasActiveGalleryFilters(filters: GalleryFilterSet): boolean {
  return !isEmptyAtom(filters);
}

// ---------- per-dimension 取值便捷访问 ----------

function fromFilterLike(input: GalleryFilter | GalleryFilterSet): GalleryFilterSet {
  return isGalleryFilter(input) ? singleFilterToSet(input) : input;
}

function isGalleryFilter(value: GalleryFilter | GalleryFilterSet): value is GalleryFilter {
  return typeof (value as GalleryFilter).type === "string";
}

export function filterPluginId(input: GalleryFilter | GalleryFilterSet): string | null {
  return fromFilterLike(input).plugin?.pluginId ?? null;
}

export function filterDateSegment(input: GalleryFilter | GalleryFilterSet): string | null {
  return fromFilterLike(input).date?.segment ?? null;
}

export function filterMediaKind(
  input: GalleryFilter | GalleryFilterSet,
): "image" | "video" | null {
  return fromFilterLike(input).mediaType?.kind ?? null;
}

export function filterMediaFormat(input: GalleryFilter | GalleryFilterSet): string | null {
  return fromFilterLike(input).mediaType?.format?.trim() || null;
}

export function filterSizeRange(input: GalleryFilter | GalleryFilterSet): string | null {
  return fromFilterLike(input).size?.range ?? null;
}

export function filterAspectRange(input: GalleryFilter | GalleryFilterSet): string | null {
  return fromFilterLike(input).aspect?.range ?? null;
}

// ---------------------------------------------------------------------------
// 查询 ←→ FilterSet 投影
// ---------------------------------------------------------------------------

function normalizeAtom(atom: GalleryFilterSet): GalleryFilterSet {
  const normalized: GalleryFilterSet = {};
  for (const dimension of DIMENSION_ORDER) {
    if (hasDimension(atom, dimension)) {
      Object.assign(normalized, { [dimension]: atom[dimension] });
    }
  }
  if (hasSearch(atom)) normalized.search = { ...atom.search! };
  return normalized;
}

/** FilterSet → 退化查询：空集为 `[]`，否则单原子一行。 */
export function queryFromFilterSet(filters: GalleryFilterSet): GalleryQuery {
  return normalizeQuery([{ is: filters }]);
}

/**
 * 逆投影：能被单原子（无 `any` / `not`、无多行）完整表达的查询 → FilterSet。
 * 表达不了返回 null；空查询返回 `{}`。chip 行 / 简单过滤视图据此渲染。
 */
export function asSingleFilterSet(query: GalleryQuery): GalleryFilterSet | null {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return {};
  if (normalized.length > 1) return null;
  const node = normalized[0]!;
  if (!isIsNode(node)) return null;
  return node.is;
}

/** 查询里第一个搜索词（DFS）；用于会话记忆搜索模式等 UI 兜底。 */
export function querySearchTerm(query: GalleryQuery): GallerySearchTerm | null {
  for (const node of query) {
    if (isIsNode(node)) {
      if (hasSearch(node.is)) return node.is.search!;
    } else if (isAnyNode(node)) {
      for (const branch of node.any) {
        const found = querySearchTerm(branch);
        if (found) return found;
      }
    } else {
      const found = querySearchTerm(node.not);
      if (found) return found;
    }
  }
  return null;
}

/** 查询的任意原子是否用到了某维度（surface 刷新启发式用）。 */
export function queryUsesDimension(
  query: GalleryQuery,
  dimension: GalleryFilterDimension,
): boolean {
  return query.some((node) => {
    if (isIsNode(node)) {
      return dimension === "search"
        ? hasSearch(node.is)
        : hasDimension(node.is, dimension);
    }
    if (isAnyNode(node)) {
      return node.any.some((branch) => queryUsesDimension(branch, dimension));
    }
    return queryUsesDimension(node.not, dimension);
  });
}

// ---------------------------------------------------------------------------
// 归一化与树操作
// ---------------------------------------------------------------------------

function isIsNode(node: GalleryQueryNode): node is { is: GalleryFilterSet } {
  return "is" in node;
}

function isAnyNode(
  node: GalleryQueryNode,
): node is { any: GalleryQuery[] } {
  return "any" in node;
}

function mergeAtoms(
  left: GalleryFilterSet,
  right: GalleryFilterSet,
): GalleryFilterSet | null {
  if (hasSearch(left) && hasSearch(right)) return null;
  if (
    DIMENSION_ORDER.some((dimension) =>
      hasDimension(left, dimension) && hasDimension(right, dimension)
    )
  ) {
    return null;
  }
  const merged = { ...left };
  for (const dimension of DIMENSION_ORDER) {
    if (hasDimension(right, dimension)) {
      Object.assign(merged, { [dimension]: right[dimension] });
    }
  }
  if (hasSearch(right)) merged.search = right.search;
  return merged;
}

function normalizeSequence(sequence: GalleryQuery): GalleryQuery {
  const normalized: GalleryQuery = [];

  for (const node of sequence) {
    let next: GalleryQueryNode | null;
    if (isIsNode(node)) {
      next = isEmptyAtom(node.is) ? null : { is: normalizeAtom(node.is) };
    } else if (isAnyNode(node)) {
      const branches = node.any.map(normalizeSequence).filter((branch) =>
        branch.length > 0
      );
      next = branches.length > 0 ? { any: branches } : null;
    } else {
      const childSequence = normalizeSequence(node.not);
      next = childSequence.length > 0 ? { not: childSequence } : null;
    }
    if (!next) continue;

    const previous = normalized.at(-1);
    if (previous && isIsNode(previous) && isIsNode(next)) {
      const merged = mergeAtoms(previous.is, next.is);
      if (merged) {
        normalized[normalized.length - 1] = { is: merged };
      } else {
        normalized.push({ any: [[next]] });
      }
      continue;
    }
    normalized.push(next);
  }

  return normalized;
}

export function normalizeQuery(query: GalleryQuery): GalleryQuery {
  return normalizeSequence(query);
}

export function isEmptyQuery(query: GalleryQuery): boolean {
  return normalizeQuery(query).length === 0;
}

/** 查询是否有任何生效条件。`isEmptyQuery` 的语义反面，读起来更顺。 */
export function hasActiveQuery(query: GalleryQuery): boolean {
  return !isEmptyQuery(query);
}

export function conditionCount(query: GalleryQuery): number {
  let count = 0;
  const visit = (sequence: GalleryQuery) => {
    for (const node of sequence) {
      if (isIsNode(node)) count += 1;
      else if (isAnyNode(node)) node.any.forEach(visit);
      else visit(node.not);
    }
  };
  visit(query);
  return count;
}

interface NodeLocation {
  node: GalleryQueryNode;
  notDepth: number;
}

function locateNode(query: GalleryQuery, path: NodePath): NodeLocation {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  let sequence = query;
  let position = 0;
  let notDepth = 0;

  while (position < path.length) {
    const nodeIndex = path[position++]!;
    const node = sequence[nodeIndex];
    if (!node) throw new Error(`无效 NodePath: ${path.join(".")}`);
    if (position === path.length) return { node, notDepth };

    if (isAnyNode(node)) {
      const branchIndex = path[position++]!;
      const branch = node.any[branchIndex];
      if (!branch || position >= path.length) {
        throw new Error(`无效 NodePath: ${path.join(".")}`);
      }
      sequence = branch;
    } else if ("not" in node) {
      notDepth += 1;
      sequence = node.not;
    } else {
      throw new Error(`NodePath 穿过了原子节点: ${path.join(".")}`);
    }
  }

  throw new Error(`无效 NodePath: ${path.join(".")}`);
}

export function getNode(
  query: GalleryQuery,
  path: NodePath,
): GalleryQueryNode {
  return locateNode(query, path).node;
}

export function notParity(
  query: GalleryQuery,
  nodePath: NodePath,
): boolean {
  return locateNode(query, nodePath).notDepth % 2 === 1;
}

function updateInSequence(
  sequence: GalleryQuery,
  path: NodePath,
  position: number,
  fn: (node: GalleryQueryNode) => GalleryQueryNode,
): GalleryQuery {
  const nodeIndex = path[position];
  const node = nodeIndex === undefined ? undefined : sequence[nodeIndex];
  if (nodeIndex === undefined || !node) {
    throw new Error(`无效 NodePath: ${path.join(".")}`);
  }

  const nextSequence = [...sequence];
  if (position === path.length - 1) {
    nextSequence[nodeIndex] = fn(cloneQuery([node])[0]!);
    return nextSequence;
  }

  if (isAnyNode(node)) {
    const branchIndex = path[position + 1];
    const branch = branchIndex === undefined
      ? undefined
      : node.any[branchIndex];
    if (!branch || position + 2 >= path.length) {
      throw new Error(`无效 NodePath: ${path.join(".")}`);
    }
    const branches = [...node.any];
    branches[branchIndex] = updateInSequence(branch, path, position + 2, fn);
    nextSequence[nodeIndex] = { any: branches };
  } else if ("not" in node) {
    nextSequence[nodeIndex] = {
      not: updateInSequence(node.not, path, position + 1, fn),
    };
  } else {
    throw new Error(`NodePath 穿过了原子节点: ${path.join(".")}`);
  }
  return nextSequence;
}

export function updateNode(
  query: GalleryQuery,
  path: NodePath,
  fn: (node: GalleryQueryNode) => GalleryQueryNode,
): GalleryQuery {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  return updateInSequence(query, path, 0, fn);
}

function removeFromSequence(
  sequence: GalleryQuery,
  path: NodePath,
  position: number,
): GalleryQuery {
  const nodeIndex = path[position];
  const node = nodeIndex === undefined ? undefined : sequence[nodeIndex];
  if (nodeIndex === undefined || !node) {
    throw new Error(`无效 NodePath: ${path.join(".")}`);
  }

  if (position === path.length - 1) {
    return sequence.filter((_, index) => index !== nodeIndex);
  }

  const nextSequence = [...sequence];
  if (isAnyNode(node)) {
    const branchIndex = path[position + 1];
    const branch = branchIndex === undefined
      ? undefined
      : node.any[branchIndex];
    if (!branch || position + 2 >= path.length) {
      throw new Error(`无效 NodePath: ${path.join(".")}`);
    }
    const branches = [...node.any];
    branches[branchIndex] = removeFromSequence(branch, path, position + 2);
    nextSequence[nodeIndex] = { any: branches };
  } else if ("not" in node) {
    nextSequence[nodeIndex] = {
      not: removeFromSequence(node.not, path, position + 1),
    };
  } else {
    throw new Error(`NodePath 穿过了原子节点: ${path.join(".")}`);
  }
  return nextSequence;
}

export function removeNode(
  query: GalleryQuery,
  path: NodePath,
): GalleryQuery {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  return removeFromSequence(query, path, 0);
}

export function cloneQuery(query: GalleryQuery): GalleryQuery {
  return query.map((node) => {
    if (isIsNode(node)) {
      return {
        is: {
          ...node.is,
          ...(node.is.plugin ? { plugin: { ...node.is.plugin } } : {}),
          ...(node.is.mediaType ? { mediaType: { ...node.is.mediaType } } : {}),
          ...(node.is.date ? { date: { ...node.is.date } } : {}),
          ...(node.is.size ? { size: { ...node.is.size } } : {}),
          ...(node.is.aspect ? { aspect: { ...node.is.aspect } } : {}),
          ...(node.is.search ? { search: { ...node.is.search } } : {}),
        },
      };
    }
    if (isAnyNode(node)) return { any: node.any.map(cloneQuery) };
    return { not: cloneQuery(node.not) };
  });
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

export const FILTER_COMB = "filter_comb";

/**
 * 查询体片段：`endsAtHub` 表示 body 结束在 gallery 枢纽（search 与 `~end` 都会
 * 委派回枢纽），后接片段直接用 `/`；否则要经 `/filter_comb/` 回枢纽。
 */
export interface QueryBodyPart {
  body: string;
  endsAtHub: boolean;
}

/** 依 endsAtHub 语义拼接两个查询体片段，空片段自动跳过。 */
export function appendQueryBodyPart(
  current: QueryBodyPart,
  next: QueryBodyPart,
): QueryBodyPart {
  if (!next.body) return current;
  if (!current.body) return next;
  return {
    body: `${current.body}${
      current.endsAtHub ? "/" : `/${FILTER_COMB}/`
    }${next.body}`,
    endsAtHub: next.endsAtHub,
  };
}

export function serializeFilter(filter: GalleryFilter): string {
  switch (filter.type) {
    case "all":
      return "all";
    case "plugin": {
      const id = encodeUserSegment(filter.pluginId.trim());
      const extendPath = providerPathSegment(filter.extendPath ?? "");
      return extendPath ? `plugin/${id}/extend/${extendPath}` : `plugin/${id}`;
    }
    case "date":
      return `date/${encodeDateSegment(filter.segment)}`;
    case "date-range":
      return `date-range/${filter.start}~${filter.end}`;
    case "media-type":
      return filter.format
        ? `media-type/${filter.kind}/${encodeUserSegment(filter.format)}`
        : `media-type/${filter.kind}`;
    case "size":
      return `size/${filter.range}`;
    case "aspect":
      return `aspect/${filter.range}`;
  }
}

/**
 * 原子 → 查询体片段。搜索段在最前：它结束在枢纽（后续维度直接用 `/` 接上），
 * 且与旧「搜索前缀 + 简单过滤」的路径形态逐字节一致，存量 URL / localStorage
 * 不需要迁移。
 */
function serializeAtom(atom: GalleryFilterSet): QueryBodyPart {
  let result: QueryBodyPart = { body: "", endsAtHub: true };
  if (hasSearch(atom)) {
    result = {
      body: `search/${atom.search!.mode}/${encodeUserSegment(atom.search!.query)}`,
      endsAtHub: true,
    };
  }
  for (const dimension of DIMENSION_ORDER) {
    const filter = filterForDimension(atom, dimension);
    if (filter.type === "all") continue;
    result = appendQueryBodyPart(result, {
      body: serializeFilter(filter),
      endsAtHub: false,
    });
  }
  return result;
}

function serializeSequence(sequence: GalleryQuery): QueryBodyPart {
  let result: QueryBodyPart = { body: "", endsAtHub: true };
  for (const node of sequence) {
    let serialized: QueryBodyPart;
    if (isIsNode(node)) {
      serialized = serializeAtom(node.is);
    } else if (isAnyNode(node)) {
      serialized = {
        body: `~any/${
          node.any.map((branch) => serializeSequence(branch).body).join("/~or/")
        }/~end`,
        endsAtHub: true,
      };
    } else {
      serialized = {
        body: `~not/${serializeSequence(node.not).body}/~end`,
        endsAtHub: true,
      };
    }
    result = appendQueryBodyPart(result, serialized);
  }
  return result;
}

/** 查询 → 体片段。空查询返回空 body（是否回退 `all` 由调用方决定）。 */
export function serializeQueryBody(query: GalleryQuery): QueryBodyPart {
  return serializeSequence(normalizeQuery(query));
}

/** FilterSet → 体串（含搜索段，hub 语义拼接）。空集返回空串。 */
export function serializeFilterSet(filters: GalleryFilterSet): string {
  return serializeAtom(filters).body;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

// legacy 兼容：旧版高级树在 localStorage 里以 encodeSeg 直存（段内有裸 `\/`
// 被盲切），对新形态（双层编码后段内不再有裸 `/`）退化为恒等。
function hasEscapedSlash(segment: string): boolean {
  let backslashes = 0;
  for (
    let index = segment.length - 1;
    index >= 0 && segment[index] === "\\";
    index--
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function joinEscapedSegments(segments: readonly string[]): string[] {
  const joined: string[] = [];
  for (const segment of segments) {
    const previous = joined.at(-1);
    if (previous !== undefined && hasEscapedSlash(previous)) {
      joined[joined.length - 1] = `${previous}/${segment}`;
    } else {
      joined.push(segment);
    }
  }
  return joined;
}

function chunkEnd(segments: readonly string[], start: number): number {
  let end = start;
  while (
    end < segments.length && segments[end] !== FILTER_COMB &&
    !segments[end]!.startsWith("~")
  ) {
    end += 1;
  }
  return end;
}

function appendAtom(
  sequence: GalleryQuery,
  dimension: GalleryFilterDimension,
  atom: GalleryFilterSet,
): void {
  const previous = sequence.at(-1);
  const occupied = previous && isIsNode(previous) && (
    dimension === "search"
      ? hasSearch(previous.is)
      : hasDimension(previous.is, dimension)
  );
  if (previous && isIsNode(previous) && !occupied) {
    previous.is = { ...previous.is, ...atom };
  } else {
    sequence.push({ is: atom });
  }
}

function parseSequence(
  segments: readonly string[],
  start: number,
  stopAtGroupBoundary: boolean,
): { sequence: GalleryQuery; position: number } | null {
  const sequence: GalleryQuery = [];
  let position = start;

  while (position < segments.length) {
    const segment = segments[position]!;
    if (segment === FILTER_COMB) {
      position += 1;
      continue;
    }
    if (segment === "~or" || segment === "~end") {
      return stopAtGroupBoundary ? { sequence, position } : null;
    }
    if (segment === "~any") {
      const branches: GalleryQuery[] = [];
      position += 1;
      while (true) {
        const branch = parseSequence(segments, position, true);
        if (!branch) return null;
        // 空分支在引擎语义里是恒真(OR 恒真 = 全集), 树上无法表达 —— 整体回退,
        // 不能剪掉后静默反转语义。
        if (branch.sequence.length === 0) return null;
        branches.push(branch.sequence);
        position = branch.position;
        if (segments[position] === "~or") {
          position += 1;
          continue;
        }
        if (segments[position] !== "~end") return null;
        position += 1;
        break;
      }
      sequence.push({ any: branches });
      continue;
    }
    if (segment === "~not") {
      const child = parseSequence(segments, position + 1, true);
      if (!child || segments[child.position] !== "~end") return null;
      // 空 ~not = NOT(恒真) = 空集, 同样不可静默丢弃。
      if (child.sequence.length === 0) return null;
      sequence.push({ not: child.sequence });
      position = child.position + 1;
      continue;
    }
    if (segment.startsWith("~")) return null;
    if (segment === "all") {
      position += 1;
      continue;
    }
    if (segment === "search") {
      const mode = segments[position + 1];
      const query = segments[position + 2];
      if (!isGallerySearchMode(mode) || query === undefined) return null;
      appendAtom(sequence, "search", {
        search: { mode, query: decodeUserSegment(query) },
      });
      position += 3;
      continue;
    }

    const end = chunkEnd(segments, position);
    const parsed = parseDimensionChunk(segments.slice(position, end));
    if (!parsed || parsed.filter.type === "date-range") {
      // 识别不了 / 树上无法表达的维度 chunk: 整体回退而非静默丢弃 —— 丢弃会让
      // 写回的路径悄悄少一个谓词。
      return null;
    }
    appendAtom(sequence, parsed.dimension, singleFilterToSet(parsed.filter));
    position = Math.max(position + 1, end);
  }

  return stopAtGroupBoundary ? null : { sequence, position };
}

/**
 * 查询体路径段 → GalleryQuery。平铺维度 chunk、搜索段、`~` 组合器统一处理；
 * 无法整体解析时返回 null（调用方决定回退语义，不做部分解析）。
 */
export function parseQueryBody(segs: readonly string[]): GalleryQuery | null {
  const segments = joinEscapedSegments(segs);
  const parsed = parseSequence(segments, 0, false);
  if (!parsed || parsed.position !== segments.length) return null;
  return normalizeQuery(parsed.sequence);
}

export function parseDimensionChunk(
  chunk: readonly string[],
): { filter: GalleryFilter; dimension: GalleryBrowseDimension } | null {
  const root = chunk[0]?.toLowerCase();
  if (!root || root === "all") return null;

  if (root === "plugin" || root === "plugins") {
    const pluginId = decodeUserSegment(chunk[1] ?? "").trim();
    if (!pluginId) return null;
    const extendIndex = chunk[2] === "extend" ? 3 : -1;
    const extendPath =
      extendIndex >= 0 ? chunk.slice(extendIndex).map(decodeUserSegment).join("/") : "";
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
    const format = decodeUserSegment(chunk[2] ?? "").trim();
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
