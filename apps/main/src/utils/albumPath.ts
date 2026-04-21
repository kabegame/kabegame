/**
 * 画册详情 provider path：`album/<albumId>/…`
 * - 全部：按时间 `…/[desc/]<page>`；按加入顺序 `…/album-order/[desc/]<page>`
 * - 仅设过壁纸：`…/wallpaper-order/[desc/]<page>`
 * - 仅图片 / 仅视频：`…/image-only/…`、`…/video-only/…`（子路径与「全部」一致）
 */

export type AlbumBrowseFilter =
  | "all"
  | "wallpaper-order"
  | "image-only"
  | "video-only";

/** 与 filter 组合使用：全部下为 time-* / join-*；壁纸过滤下为 set-* */
export type AlbumBrowseSort =
  | "time-asc"
  | "time-desc"
  | "join-asc"
  | "join-desc"
  | "set-asc"
  | "set-desc";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;

function normalizeSortForFilter(
  filter: AlbumBrowseFilter,
  sort: AlbumBrowseSort
): AlbumBrowseSort {
  if (filter === "wallpaper-order") {
    if (sort === "set-asc" || sort === "set-desc") return sort;
    return sort === "time-desc" || sort === "join-desc" ? "set-desc" : "set-asc";
  }
  if (filter === "image-only" || filter === "video-only") {
    if (sort === "set-asc" || sort === "set-desc") return sort;
    if (
      sort === "time-asc" ||
      sort === "time-desc" ||
      sort === "join-asc" ||
      sort === "join-desc"
    ) {
      return sort;
    }
    return sort === "set-desc" ? "time-desc" : "time-asc";
  }
  if (
    sort === "time-asc" ||
    sort === "time-desc" ||
    sort === "join-asc" ||
    sort === "join-desc"
  ) {
    return sort;
  }
  return sort === "set-desc" ? "time-desc" : "time-asc";
}

export function buildAlbumBrowsePath(
  albumId: string,
  filter: AlbumBrowseFilter,
  sort: AlbumBrowseSort,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE
): string {
  const id = (albumId || "").trim();
  if (!id) return `album//${DEFAULT_PAGE}`;
  const p = Math.max(1, Math.floor(Number(page)) || DEFAULT_PAGE);
  const s = normalizeSortForFilter(filter, sort);
  const ps = pageSize === DEFAULT_PAGE_SIZE ? "" : `x${pageSize}x/`;

  if (filter === "wallpaper-order") {
    if (s === "set-desc") return `album/${id}/wallpaper-order/desc/${ps}${p}`;
    return `album/${id}/wallpaper-order/${ps}${p}`;
  }

  if (filter === "image-only" || filter === "video-only") {
    const prefix =
      filter === "image-only"
        ? `album/${id}/image-only`
        : `album/${id}/video-only`;
    if (s === "set-desc") return `${prefix}/wallpaper-order/desc/${ps}${p}`;
    if (s === "set-asc") return `${prefix}/wallpaper-order/${ps}${p}`;
    if (s === "join-desc") return `${prefix}/album-order/desc/${ps}${p}`;
    if (s === "join-asc") return `${prefix}/album-order/${ps}${p}`;
    if (s === "time-desc") return `${prefix}/desc/${ps}${p}`;
    return `${prefix}/${ps}${p}`;
  }

  if (s === "join-desc") return `album/${id}/album-order/desc/${ps}${p}`;
  if (s === "join-asc") return `album/${id}/album-order/${ps}${p}`;
  if (s === "time-desc") return `album/${id}/desc/${ps}${p}`;
  return `album/${id}/${ps}${p}`;
}

export interface ParsedAlbumBrowsePath {
  albumId: string;
  filter: AlbumBrowseFilter;
  sort: AlbumBrowseSort;
  page: number;
  pageSize: number;
}

