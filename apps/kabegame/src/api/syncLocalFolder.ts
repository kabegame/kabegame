import { invoke } from "@/api/rpc";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import type { AlbumSyncMode } from "@kabegame/core/types/album";

export type { AlbumSyncMode } from "@kabegame/core/types/album";

/** 本地文件夹同步仅桌面端支持（排除 Android 与 Web）。 */
const LOCAL_FOLDER_UNSUPPORTED = IS_ANDROID || IS_WEB;

export type FolderSyncDescend = "none" | "existing" | "createMissing";

export type SettableAlbumSyncMode = Exclude<AlbumSyncMode, "delegated">;

export async function syncLocalFolderAlbum(
  albumId: string,
  descend: FolderSyncDescend = "none",
): Promise<void> {
  if (LOCAL_FOLDER_UNSUPPORTED) return;
  try {
    await invoke("sync_local_folder_album", { albumId, descend });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_album failed", albumId, e);
    throw e;
  }
}

/** 设置画册的持续同步意图；delegated 仅由后端状态机维护，不能由调用方直接设置。 */
export async function setAlbumSyncMode(
  albumId: string,
  mode: SettableAlbumSyncMode,
): Promise<void> {
  if (LOCAL_FOLDER_UNSUPPORTED) return;
  await invoke("set_album_sync_mode", { albumId, mode });
}

/** 将本地文件夹画册及其全部后代脱钩并转换为普通画册。 */
export async function convertLocalFolderAlbumToNormal(
  albumId: string,
): Promise<void> {
  if (LOCAL_FOLDER_UNSUPPORTED) return;
  await invoke("convert_local_folder_album_to_normal", { albumId });
}

/**
 * 取消进行中的文件夹同步：传 albumId 取消单个，不传取消全部。
 * 返回实际被置位的任务数（已结束的任务不计）。
 */
export async function cancelFolderSync(albumId?: string): Promise<number> {
  if (LOCAL_FOLDER_UNSUPPORTED) return 0;
  const result = await invoke<{ canceled: number }>("cancel_folder_sync", {
    albumId: albumId ?? null,
  });
  return result?.canceled ?? 0;
}
