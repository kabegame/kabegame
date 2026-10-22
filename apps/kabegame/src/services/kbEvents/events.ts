import { filter, merge, type Observable } from "rxjs";
import type { ImageChangedPayload, ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { kbEvent$, type KbEvent } from "./eventSource";

export type AlbumChangedPayload = {
  seq?: number;
  albumId?: string;
  changes?: Record<string, unknown>;
};

/** 已接入的后端事件与 payload 类型；核心事件源本身不依赖此表。 */
export interface KbEventMap {
  "images-change": ImagesChangePayload;
  "image-changed": ImageChangedPayload;
  "album-images-change": AlbumImagesChangePayload;
  "album-changed": AlbumChangedPayload;
  "album-added": { id?: string; ancestorPath?: string };
  "album-deleted": { albumId?: string; ancestorPath?: string };
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

const ALBUM_STRUCTURE_FIELDS = ["name", "parentId", "labelKey", "albumType"];
// 只改画册行展示的字段：不影响图片结果集，只有画册自身的视图关心
const ALBUM_ROW_FIELDS = ["syncMode"];

/** album-changed 是否改了画册结构字段 / 行展示字段。 */
export function albumChangeKinds(payload: AlbumChangedPayload): { structure: boolean; row: boolean } {
  const changes = payload.changes ?? {};
  const has = (field: string) => Object.prototype.hasOwnProperty.call(changes, field);
  return { structure: ALBUM_STRUCTURE_FIELDS.some(has), row: ALBUM_ROW_FIELDS.some(has) };
}

/** 单事件路径；缺失任一必要路径时按通配处理，移动同时考虑新旧位置。 */
export function albumEventPaths(name: string, payload: unknown): string[] | "wildcard" {
  const data = payload as Record<string, unknown> | null;
  const paths = name === "album-changed" ? (data?.changes as Record<string, unknown> | undefined) : data;
  if (typeof paths?.ancestorPath !== "string" || !paths.ancestorPath) return "wildcard";
  const out = [paths.ancestorPath];
  if (name === "album-changed" && Object.prototype.hasOwnProperty.call(paths, "parentId")) {
    if (typeof paths.oldAncestorPath !== "string" || !paths.oldAncestorPath) return "wildcard";
    out.push(paths.oldAncestorPath);
  }
  return out;
}

/** 分区根关心任意路径，子目录仅关心严格后代（不包含自身）。 */
export function albumEventAffectsDir(name: string, payload: unknown, ancestorPath: string | null): boolean {
  const paths = albumEventPaths(name, payload);
  return (
    paths === "wildcard" ||
    ancestorPath === null ||
    paths.some((path) => path !== ancestorPath && path.startsWith(ancestorPath))
  );
}
