import { filter, merge, type Observable } from "rxjs";
import type { AlbumImagesChangePayload, ImageChangedPayload, ImagesChangePayload, ImagePatchPayload } from "./events";
import type { ImageInfo } from "@/types/image";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import { batchWindow } from "./batchWindow";
import { kbEvent$, type KbEvent } from "./eventSource";

/** imageId → 这一批内合并后的字段绝对值。 */
export type ImagePatchBatch = Map<string, Partial<ImageInfo>>;

function mergeInto(batch: ImagePatchBatch, imageIds: readonly string[], fields: Partial<ImageInfo>) {
  for (const id of imageIds) {
    if (id) batch.set(id, { ...batch.get(id), ...fields });
  }
}

/** 单图与多图补丁共用一个窗口，同一 id 后到的字段覆盖先到的。 */
export function reducePatches(events: readonly KbEvent<ImagePatchPayload>[]): ImagePatchBatch | null {
  const batch: ImagePatchBatch = new Map();
  for (const { payload } of events) {
    const patches = "patch" in payload ? [payload.patch] : payload.patches;
    for (const { id, ...fields } of patches) mergeInto(batch, [id], fields);
  }
  return batch.size > 0 ? batch : null;
}

/** 隐藏状态仅由隐藏画册的直接成员增删推导。 */
export function reduceHiddenChanges(events: readonly KbEvent<AlbumImagesChangePayload>[]): ImagePatchBatch | null {
  const batch: ImagePatchBatch = new Map();
  for (const { payload } of events) {
    if (!payload.albumIds.includes(HIDDEN_ALBUM_ID)) continue;
    const isHidden = payload.reason === "add-hidden" ? true : payload.reason === "delete-hidden" ? false : null;
    if (isHidden !== null) mergeInto(batch, payload.imageIds, { isHidden });
  }
  return batch.size > 0 ? batch : null;
}

/** 一串 album-images-change → 收藏补丁：只看收藏画册的成员增删，按到达顺序取最后一次。 */
export function reduceFavoriteChanges(events: readonly KbEvent<AlbumImagesChangePayload>[]): ImagePatchBatch | null {
  const batch: ImagePatchBatch = new Map();
  for (const { payload } of events) {
    if (!(payload.albumIds ?? []).includes(FAVORITE_ALBUM_ID)) continue;
    const favorite =
      payload.reason === "add" || payload.reason === "add-hidden"
        ? true
        : payload.reason === "delete" || payload.reason === "delete-hidden"
          ? false
          : null;
    if (favorite !== null) mergeInto(batch, payload.imageIds ?? [], { favorite });
  }
  return batch.size > 0 ? batch : null;
}

/** 图片字段、收藏、隐藏成员各自合并，只给已在手的对象打补丁，不发请求。 */
export function imagePatches$(waitMs: number, opts: { patchHidden: () => boolean }): Observable<ImagePatchBatch> {
  return merge(
    merge(kbEvent$<ImageChangedPayload>("image-changed"), kbEvent$<ImagesChangePayload>("images-change")).pipe(
      batchWindow(waitMs, reducePatches),
    ),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(
      filter(() => opts.patchHidden()),
      batchWindow(waitMs, reduceHiddenChanges),
    ),
  );
}
