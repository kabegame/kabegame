import type { AlbumSyncMode, AlbumTreeNode } from "../types/album";

/** 与画册 store 中 `albumTree` 一致的扁平列表 → 树构建（供多处复用） */
export interface AlbumFlatRow {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  type?: "normal" | "local_folder";
  syncFolder?: string | null;
  folderStatus?: { state: string; message?: string } | null;
  syncMode?: AlbumSyncMode;
}

export function buildAlbumTreeFromFlat(albums: AlbumFlatRow[]): AlbumTreeNode[] {
  const map = new Map<string, AlbumTreeNode>();
  for (const a of albums) {
    map.set(a.id, { ...a, children: [] });
  }
  const roots: AlbumTreeNode[] = [];
  for (const a of albums) {
    const node = map.get(a.id)!;
    const pid = a.parentId;
    if (pid && map.has(pid)) {
      map.get(pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortChildren = (nodes: AlbumTreeNode[]) => {
    nodes.sort((x, y) => y.createdAt - x.createdAt);
    for (const n of nodes) {
      if (n.children.length) sortChildren(n.children);
    }
  };
  sortChildren(roots);
  return roots;
}

/** 安卓画册选择器：树压平为带缩进的 label 列表 */
export function flattenAlbumTreeForAndroidPicker(
  nodes: AlbumTreeNode[],
  albumCounts: Record<string, number>,
  depth = 0,
): { label: string; value: string }[] {
  return nodes.flatMap((n) => [
    {
      label: "\u00A0\u00A0".repeat(depth) + n.name + ` (${albumCounts[n.id] ?? 0})`,
      value: n.id,
    },
    ...flattenAlbumTreeForAndroidPicker(n.children, albumCounts, depth + 1),
  ]);
}

/**
 * 安卓居中磨玻璃列表画册选择器：树压平为 { label, value, count, childCount } 列表。
 * label 为纯画册名（不带缩进/计数），count/childCount 供调用方拼装描述文案（如「248 张 · 含 2 个子画册」）。
 */
export function flattenAlbumTreeForFrostedPicker(
  nodes: AlbumTreeNode[],
  albumCounts: Record<string, number>,
): { label: string; value: string; count: number; childCount: number }[] {
  return nodes.flatMap((n) => [
    {
      label: n.name,
      value: n.id,
      count: albumCounts[n.id] ?? 0,
      childCount: n.children.length,
    },
    ...flattenAlbumTreeForFrostedPicker(n.children, albumCounts),
  ]);
}
