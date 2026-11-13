//! 图库整理服务（前端镜像编排）。
//!
//! 运行状态由后端 `OrganizeService` 权威维护；本模块负责完成事件订阅、
//! 用户操作转发，以及整理任务的所有 toast。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { useOrganizeStore, type OrganizeFinished, type OrganizeOptions } from "@/stores/organize";
import { busyPoller } from "@/services/busyTasks";

let unlistenFinished: UnlistenFn | null = null;

/**
 * 整理成功完成时的提示文案。本次勾了「重新计算代表色」（或确实更新了代表色）才带上代表色计数；
 * 运行态快照可能先于完成事件把本次参数清掉，所以计数大于 0 也算。
 */
export function organizeDoneMessage(
  payload: OrganizeFinished,
  recomputePalette: boolean,
): { key: string; params: Record<string, number> } {
  const params = {
    removed: payload.removed ?? 0,
    regenerated: payload.regenerated ?? 0,
  };
  const palettes = payload.palettesUpdated ?? 0;
  if (recomputePalette || palettes > 0) {
    return { key: "gallery.organizeDoneWithPalette", params: { ...params, palettes } };
  }
  return { key: "gallery.organizeDone", params };
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function init(): Promise<void> {
  const store = useOrganizeStore();
  unlistenFinished = await listen<OrganizeFinished>("organize-finished", (event) => {
    const payload = event.payload;
    // applyFinished 会清掉本次参数，先取出来
    const recomputePalette = store.lastRunOptions?.recomputePalette ?? false;
    busyPoller.invalidate();
    store.applyFinished(payload);
    if (payload.error) {
      kameMessage.error(i18n.global.t("gallery.organizeFailed"));
    } else if (payload.canceled) {
      kameMessage.info(i18n.global.t("gallery.organizeCanceled"));
    } else {
      const { key, params } = organizeDoneMessage(payload, recomputePalette);
      kameMessage.success(i18n.global.t(key, params));
    }
  });
}

export function dispose(): void {
  unlistenFinished?.();
  unlistenFinished = null;
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
        recomputePalette: options.recomputePalette,
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
      palettesUpdated: 0,
      canceled: false,
      error: errorMessage(error),
    });
    kameMessage.error(i18n.global.t("gallery.startOrganizeFailed"));
  } finally {
    store.endStarting();
    busyPoller.invalidate();
  }
}

export async function cancel(): Promise<void> {
  const store = useOrganizeStore();
  if (!store.running) return;
  try {
    await invoke<boolean>("cancel_organize");
  } catch (error) {
    console.error("[organize] cancel_organize failed:", error);
    kameMessage.error(i18n.global.t("gallery.cancelOrganizeFailed"));
  }
}
