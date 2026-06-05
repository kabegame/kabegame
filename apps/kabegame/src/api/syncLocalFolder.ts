import { invoke } from "@/api/rpc";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";

/** 本地文件夹同步仅桌面端支持（排除 Android 与 Web）。 */
const LOCAL_FOLDER_UNSUPPORTED = IS_ANDROID || IS_WEB;

export type FolderStatusState =
  | "ok"
  | "missing"
  | "denied"
  | "not_a_dir"
  | "io_error";

export interface FolderStatusPayload {
  state: FolderStatusState;
  checkedAt?: number;
  checked_at?: number;
  lastSyncedAtMs?: number;
  last_synced_at_ms?: number;
  message?: string;
}

export interface SyncReport {
  albumId: string;
  status: FolderStatusPayload | null;
  added: number;
  deleted: number;
  reimported: number;
  skippedUnstable: number;
  skippedInFlight: boolean;
  skippedUnchanged: boolean;
}

export interface BatchSyncItem {
  albumId: string;
  ok: SyncReport | null;
  err: string | null;
}

export interface RecursiveSyncReport {
  albumId: string;
  createdAlbums: number;
  syncedAlbums: number;
  added: number;
  deleted: number;
  reimported: number;
  failed: number;
}

export interface SyncLocalFolderAlbumOptions {
  recursive?: boolean;
  createMissingAlbums?: boolean;
}

export function syncLocalFolderAlbum(
  albumId: string,
  options: { recursive: true; createMissingAlbums?: boolean },
): Promise<RecursiveSyncReport | null>;
export function syncLocalFolderAlbum(
  albumId: string,
  options?: { recursive?: false; createMissingAlbums?: boolean },
): Promise<SyncReport | null>;
export async function syncLocalFolderAlbum(
  albumId: string,
  options: SyncLocalFolderAlbumOptions = {},
): Promise<SyncReport | RecursiveSyncReport | null> {
  if (LOCAL_FOLDER_UNSUPPORTED) return null;
  try {
    return await invoke<SyncReport | RecursiveSyncReport>("sync_local_folder_album", {
      albumId,
      recursive: options.recursive ?? false,
      createMissingAlbums: options.createMissingAlbums ?? true,
    });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_album failed", albumId, e);
    throw e;
  }
}

export async function syncLocalFolderAlbums(
  albumIds: string[],
): Promise<BatchSyncItem[]> {
  if (LOCAL_FOLDER_UNSUPPORTED || albumIds.length === 0) return [];
  try {
    return await invoke<BatchSyncItem[]>("sync_local_folder_albums", { albumIds });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_albums invoke failed", albumIds, e);
    const msg = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
    return albumIds.map((albumId) => ({ albumId, ok: null, err: msg }));
  }
}
