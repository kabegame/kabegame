import type { ImageInfo } from "@/types/image";

/** 后端 `AppEvent::ImagesChange` / `images` 表粗粒度失效信号（reason: add | delete | change） */
export type ImagesChangePayload = {
  seq: number;
  reason?: "add" | "delete" | "change";
  imageIds?: string[];
  taskIds?: string[];
  surfRecordIds?: string[];
  pluginIds?: string[];
};

export type ImagePatchEntry = {
  imageIds: string[];
  /** `ImageInfo` camelCase 字段的绝对值快照。 */
  diff: Partial<ImageInfo>;
};

export type ImageChangedPayload = {
  seq: number;
  patches: ImagePatchEntry[];
};
