import Dexie, { type Table } from "dexie";
import {
  findNameConflict,
  findPathConflict,
  sortSavedViewsByLastUsed,
  type SavedView,
  type SavedViewSource,
} from "@/utils/savedViews";

/**
 * 收藏视图的持久化：前端 Dexie 库，所有平台都用（不是缓存，不像 metadata 缓存那样只在 web 落库）。
 * 数据随 CEF / WebView 的 profile 走，与 localStorage 偏好同样耐久。语义见 `cocs/gallery/SAVED_VIEWS.md`。
 */
class SavedViewsDb extends Dexie {
  views!: Table<SavedView, number>;

  constructor() {
    super("kbg-saved-views");
    // [source+path] 唯一：同一来源里一条查询体只收藏一次。名字唯一（不分大小写、含路径默认名）
    // 不是索引能表达的，由写入事务里的 findNameConflict 保证。
    this.version(1).stores({ views: "++id, &[source+path], source" });
  }
}

const db = new SavedViewsDb();

export class SavedViewConflictError extends Error {
  constructor(
    readonly kind: "name" | "path",
    readonly other: SavedView,
  ) {
    super(kind === "name" ? "saved view name conflict" : "saved view path conflict");
    this.name = "SavedViewConflictError";
  }
}

function assertNoConflict(list: SavedView[], name: string | null, path: string, selfId?: number) {
  const samePath = findPathConflict(list, path, selfId);
  if (samePath) throw new SavedViewConflictError("path", samePath);
  const sameName = findNameConflict(list, name, path, selfId);
  if (sameName) throw new SavedViewConflictError("name", sameName);
}

/** 本来源全部收藏，按最后使用时间从新到旧。 */
export async function listSavedViews(source: SavedViewSource): Promise<SavedView[]> {
  return sortSavedViewsByLastUsed(await db.views.where("source").equals(source).toArray());
}

/** 新增一条；新收藏的最后使用时间就是收藏时间。名字或路径冲突抛 `SavedViewConflictError`。 */
export async function addSavedView(source: SavedViewSource, path: string, name: string | null): Promise<SavedView> {
  return db.transaction("rw", db.views, async () => {
    assertNoConflict(await db.views.where("source").equals(source).toArray(), name, path);
    const now = Date.now();
    const view: SavedView = { source, path, name, createdAt: now, lastUsedAt: now };
    view.id = await db.views.add(view);
    return view;
  });
}

/** 改名 / 换查询体；不碰最后使用时间（编辑不算使用）。 */
export async function updateSavedView(id: number, patch: { name: string | null; path: string }): Promise<SavedView> {
  return db.transaction("rw", db.views, async () => {
    const current = await db.views.get(id);
    if (!current) throw new Error(`saved view ${id} not found`);
    assertNoConflict(await db.views.where("source").equals(current.source).toArray(), patch.name, patch.path, id);
    const next: SavedView = { ...current, name: patch.name, path: patch.path };
    await db.views.put(next);
    return next;
  });
}

export async function removeSavedView(id: number): Promise<void> {
  await db.views.delete(id);
}

/** 记一次使用：只在 ⋯ 面板收起时给本次打开期间最后应用的那条调用。 */
export async function touchSavedView(id: number, at = Date.now()): Promise<void> {
  await db.views.update(id, { lastUsedAt: at });
}
