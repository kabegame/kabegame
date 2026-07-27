//! 文件夹画册同步服务（前端运行态镜像与 toast）。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import {
  useFolderSyncStore,
  type FolderSyncFinished,
  type FolderSyncRunState,
  type FolderSyncTask,
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
    store.applyRunState(await invoke<FolderSyncRunState>("get_folder_sync_run_state"));
  } catch (error) {
    console.warn("[folderSync] get_folder_sync_run_state failed:", error);
  }

  unlistenProgress = await listen<FolderSyncTask>("folder-sync-progress", (event) => {
    store.applyProgress(event.payload);
  });
  unlistenFinished = await listen<FolderSyncFinished>("folder-sync-finished", (event) => {
    const payload = event.payload;
    store.applyFinished(payload);
    if (payload.error) {
      ElMessage.error(i18n.global.t("albums.syncFailedToast", { name: payload.albumName }));
      return;
    }
    const changed = payload.added + payload.deleted + payload.reimported + payload.createdAlbums;
    if (changed > 0) {
      ElMessage.success(
        i18n.global.t("albums.syncDoneToast", {
          name: payload.albumName,
          added: payload.added,
        }),
      );
    }
  });
}

export function dispose(): void {
  unlistenProgress?.();
  unlistenFinished?.();
  unlistenProgress = unlistenFinished = null;
}
