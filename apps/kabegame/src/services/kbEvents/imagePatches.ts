import { merge, type Observable } from "rxjs";
import type { ImageChangedPayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import type { ImageInfo } from "@/types/image";
import { FAVORITE_ALBUM_ID } from "@/services/albums";
import { batchWindow } from "./batchWindow";
import { kbEvent$, type KbEvent } from "./eventSource";

/** imageId → 这一批内合并后的字段绝对值。 */
export type ImagePatchBatch = Map<string, Partial<ImageInfo>>;

function mergeInto(batch: ImagePatchBatch, imageIds: readonly string[], fields: Partial<ImageInfo>) {
  for (const id of imageIds) {
    if (id) batch.set(id, { ...batch.get(id), ...fields });
  }
}

/** 一串 image-changed → 字段补丁；同一 id 后到的字段覆盖先到的。 */
export function reduceImageChanged(events: readonly KbEvent<ImageChangedPayload>[]): ImagePatchBatch | null {
  const batch: ImagePatchBatch = new Map();
  for (const { payload } of events) {
    for (const patch of payload.patches ?? []) mergeInto(batch, patch.imageIds ?? [], patch.diff ?? {});
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

/**
 * 图片字段补丁流：image-changed 与收藏画册成员变更各自防抖、各自合并，再汇成一条。
 * 两者改的字段不重叠（image-changed 不带 favorite），所以两条流之间不需要排序。
 * 只给已在手的对象打补丁，不发请求。
 */
export function imagePatches$(waitMs: number): Observable<ImagePatchBatch> {
  return merge(
    kbEvent$<ImageChangedPayload>("image-changed").pipe(batchWindow(waitMs, reduceImageChanged)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
  );
}
