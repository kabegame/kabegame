import { invoke } from "@/api/rpc";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import type { AlbumSyncMode } from "@kabegame/core/types/album";

export type { AlbumSyncMode } from "@kabegame/core/types/album";

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
  /** 递归同步新建的子画册数；非递归恒为 0。 */
  createdAlbums: number;
  /** 递归同步涉及的画册数（含被快速同步跳过的）；非递归恒为 0。 */
  syncedAlbums: number;
  /** 递归同步中因目录已消失而落 missing 状态的子画册数；非递归恒为 0。 */
  failed: number;
  skippedInFlight: boolean;
  /** 快速同步：整次同步因根目录未变而被跳过（非递归）。后端不扫不写，added/deleted/reimported 恒为 0。 */
  skippedUnchanged: boolean;
  /** 快速同步：跳过文件扫描的目录数（递归同步专用，逐目录累计）。非递归的整次跳过用 skippedUnchanged 表示，此字段恒为 0。 */
  skippedUnchangedDirs: number;
  /** 被用户取消：已扫到的照常入库，未扫到的一律不动（不删图、不推进 lastSyncedAtMs）。 */
  canceled: boolean;
}

export interface BatchSyncItem {
  albumId: string;
  ok: SyncReport | null;
  err: string | null;
}

/** @deprecated 后端已把递归/非递归报告合并为统一的 SyncReport，保留别名兼容既有 import。 */
export type RecursiveSyncReport = SyncReport;

export interface SyncLocalFolderAlbumOptions {
  recursive?: boolean;
  createMissingAlbums?: boolean;
}

export type SettableAlbumSyncMode = Exclude<AlbumSyncMode, "delegated">;

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

/** 设置画册的持续同步意图；delegated 仅由后端状态机维护，不能由调用方直接设置。 */
export async function setAlbumSyncMode(
  albumId: string,
  mode: SettableAlbumSyncMode,
): Promise<void> {
  if (LOCAL_FOLDER_UNSUPPORTED) return;
  await invoke("set_album_sync_mode", { albumId, mode });
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