/** 解析 browse_gallery_provider 用的画册路径；无法识别时返回 null */
export function parseAlbumBrowsePath(path: string): ParsedAlbumBrowsePath | null {
  const trimmed = (path || "").trim();
  const rawSegs = trimmed.split("/").map((s) => s.trim()).filter(Boolean);
  if (rawSegs.length < 3 || rawSegs[0] !== "album") return null;
  const albumId = rawSegs[1]!;
  if (!albumId) return null;

  const last = rawSegs[rawSegs.length - 1]!;
  const pageNum = parseInt(last, 10);
  if (Number.isNaN(pageNum) || pageNum < 1) return null;

  // Strip optional x{n}x segment immediately before the page number
  let pageSize = DEFAULT_PAGE_SIZE;
  let prefixSegs = rawSegs.slice(0, rawSegs.length - 1);
  const psCandidate = prefixSegs[prefixSegs.length - 1];
  if (psCandidate) {
    const m = psCandidate.match(/^x(\d+)x$/);
    if (m) {
      pageSize = parseInt(m[1]!, 10) || DEFAULT_PAGE_SIZE;
      prefixSegs = prefixSegs.slice(0, prefixSegs.length - 1);
    }
  }
  const segs = [...prefixSegs, last];

  if (segs.length === 3) {
    return { albumId, filter: "all", sort: "time-asc", page: pageNum, pageSize };
  }
  if (segs.length === 4) {
    const mid = segs[2]!;
    if (mid === "desc") {
      return { albumId, filter: "all", sort: "time-desc", page: pageNum, pageSize };
    }
    if (mid === "wallpaper-order") {
      return { albumId, filter: "wallpaper-order", sort: "set-asc", page: pageNum, pageSize };
    }
    if (mid === "album-order") {
      return { albumId, filter: "all", sort: "join-asc", page: pageNum, pageSize };
    }
    if (mid === "image-only") {
      return { albumId, filter: "image-only", sort: "time-asc", page: pageNum, pageSize };
    }
    if (mid === "video-only") {
      return { albumId, filter: "video-only", sort: "time-asc", page: pageNum, pageSize };
    }
    return null;
  }
  if (segs.length === 5) {
    if (segs[3] === "desc") {
      if (segs[2] === "wallpaper-order") {
        return { albumId, filter: "wallpaper-order", sort: "set-desc", page: pageNum, pageSize };
      }
      if (segs[2] === "album-order") {
        return { albumId, filter: "all", sort: "join-desc", page: pageNum, pageSize };
      }
      if (segs[2] === "image-only") {
        return { albumId, filter: "image-only", sort: "time-desc", page: pageNum, pageSize };
      }
      if (segs[2] === "video-only") {
        return { albumId, filter: "video-only", sort: "time-desc", page: pageNum, pageSize };
      }
      return null;
    }
    if (segs[2] === "image-only" && segs[3] === "wallpaper-order") {
      return { albumId, filter: "image-only", sort: "set-asc", page: pageNum, pageSize };
    }
    if (segs[2] === "video-only" && segs[3] === "wallpaper-order") {
      return { albumId, filter: "video-only", sort: "set-asc", page: pageNum, pageSize };
    }
    if (segs[2] === "image-only" && segs[3] === "album-order") {
      return { albumId, filter: "image-only", sort: "join-asc", page: pageNum, pageSize };
    }
    if (segs[2] === "video-only" && segs[3] === "album-order") {
      return { albumId, filter: "video-only", sort: "join-asc", page: pageNum, pageSize };
    }
    return null;
  }
  if (segs.length === 6 && segs[4] === "desc") {
    if (segs[2] === "image-only" && segs[3] === "album-order") {
      return { albumId, filter: "image-only", sort: "join-desc", page: pageNum, pageSize };
    }
    if (segs[2] === "video-only" && segs[3] === "album-order") {
      return { albumId, filter: "video-only", sort: "join-desc", page: pageNum, pageSize };
    }
    if (segs[2] === "image-only" && segs[3] === "wallpaper-order") {
      return { albumId, filter: "image-only", sort: "set-desc", page: pageNum, pageSize };
    }
    if (segs[2] === "video-only" && segs[3] === "wallpaper-order") {
      return { albumId, filter: "video-only", sort: "set-desc", page: pageNum, pageSize };
    }
  }
  return null;
}

/** 当前路径是否处于「画册内仅设过壁纸」过滤（用于空态按钮） */
export function isAlbumWallpaperFilterPath(path: string): boolean {
  const p = parseAlbumBrowsePath(path.trim());
  return p?.filter === "wallpaper-order";
}

function mapSortWhenChangingFilter(
  from: AlbumBrowseFilter,
  to: AlbumBrowseFilter,
  sort: AlbumBrowseSort
): AlbumBrowseSort {
  if (from === to) return sort;
  if (to === "wallpaper-order") {
    if (sort === "time-asc" || sort === "join-asc" || sort === "set-asc") {
      return "set-asc";
    }
    return "set-desc";
  }
  if (to === "image-only" || to === "video-only") {
    if (from === "wallpaper-order") {
      return sort === "set-desc" ? "time-desc" : "time-asc";
    }
    return sort;
  }
  if (to === "all") {
    if (from === "wallpaper-order") {
      return sort === "set-desc" ? "time-desc" : "time-asc";
    }
    return sort;
  }
  return sort;
}

/** 切换过滤时回到第 1 页，并按语义映射排序 */
export function albumBrowsePathWithFilterOnly(
  path: string,
  newFilter: AlbumBrowseFilter
): string {
  const p = parseAlbumBrowsePath(path);
  if (!p) return path;
  const nextSort = mapSortWhenChangingFilter(p.filter, newFilter, p.sort);
  return buildAlbumBrowsePath(p.albumId, newFilter, nextSort, 1, p.pageSize);
}

/** 仅改排序，保留过滤与页码 */
export function albumBrowsePathWithSortOnly(
  path: string,
  sort: AlbumBrowseSort
): string {
  const p = parseAlbumBrowsePath(path);
  if (!p) return path;
  return buildAlbumBrowsePath(p.albumId, p.filter, sort, p.page, p.pageSize);
}
