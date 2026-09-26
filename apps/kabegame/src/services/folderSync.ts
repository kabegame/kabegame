//! 文件夹画册同步服务（前端运行态镜像与 toast）。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { cancelFolderSync } from "@/api/syncLocalFolder";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import {
  type FolderSyncFinished,
  type FolderSyncRunState,
  type FolderSyncTask,
  useFolderSyncStore,
} from "@/stores/folderSync";

let unlistenProgress: UnlistenFn | null = null;
let unlistenFinished: UnlistenFn | null = null;

function disabled(): boolean {
  return IS_ANDROID || IS_WEB;
}

export async function init(): Promise<void> {
  if (disabled()) return;
  const store = useFolderSyncStore();
  try {
    store.applyRunState(
      await invoke<FolderSyncRunState>("get_folder_sync_run_state"),
    );
  } catch (error) {
    console.warn("[folderSync] get_folder_sync_run_state failed:", error);
  }

  unlistenProgress = await listen<FolderSyncTask>(
    "folder-sync-progress",
    (event) => {
      store.applyProgress(event.payload);
    },
  );
  unlistenFinished = await listen<FolderSyncFinished>(
    "folder-sync-finished",
    (event) => {
      const payload = event.payload;
      store.applyFinished(payload);
      if (payload.preempted) return;
      if (payload.error) {
        ElMessage.error(
          i18n.global.t("albums.syncFailedToast", { name: payload.albumName }),
        );
        return;
      }
      if (payload.canceled) {
        ElMessage.info(
          i18n.global.t("albums.syncCanceledToast", {
            name: payload.albumName,
          }),
        );
        return;
      }
      if (payload.removedAlbum) {
        ElMessage.warning(
          i18n.global.t("albums.folderRemovedToast", {
            name: payload.albumName,
          }),
        );
        return;
      }
      if (payload.manual && payload.skippedUnchanged) {
        ElMessage.info(
          i18n.global.t("albums.localFolder.syncSkippedUnchanged"),
        );
        return;
      }
      const changed = payload.added + payload.deleted + payload.reimported +
        payload.createdAlbums;
      // 手动触发的任务即使无变化也要给反馈；自动任务只在有变化时提示
      if (changed > 0 || payload.manual) {
        ElMessage.success(
          i18n.global.t("albums.localFolder.syncDone", {
            added: payload.added,
            deleted: payload.deleted,
            reimported: payload.reimported,
          }),
        );
      }
    },
  );
}

export function dispose(): void {
  unlistenProgress?.();
  unlistenFinished?.();
  unlistenProgress = unlistenFinished = null;
}

/**
 * 取消同步：传 albumId 取消单个，不传取消全部。
 * 卡片的消失与「已取消」toast 都由 `folder-sync-finished` 事件驱动，这里只负责转发与报错。
 */
export async function cancel(albumId?: string): Promise<void> {
  if (disabled()) return;
  try {
    await cancelFolderSync(albumId);
  } catch (error) {
    console.error("[folderSync] cancel_folder_sync failed:", error);
    ElMessage.error(i18n.global.t("albums.syncCancelFailedToast"));
  }
}
