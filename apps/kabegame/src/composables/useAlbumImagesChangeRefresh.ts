/** 后端 `AppEvent::AlbumImagesChange` / 事件名 `album-images-change`。 */
export type AlbumImagesChangePayload = {
  seq: number;
  reason: "add" | "add-hidden" | "delete" | "delete-hidden" | "hide" | "unhide" | "order";
  /** 后端恒按单画册拆分，保留数组形状以兼容事件协议。 */
  albumIds: string[];
  imageIds: string[];
  ancestorPath: string;
};
