import { HIDDEN_ALBUM_ID, type Album } from "@/services/albums";
import { filter, merge, type Observable } from "rxjs";
import type { ImageInfo } from "@/types/image";
import type { Plugin } from "@/stores/plugins";
import { kbEvent$, type KbEvent } from "./eventSource";

/** 一张图片的字段绝对值。 */
export type ImageFieldPatch = { id: string } & Partial<ImageInfo>;
export type ImagesAddedPayload = { seq: number; images: ImageInfo[] };
export type ImagesDeletedPayload = { seq: number; imageIds: string[] };
export type ImagesChangePayload = { seq: number; patches: ImageFieldPatch[] };
export type ImageChangedPayload = { seq: number; patch: ImageFieldPatch };
export type ImagePatchPayload = ImagesChangePayload | ImageChangedPayload;

/** 真实成员增删与排序共用载荷，事件名区分操作。隐藏 / 取消隐藏就是隐藏画册自身的成员增删。 */
export type AlbumImagesPayload = {
  seq: number;
  albumId: string;
  ancestorPath: string;
  imageIds: string[];
  /** 整行删图造成的成员删除；隐藏画册的这类删除不是取消隐藏 */
  imagesDeleted?: boolean;
};
export type AlbumFieldPatch = { id: string; albumType?: Album["type"] } & Partial<
  Omit<Album, "parentId" | "ancestorPath">
>;
export type AlbumChangedPayload = { seq: number; patch: AlbumFieldPatch };
export type AlbumsChangePayload = { seq: number; patches: AlbumFieldPatch[] };
export type AlbumPatchPayload = AlbumChangedPayload | AlbumsChangePayload;
export type AlbumMovedPayload = { seq: number; id: string; oldAncestorPath: string; newAncestorPath: string };

export type AutoConfigChangePayload = {
  seq?: number;
  reason?: "configadd" | "configchange" | "configdelete";
  configId?: string;
};

export type PluginChangedPayload = {
  pluginId?: string;
  changes?: { version?: string; recommendedConfigs?: Record<string, { imported: boolean }> } & Record<string, unknown>;
};

/** 已接入的后端事件与 payload 类型；核心事件源本身不依赖此表。 */
export interface KbEventMap {
  "auto-config-change": AutoConfigChangePayload;
  "tasks-change": unknown;
  "plugin-added": { plugin?: Plugin };
  "plugin-changed": PluginChangedPayload;
  "plugin-deleted": { pluginId?: string };
  "images-added": ImagesAddedPayload;
  "images-deleted": ImagesDeletedPayload;
  "images-change": ImagesChangePayload;
  "image-changed": ImageChangedPayload;
  "album-images-added": AlbumImagesPayload;
  "album-images-deleted": AlbumImagesPayload;
  "album-images-change": AlbumImagesPayload;
  "album-changed": AlbumChangedPayload;
  "albums-change": AlbumsChangePayload;
  "album-moved": AlbumMovedPayload;
  "albums-added": { seq: number; albums: Album[] };
  "albums-deleted": { seq: number; albums: { id: string; ancestorPath: string }[] };
}

/** 一种事件的触发条件：每条只对一种事件。 */
export interface EventTrigger {
  event: string;
  relevant: (payload: unknown) => boolean;
}

export function on<K extends keyof KbEventMap>(
  event: K,
  relevant: (payload: KbEventMap[K]) => boolean = () => true,
): EventTrigger {
  return { event, relevant: relevant as (payload: unknown) => boolean };
}

/** 把若干单事件触发合成一条相关事件流，作为刷新信号。 */
export function triggers$(triggers: readonly EventTrigger[]): Observable<KbEvent> {
  return merge(
    ...triggers.map((trigger) => kbEvent$(trigger.event).pipe(filter((event) => trigger.relevant(event.payload)))),
  );
}

const ALBUM_STRUCTURE_FIELDS = ["name", "labelKey", "albumType"];
// 只改画册行展示的字段：不影响图片结果集，只有画册自身的视图关心
const ALBUM_ROW_FIELDS = ["syncMode"];

/** 单条与批量画册字段补丁统一展开。 */
export function albumPatches(payload: AlbumPatchPayload): AlbumFieldPatch[] {
  return "patch" in payload ? [payload.patch] : payload.patches;
}

export function albumChangeKinds(payload: AlbumPatchPayload | AlbumFieldPatch): { structure: boolean; row: boolean } {
  const patches = "id" in payload ? [payload] : albumPatches(payload);
  const has = (field: string) => patches.some((patch) => Object.prototype.hasOwnProperty.call(patch, field));
  return { structure: ALBUM_STRUCTURE_FIELDS.some(has), row: ALBUM_ROW_FIELDS.some(has) };
}

/** 批量事件任意画册相关就刷新，每条触发仍只对应一种事件。 */
export function albumPatchTriggers(
  relevant: (patch: AlbumFieldPatch, kinds: ReturnType<typeof albumChangeKinds>) => boolean,
): EventTrigger[] {
  return [
    on("album-changed", (p) => albumPatches(p).some((patch) => relevant(patch, albumChangeKinds(patch)))),
    on("albums-change", (p) => albumPatches(p).some((patch) => relevant(patch, albumChangeKinds(patch)))),
  ];
}

export function pathHasAlbum(ancestorPath: string, id: string): boolean {
  return ancestorPath.split("/").includes(id);
}

/** 移动后立即改写持有行的路径；移动根的父级来自新路径。 */
export function moveAlbumPath<T extends { id: string; ancestorPath: string; parentId: string | null }>(
  album: T,
  moved: AlbumMovedPayload,
): T {
  if (!album.ancestorPath.startsWith(moved.oldAncestorPath)) return album;
  const ancestorPath = moved.newAncestorPath + album.ancestorPath.slice(moved.oldAncestorPath.length);
  const parts = moved.newAncestorPath.split("/").filter(Boolean);
  return { ...album, ancestorPath, ...(album.id === moved.id ? { parentId: parts.at(-2) ?? null } : {}) };
}

/** 增删带每个根的路径，移动带两侧路径；字段补丁不负责位置判断。 */
export function albumEventPaths(name: string, payload: unknown): string[] | "wildcard" {
  const data = payload as Record<string, unknown> | null;
  let paths: unknown[];
  if (name === "album-moved") paths = [data?.oldAncestorPath, data?.newAncestorPath];
  else if (name === "albums-added" || name === "albums-deleted") {
    if (!Array.isArray(data?.albums)) return "wildcard";
    paths = data.albums.map((a) => a.ancestorPath);
  } else if (name === "album-changed" || name === "albums-change") return [];
  else paths = [data?.ancestorPath];
  return paths.some((path) => typeof path !== "string" || !path) ? "wildcard" : (paths as string[]);
}

/** 分区根关心任意路径，子目录仅关心严格后代（不包含自身）。 */
export function albumEventAffectsDir(name: string, payload: unknown, ancestorPath: string | null): boolean {
  const paths = albumEventPaths(name, payload);
  return (
    paths === "wildcard" ||
    (paths.length > 0 && ancestorPath === null) ||
    paths.some((path) => path !== ancestorPath && ancestorPath !== null && path.startsWith(ancestorPath))
  );
}

/** 隐藏画册成员变化；各观察方按自身 hide 状态决定是否刷新。 */
export function isHiddenAlbumChange(payload: AlbumImagesPayload): boolean {
  return payload.albumId === HIDDEN_ALBUM_ID;
}
