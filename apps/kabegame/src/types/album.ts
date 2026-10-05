export type AlbumSyncMode = "none" | "shallow" | "recursive" | "delegated";

/** 画册类型：普通 / 本地文件夹同步 / 标签叶子 / 标签目录（后两者组成独立森林） */
export type AlbumKind = "normal" | "local_folder" | "label" | "label_dir";

/** 标签森林成员：目录（label_dir）或叶子（label）。 */
export function isLabelForestKind(type: AlbumKind | string | null | undefined): boolean {
  return type === "label" || type === "label_dir";
}

/** 通用画册树节点结构；app 的分页查询树使用自身的 `AlbumNode`。 */
export interface AlbumTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  /** 画册类型；缺省即普通画册（历史调用点未必传） */
  type?: AlbumKind;
  syncFolder?: string | null;
  /** 与 apps/kabegame `Album.folderStatus` 同构（已解析，非 JSON 字符串）；红点判定读 state */
  folderStatus?: { state: string; message?: string } | null;
  syncMode?: AlbumSyncMode;
  /** 标签或标签目录：标签 key */
  labelKey?: string | null;
  /** 标签或标签目录：从标签森林根到自身的 key 链，如 `pixiv/character/hatsune` */
  labelPath?: string | null;
  children: AlbumTreeNode[];
}
