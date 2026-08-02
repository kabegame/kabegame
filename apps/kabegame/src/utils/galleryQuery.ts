import { decodeSeg, encodeSeg } from "@kabegame/pathql-client";

import {
  DIMENSION_ORDER,
  filterForDimension,
  type GalleryFilterDimension,
  type GalleryFilterSet,
  type GallerySearchMode,
  isGallerySearchMode,
  parseDimensionChunk,
  serializeFilter,
  singleFilterToSet,
} from "./galleryPath.ts";

export interface GalleryAtomSearch {
  mode: GallerySearchMode;
  query: string;
}

export type GalleryAtom = Omit<GalleryFilterSet, "noAlbum"> & {
  search?: GalleryAtomSearch;
};

export type GalleryQueryNode =
  | { is: GalleryAtom }
  | { any: GalleryQueryNode[][] }
  | { not: GalleryQueryNode[] };

export type GalleryAdvancedQuery = GalleryQueryNode[];
/**
 * 每个序列先取节点索引；进入 any 时再取 `[branchIndex, nodeIndex]`，
 * 进入 not 时再取 `[nodeIndex]`，随后按同一规则递归。
 */
export type NodePath = number[];
export type GalleryAtomDimension =
  | Exclude<GalleryFilterDimension, "noAlbum">
  | "search";

export const MAX_GROUP_DEPTH = 3;

let cachedAtomDimensions:
  | Exclude<GalleryFilterDimension, "noAlbum">[]
  | undefined;

function atomDimensions(): Exclude<GalleryFilterDimension, "noAlbum">[] {
  return cachedAtomDimensions ??= DIMENSION_ORDER.filter(
    (dimension): dimension is Exclude<GalleryFilterDimension, "noAlbum"> =>
      dimension !== "noAlbum",
  );
}

function isIsNode(node: GalleryQueryNode): node is { is: GalleryAtom } {
  return "is" in node;
}

function isAnyNode(
  node: GalleryQueryNode,
): node is { any: GalleryQueryNode[][] } {
  return "any" in node;
}

function hasSearch(atom: GalleryAtom): boolean {
  return !!atom.search?.query;
}

function hasDimension(
  atom: GalleryAtom,
  dimension: Exclude<GalleryFilterDimension, "noAlbum">,
): boolean {
  return filterForDimension(atom, dimension).type !== "all";
}

function isEmptyAtom(atom: GalleryAtom): boolean {
  return !hasSearch(atom) &&
    !atomDimensions().some((dimension) => hasDimension(atom, dimension));
}

function normalizeAtom(atom: GalleryAtom): GalleryAtom {
  const normalized: GalleryAtom = {};
  for (const dimension of atomDimensions()) {
    if (hasDimension(atom, dimension)) {
      Object.assign(normalized, { [dimension]: atom[dimension] });
    }
  }
  if (hasSearch(atom)) normalized.search = { ...atom.search! };
  return normalized;
}

function mergeAtoms(left: GalleryAtom, right: GalleryAtom): GalleryAtom | null {
  if (hasSearch(left) && hasSearch(right)) return null;
  if (
    atomDimensions().some((dimension) =>
      hasDimension(left, dimension) && hasDimension(right, dimension)
    )
  ) {
    return null;
  }
  const merged = { ...left };
  for (const dimension of atomDimensions()) {
    if (hasDimension(right, dimension)) {
      Object.assign(merged, { [dimension]: right[dimension] });
    }
  }
  if (hasSearch(right)) merged.search = right.search;
  return merged;
}

