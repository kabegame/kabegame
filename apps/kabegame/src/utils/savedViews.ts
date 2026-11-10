import type { GridAdapterId } from "@/components/imageGrid/types";
import { buildComposablePath, newRandomSortSeed, parseComposablePath, type GallerySort } from "@/utils/galleryPath";
import type { GalleryQuery } from "@/utils/galleryQuery";

/**
 * 收藏视图：查询行 ⋯ 面板里用户收藏的「过滤 + 排序」组合，存在前端 Dexie（见
 * `services/savedViews.ts`、`cocs/gallery/SAVED_VIEWS.md`）。
 *
 * 来源就是 ImageGrid 的 adapter：画廊一份，所有画册共用一份，所有任务、所有站点各一份。
 */
export type SavedViewSource = GridAdapterId;

export interface SavedView {
  id?: number;
  source: SavedViewSource;
  /**
   * 查询体：过滤 + 排序（`buildComposablePath({ query, sort })`）。不带 `album/<id>` 这类根前缀，
   * 也不带 `hide/`、`no-album`、分页尾——所以同一来源的收藏在所有画册 / 任务 / 站点通用。
   * 随机排序不带种子（`sort/random`）。同一来源内唯一。
   */
  path: string;
  /** 用户起的名字；null 表示用 `path` 作名字（用当前视图更新后名字跟着新路径变）。 */
  name: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface SavedViewQuery {
  query: GalleryQuery;
  sort: GallerySort;
}

/** 列表与冲突判定用的显示名：没起名就是路径本身。 */
export function savedViewDisplayName(view: Pick<SavedView, "name" | "path">): string {
  return view.name ?? view.path;
}

/** 去首尾空白；空串表示「不命名，用路径作名字」。 */
export function normalizeSavedViewName(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * 同来源里显示名与给定名字（为 null 时取 `path`）相同的另一行。不分大小写；路径默认名与
 * 用户起的名字放在一起比，所以也不能把名字起成别的收藏的路径。`selfId` 排除自身（编辑时）。
 */
export function findNameConflict(
  list: readonly SavedView[],
  name: string | null,
  path: string,
  selfId?: number,
): SavedView | undefined {
  const target = savedViewDisplayName({ name, path }).toLowerCase();
  return list.find((view) => view.id !== selfId && savedViewDisplayName(view).toLowerCase() === target);
}

/** 同来源里已收藏了这条查询体的另一行（路径唯一）。 */
export function findPathConflict(list: readonly SavedView[], path: string, selfId?: number): SavedView | undefined {
  return list.find((view) => view.id !== selfId && view.path === path);
}

/** 当前查询 → 收藏用的查询体（随机排序去种子，同一视图两次构建结果相同）。 */
export function savedViewBody(query: GalleryQuery, sort: GallerySort): string {
  return buildComposablePath({ query, sort, omitRandomSeed: true });
}

/** 查询体 → 查询与排序。随机排序现生成种子：每次应用都是一次新的洗牌。 */
export function parseSavedViewBody(body: string): SavedViewQuery {
  const { query, sort } = parseComposablePath(body);
  return {
    query,
    sort: sort.field === "random" ? { ...sort, seed: newRandomSortSeed() } : sort,
  };
}

/** 按最后使用时间从新到旧（同一毫秒按创建时间）。 */
export function sortSavedViewsByLastUsed(list: SavedView[]): SavedView[] {
  return list.sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt);
}
