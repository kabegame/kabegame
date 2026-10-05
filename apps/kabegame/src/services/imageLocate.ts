import { pathqlFetch } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";

/**
 * 预览深链接定位：算出某张图在给定视图（过滤 + 排序，不含分页）里的 1 起序号。
 *
 * 路径形态 `<视图>/~~/rank/~~/id_<id>`：
 * - 内层 `~~` 把「过滤 + ORDER BY、无 LIMIT」整体冻结成物化 CTE
 * - `rank` 给 CTE 的每一行打 `row_index`（窗口函数在 WHERE 之后求值，所以必须独占一层）
 * - 外层 `~~` 之后用既有的 `id_<id>` 路由挑出目标行
 *
 * 返回 null 表示这张图不在该视图里（被过滤掉、或 `hide/` 开着而它已隐藏），
 * 不是错误——调用方据此保持「单图模式」即可。
 */
export async function locateImageRowIndex(viewBody: string, imageId: string): Promise<number | null> {
  const id = imageId.trim();
  const body = (viewBody || "").trim();
  if (!id || !body) return null;
  const path = `images://${withGalleryPrefix(body)}/~~/rank/~~/id_${encodeURIComponent(id)}`;
  const rows = await pathqlFetch<{ row_index?: unknown }>(path);
  const raw = rows[0]?.row_index;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/** 1 起序号 → 1 起页码。 */
export function pageOfRowIndex(rowIndex: number, pageSize: number): number {
  return Math.floor((rowIndex - 1) / Math.max(1, pageSize)) + 1;
}
