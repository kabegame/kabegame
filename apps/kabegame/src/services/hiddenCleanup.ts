//! 清理隐藏图片服务（前端镜像编排）。
//!
//! 运行状态由后端 `HiddenCleanupService` 权威维护；本模块负责 hydrate、事件订阅、
//! 用户操作转发，以及清理任务的所有 toast。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import {
  useHiddenCleanupStore,
  type HiddenCleanupFinished,
  type HiddenCleanupProgress,
  type HiddenCleanupRunState,
} from "@/stores/hiddenCleanup";

let unlistenProgress: UnlistenFn | null = null;
let unlistenFinished: UnlistenFn | null = null;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function init(): Promise<void> {
  const store = useHiddenCleanupStore();
  try {
    store.applyRunState(await invoke<HiddenCleanupRunState>("get_hidden_cleanup_run_state"));
  } catch (error) {
    console.warn("[hiddenCleanup] get_hidden_cleanup_run_state failed:", error);
  }

  unlistenProgress = await listen<HiddenCleanupProgress>("hidden-cleanup-progress", (event) => {
    store.applyProgress(event.payload);
  });
  unlistenFinished = await listen<HiddenCleanupFinished>("hidden-cleanup-finished", (event) => {
    const payload = event.payload;
    store.applyFinished(payload);
    if (payload.error) {
      ElMessage.error(i18n.global.t("gallery.hiddenCleanupFailed"));
    } else if (payload.canceled) {
      ElMessage.info(i18n.global.t("gallery.hiddenCleanupCanceled"));
    } else if ((payload.keptFiles ?? 0) > 0) {
      // 源文件没删干净时如实说明，不要用「完成」盖过去
      ElMessage.warning(
        i18n.global.t("gallery.hiddenCleanupDonePartial", {
          removed: payload.removed ?? 0,
          kept: payload.keptFiles ?? 0,
        }),
      );
    } else {
      ElMessage.success(
        i18n.global.t("gallery.hiddenCleanupDone", { removed: payload.removed ?? 0 }),
      );
    }
  });
}

export function dispose(): void {
  unlistenProgress?.();
  unlistenFinished?.();
  unlistenProgress = unlistenFinished = null;
}

/** `total` 仅用于在首个进度事件到达前把分母填上，后端仍是权威。 */
export async function start(total: number): Promise<void> {
  const store = useHiddenCleanupStore();
  if (store.running) return;

  store.begin(total);
  try {
    await invoke("start_hidden_cleanup");
  } catch (error) {
    console.error("[hiddenCleanup] start_hidden_cleanup failed:", error);
    store.applyFinished({
      removed: 0,
      keptFiles: 0,
      canceled: false,
      error: errorMessage(error),
    });
    ElMessage.error(i18n.global.t("gallery.startHiddenCleanupFailed"));
  }
}

export async function cancel(): Promise<void> {
  const store = useHiddenCleanupStore();
  if (!store.running) return;
  try {
    await invoke<boolean>("cancel_hidden_cleanup");
  } catch (error) {
    console.error("[hiddenCleanup] cancel_hidden_cleanup failed:", error);
    ElMessage.error(i18n.global.t("gallery.cancelHiddenCleanupFailed"));
  }
}
