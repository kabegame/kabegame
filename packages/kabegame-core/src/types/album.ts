/** 画册树节点（与 apps/kabegame `stores/albums` 中结构一致，供 core 组件使用） */
export interface AlbumTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  children: AlbumTreeNode[];
}
