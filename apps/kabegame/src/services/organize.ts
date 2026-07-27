//! 图库整理服务（前端镜像编排）。
//!
//! 运行状态由后端 `OrganizeService` 权威维护；本模块负责 hydrate、事件订阅、
//! 用户操作转发，以及整理任务的所有 toast。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import {
  useOrganizeStore,
  type OrganizeFinished,
  type OrganizeOptions,
  type OrganizeProgress,
  type OrganizeRunState,
} from "@/stores/organize";

let unlistenProgress: UnlistenFn | null = null;
let unlistenFinished: UnlistenFn | null = null;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function init(): Promise<void> {
  const store = useOrganizeStore();
  try {
    store.applyRunState(await invoke<OrganizeRunState>("get_organize_run_state"));
  } catch (error) {
    console.warn("[organize] get_organize_run_state failed:", error);
  }

  unlistenProgress = await listen<OrganizeProgress>("organize-progress", (event) => {
    store.applyProgress(event.payload);
  });
  unlistenFinished = await listen<OrganizeFinished>("organize-finished", (event) => {
    const payload = event.payload;
    store.applyFinished(payload);
    if (payload.error) {
      ElMessage.error(i18n.global.t("gallery.organizeFailed"));
    } else if (payload.canceled) {
      ElMessage.info(i18n.global.t("gallery.organizeCanceled"));
    } else {
      ElMessage.success(
        i18n.global.t("gallery.organizeDone", {
          removed: payload.removed ?? 0,
          regenerated: payload.regenerated ?? 0,
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

export async function start(options: OrganizeOptions): Promise<void> {
  const store = useOrganizeStore();
  if (store.running) return;

  store.begin(options);
  try {
    await invoke("start_organize", {
      args: {
        dedupe: options.dedupe,
        dedupeKeepNew: options.dedupeKeepNew,
        removeMissing: options.removeMissing,
        removeUnrecognized: options.removeUnrecognized,
        regenThumbnails: options.regenThumbnails,
        regenCompatible: options.regenCompatible,
        backfillNativeMetadata: options.backfillNativeMetadata,
        deleteSourceFiles: options.deleteSourceFiles,
        rangeStart: options.rangeStart,
        rangeEnd: options.rangeEnd,
      },
    });
  } catch (error) {
    console.error("[organize] start_organize failed:", error);
    store.applyFinished({
      removed: 0,
      regenerated: 0,
      backfilled: 0,
      canceled: false,
      error: errorMessage(error),
    });
    ElMessage.error(i18n.global.t("gallery.startOrganizeFailed"));
  }
}

export async function cancel(): Promise<void> {
  const store = useOrganizeStore();
  if (!store.running) return;
  try {
    await invoke<boolean>("cancel_organize");
  } catch (error) {
    console.error("[organize] cancel_organize failed:", error);
    ElMessage.error(i18n.global.t("gallery.cancelOrganizeFailed"));
  }
}
