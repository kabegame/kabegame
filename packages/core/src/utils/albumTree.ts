import type { AlbumTreeNode } from "../types/album";

/** 与画册 store 中 `albumTree` 一致的扁平列表 → 树构建（供多处复用） */
export interface AlbumFlatRow {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
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
