import { invoke } from "@/api/rpc";
import { IS_MACOS } from "@kabegame/core/env";

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

export async function syncLocalFolderAlbum(
  albumId: string,
): Promise<SyncReport | null> {
  if (!IS_MACOS) return null;
  try {
    return await invoke<SyncReport>("sync_local_folder_album", { albumId });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_album failed", albumId, e);
    throw e;
  }
}

export async function syncLocalFolderAlbums(
  albumIds: string[],
): Promise<BatchSyncItem[]> {
  if (!IS_MACOS || albumIds.length === 0) return [];
  try {
    return await invoke<BatchSyncItem[]>("sync_local_folder_albums", { albumIds });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_albums invoke failed", albumIds, e);
    const msg = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
    return albumIds.map((albumId) => ({ albumId, ok: null, err: msg }));
  }
}
