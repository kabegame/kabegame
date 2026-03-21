/**
 * 画廊 query.path：`<root>/[desc/]<page>`，如 all/1、all/desc/2、plugin/foo/desc/1。
 * 纯函数：由 (root, sort, page) 拼 path；由 path 解析出三部分。无聚合「状态对象」供业务持有。
 */

export const GALLERY_STORAGE_KEY_ROOT = "kabegame-gallery-browse-root";
export const GALLERY_STORAGE_KEY_SORT = "kabegame-gallery-sort";
export const GALLERY_STORAGE_KEY_PAGE = "kabegame-gallery-page";

export type GalleryTimeSort = "asc" | "desc";

/** parseGalleryPath 的返回值，仅用于解析/再拼装，不作为持久化模型 */
export interface ParsedGalleryPath {
  root: string;
  sort: GalleryTimeSort;
  page: number;
}

const DEFAULT_ROOT = "all";
const DEFAULT_SORT: GalleryTimeSort = "asc";
const DEFAULT_PAGE = 1;

export function buildGalleryPath(
  root: string,
  sort: GalleryTimeSort,
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
    sort: DEFAULT_SORT,
    page: DEFAULT_PAGE,
  };
  const trimmed = (path || "").trim();
  if (!trimmed) return base;

  const segs = trimmed.split("/").filter(Boolean);
  if (segs.length === 0) return base;

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

export const DEFAULT_GALLERY_PATH = buildGalleryPath(
  DEFAULT_ROOT,
  DEFAULT_SORT,
  DEFAULT_PAGE
);
