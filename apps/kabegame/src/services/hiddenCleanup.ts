//! 清理隐藏图片服务（前端镜像编排）。
//!
//! 运行状态由后端 `HiddenCleanupService` 权威维护；本模块负责完成事件订阅、
//! 用户操作转发，以及清理任务的所有 toast。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { useHiddenCleanupStore, type HiddenCleanupFinished } from "@/stores/hiddenCleanup";
import { busyPoller } from "@/services/busyTasks";

let unlistenFinished: UnlistenFn | null = null;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function init(): Promise<void> {
  const store = useHiddenCleanupStore();
  unlistenFinished = await listen<HiddenCleanupFinished>("hidden-cleanup-finished", (event) => {
    const payload = event.payload;
    busyPoller.invalidate();
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
      ElMessage.success(i18n.global.t("gallery.hiddenCleanupDone", { removed: payload.removed ?? 0 }));
    }
  });
}

export function dispose(): void {
  unlistenFinished?.();
  unlistenFinished = null;
}

/** `total` 仅用于启动窗口内先填充进度分母，后端快照仍是权威。 */
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
  } finally {
    store.endStarting();
    busyPoller.invalidate();
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