function normalizeSequence(sequence: GalleryQueryNode[]): GalleryQueryNode[] {
  const normalized: GalleryQueryNode[] = [];

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

export function normalizeQuery(
  tree: GalleryAdvancedQuery,
): GalleryAdvancedQuery {
  return normalizeSequence(tree);
}

/** 将工具栏简单过滤（含搜索）复制为高级查询首行；noAlbum 是随行上下文，不进入树。 */
export function advancedQueryFromSimpleFilters(
  filters: GalleryFilterSet,
  search?: GalleryAtomSearch | null,
): GalleryAdvancedQuery {
  const atom: GalleryAtom = {};
  if (search?.query.trim()) atom.search = { ...search };
  if (filters.wallpaperOrder) atom.wallpaperOrder = true;
  if (filters.plugin?.pluginId) {
    atom.plugin = { pluginId: filters.plugin.pluginId };
    if (filters.plugin.extendPath?.trim()) {
      console.warn(
        `[advanced-query] plugin extendPath 不受查询树支持，已仅保留 pluginId: ${filters.plugin.pluginId}`,
      );
    }
  }
  if (filters.mediaType) atom.mediaType = { ...filters.mediaType };
  if (filters.date) atom.date = { ...filters.date };
  if (filters.name) atom.name = { ...filters.name };
  if (filters.size) atom.size = { ...filters.size };
  if (filters.aspect) atom.aspect = { ...filters.aspect };
  return [{ is: atom }];
}

/**
 * 逆向：能被工具栏简单过滤完整表达的查询树 → 简单过滤 + 搜索。
 * 「简单」= 归一化后至多一个 `is` 节点（无 `any` / `not`），因为简单过滤行只能表达
 * 各维度取值的 AND。表达不了就返回 null，调用方据此决定是否清空。
 */
export function simpleFiltersFromAdvancedQuery(
  tree: GalleryAdvancedQuery,
): { filters: GalleryFilterSet; search: GalleryAtomSearch | null } | null {
  const normalized = normalizeQuery(tree);
  if (normalized.length === 0) return { filters: {}, search: null };
  if (normalized.length > 1) return null;

  const node = normalized[0]!;
  if (!isIsNode(node)) return null;

  const { search, ...filters } = node.is;
  // extendPath 只存在于简单过滤侧（树不支持），这里不会出现，无需特殊处理。
  return { filters: filters as GalleryFilterSet, search: search ?? null };
}

export function isEmptyQuery(tree: GalleryAdvancedQuery): boolean {
  return normalizeQuery(tree).length === 0;
}

export function conditionCount(tree: GalleryAdvancedQuery): number {
  let count = 0;
  const visit = (sequence: GalleryQueryNode[]) => {
    for (const node of sequence) {
      if (isIsNode(node)) count += 1;
      else if (isAnyNode(node)) node.any.forEach(visit);
      else visit(node.not);
    }
  };
  visit(tree);
  return count;
}

interface NodeLocation {
  node: GalleryQueryNode;
  notDepth: number;
}

function locateNode(tree: GalleryAdvancedQuery, path: NodePath): NodeLocation {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  let sequence = tree;
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
  tree: GalleryAdvancedQuery,
  path: NodePath,
): GalleryQueryNode {
  return locateNode(tree, path).node;
}

export function notParity(
  tree: GalleryAdvancedQuery,
  nodePath: NodePath,
): boolean {
  return locateNode(tree, nodePath).notDepth % 2 === 1;
}

function updateInSequence(
  sequence: GalleryQueryNode[],
  path: NodePath,
  position: number,
  fn: (node: GalleryQueryNode) => GalleryQueryNode,
): GalleryQueryNode[] {
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
  tree: GalleryAdvancedQuery,
  path: NodePath,
  fn: (node: GalleryQueryNode) => GalleryQueryNode,
): GalleryAdvancedQuery {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  return updateInSequence(tree, path, 0, fn);
}

function removeFromSequence(
  sequence: GalleryQueryNode[],
  path: NodePath,
  position: number,
): GalleryQueryNode[] {
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
  tree: GalleryAdvancedQuery,
  path: NodePath,
): GalleryAdvancedQuery {
  if (path.length === 0) throw new Error("NodePath 不能为空");
  return removeFromSequence(tree, path, 0);
}

interface SerializedSequence {
  body: string;
  endsAtHub: boolean;
}

function serializeAtom(atom: GalleryAtom): SerializedSequence {
  const parts = atomDimensions()
    .map((dimension) => filterForDimension(atom, dimension))
    .filter((filter) => filter.type !== "all")
    .map(serializeFilter);
  if (hasSearch(atom)) {
    parts.push(`search/${atom.search!.mode}/${encodeSeg(atom.search!.query)}`);
  }
  return { body: parts.join("/filter_comb/"), endsAtHub: hasSearch(atom) };
}

function serializeSequence(sequence: GalleryQueryNode[]): SerializedSequence {
  let body = "";
  let endsAtHub = true;

  for (const node of sequence) {
    let serialized: SerializedSequence;
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

    if (!serialized.body) continue;
    if (body) body += endsAtHub ? "/" : "/filter_comb/";
    body += serialized.body;
    endsAtHub = serialized.endsAtHub;
  }

  return { body, endsAtHub };
}

export function serializeAdvancedQuery(
  tree: GalleryAdvancedQuery,
): SerializedSequence {
  const serialized = serializeSequence(normalizeQuery(tree));
  return serialized.body ? serialized : { body: "all", endsAtHub: false };
}

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
    end < segments.length && segments[end] !== "filter_comb" &&
    !segments[end]!.startsWith("~")
  ) {
    end += 1;
  }
  return end;
}

