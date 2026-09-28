export type AlbumSyncMode = "none" | "shallow" | "recursive" | "delegated";

/** 画册类型：普通 / 本地文件夹同步 / 标签（独立的标签森林） */
export type AlbumKind = "normal" | "local_folder" | "label";

/** 画册树节点（与 apps/kabegame `stores/albums` 中结构一致，供 core 组件使用） */
export interface AlbumTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  /** "normal" | "local_folder" | "label"；缺省即普通画册（历史调用点未必传） */
  type?: AlbumKind;
  syncFolder?: string | null;
  /** 与 apps/kabegame `Album.folderStatus` 同构（已解析，非 JSON 字符串）；红点判定读 state */
  folderStatus?: { state: string; message?: string } | null;
  syncMode?: AlbumSyncMode;
  /** 仅标签画册：标签 key */
  labelKey?: string | null;
  /** 仅标签画册：从标签森林根到自身的 key 链，如 `pixiv/character/hatsune` */
  labelPath?: string | null;
  children: AlbumTreeNode[];
}
