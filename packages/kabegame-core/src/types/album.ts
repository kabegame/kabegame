export type AlbumSyncMode = "none" | "shallow" | "recursive" | "delegated";

/** 画册树节点（与 apps/kabegame `stores/albums` 中结构一致，供 core 组件使用） */
export interface AlbumTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  /** "normal" | "local_folder"；缺省即普通画册（历史调用点未必传） */
  type?: "normal" | "local_folder";
  syncFolder?: string | null;
  /** 与 apps/kabegame `Album.folderStatus` 同构（已解析，非 JSON 字符串）；红点判定读 state */
  folderStatus?: { state: string; message?: string } | null;
  syncMode?: AlbumSyncMode;
  children: AlbumTreeNode[];
}