function appendAtom(
  sequence: GalleryQueryNode[],
  dimension: Exclude<GalleryFilterDimension, "noAlbum"> | "search",
  atom: GalleryAtom,
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
): { sequence: GalleryQueryNode[]; position: number } | null {
  const sequence: GalleryQueryNode[] = [];
  let position = start;

  while (position < segments.length) {
    const segment = segments[position]!;
    if (segment === "filter_comb") {
      position += 1;
      continue;
    }
    if (segment === "~or" || segment === "~end") {
      return stopAtGroupBoundary ? { sequence, position } : null;
    }
    if (segment === "~any") {
      const branches: GalleryQueryNode[][] = [];
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
        search: { mode, query: decodeSeg(query) },
      });
      position += 3;
      continue;
    }

    const end = chunkEnd(segments, position);
    const parsed = parseDimensionChunk(segments.slice(position, end));
    if (
      !parsed || parsed.dimension === "noAlbum" ||
      parsed.filter.type === "date-range"
    ) {
      // 识别不了 / 树上无法表达的维度 chunk: 整体回退而非静默丢弃 —— 丢弃会让
      // 「应用」写回的路径悄悄少一个谓词。
      return null;
    }
    appendAtom(sequence, parsed.dimension, singleFilterToSet(parsed.filter));
    position = Math.max(position + 1, end);
  }

  return stopAtGroupBoundary ? null : { sequence, position };
}

export function parseAdvancedBody(segs: string[]): GalleryAdvancedQuery | null {
  const segments = joinEscapedSegments(segs);
  const parsed = parseSequence(segments, 0, false);
  if (!parsed || parsed.position !== segments.length) return null;
  return normalizeQuery(parsed.sequence);
}

function cloneQuery(tree: GalleryAdvancedQuery): GalleryAdvancedQuery {
  return tree.map((node) => {
    if (isIsNode(node)) {
      return {
        is: {
          ...node.is,
          ...(node.is.plugin ? { plugin: { ...node.is.plugin } } : {}),
          ...(node.is.mediaType ? { mediaType: { ...node.is.mediaType } } : {}),
          ...(node.is.date ? { date: { ...node.is.date } } : {}),
          ...(node.is.name ? { name: { ...node.is.name } } : {}),
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

function unwrapAncestorNots(
  sequence: GalleryQueryNode[],
  path: NodePath,
  position: number,
): GalleryQueryNode[] {
  const nodeIndex = path[position];
  const node = nodeIndex === undefined ? undefined : sequence[nodeIndex];
  if (nodeIndex === undefined || !node) {
    throw new Error(`无效 NodePath: ${path.join(".")}`);
  }
  if (position === path.length - 1) return sequence;

  if (isAnyNode(node)) {
    const branchIndex = path[position + 1];
    const branch = branchIndex === undefined
      ? undefined
      : node.any[branchIndex];
    if (!branch || position + 2 >= path.length) {
      throw new Error(`无效 NodePath: ${path.join(".")}`);
    }
    const branches = [...node.any];
    branches[branchIndex] = unwrapAncestorNots(branch, path, position + 2);
    const next = [...sequence];
    next[nodeIndex] = { any: branches };
    return next;
  }

  if ("not" in node) {
    const children = unwrapAncestorNots(node.not, path, position + 1);
    return [
      ...sequence.slice(0, nodeIndex),
      ...children,
      ...sequence.slice(nodeIndex + 1),
    ];
  }

  throw new Error(`NodePath 穿过了原子节点: ${path.join(".")}`);
}

const FACET_SEGMENTS: Partial<Record<GalleryAtomDimension, string>> = {
  plugin: "plugin",
  mediaType: "media-type",
  date: "date",
  name: "name",
  size: "size",
  aspect: "aspect",
};

export function facetListPath(
  tree: GalleryAdvancedQuery,
  nodePath: NodePath,
  dim: GalleryAtomDimension,
): string {
  const facetSegment = FACET_SEGMENTS[dim];
  if (!facetSegment) throw new Error(`维度 ${dim} 不支持 facet 列表`);

  let nextTree = cloneQuery(tree);
  nextTree = updateNode(nextTree, nodePath, (node) => {
    if (!isIsNode(node)) {
      throw new Error("facetListPath 的 NodePath 必须指向原子节点");
    }
    const atom = { ...node.is };
    delete atom[dim];
    return { is: atom };
  });
  if (notParity(tree, nodePath)) {
    nextTree = unwrapAncestorNots(nextTree, nodePath, 0);
  }

  const normalized = normalizeQuery(nextTree);
  if (normalized.length === 0) return facetSegment;

  const serialized = serializeAdvancedQuery(normalized);
  return `${serialized.body}${
    serialized.endsAtHub ? "/" : "/filter_comb/"
  }${facetSegment}`;
}
