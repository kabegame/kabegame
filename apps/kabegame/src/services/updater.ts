//! 应用自动更新服务（前端镜像编排）。
//!
//! 状态归后端 `UpdaterService` 权威；本模块只负责：启动 hydrate + 订阅事件 +
//! 转发用户操作（手动检查 / 下载 / 取消 / 重启）。调度在后端，前端不再 setInterval。

import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { IS_WEB, IS_ANDROID } from "@kabegame/core/env";
import { kameMessage } from "@kabegame/core/utils/kameMessage";
import {
  useUpdaterStore,
  type DownloadProgress,
  type ReleaseInfo,
  type UpdaterPhase,
  type UpdaterState,
} from "@/stores/updater";

let unlistenState: UnlistenFn | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

/** 桌面以外（web / android）全程 noop：后端命令在这些目标未注册。 */
function disabled(): boolean {
  return IS_WEB || IS_ANDROID;
}

/** App.vue onMounted 调一次：hydrate 当前状态 + 订阅三事件。 */
export async function init(): Promise<void> {
  if (disabled()) return;
  const store = useUpdaterStore();

  // 1) 启动 hydrate（与 organize 一致；刷新页面也靠它恢复状态）
  try {
    store.applyState(await invoke<UpdaterState>("get_updater_state"));
  } catch (e) {
    console.warn("[updater] get_updater_state failed:", e);
  }

  // 2) 订阅后端事件
  unlistenState = await listen<UpdaterState>("updater-state-change", (e) => {
    store.applyState(e.payload);
  });
  unlistenProgress = await listen<DownloadProgress>("update-download-progress", (e) => {
    store.applyProgress(e.payload);
  });
  unlistenError = await listen<{ message?: string }>("update-download-error", (e) => {
    const msg = e.payload?.message ?? "";
    store.setDownloadError(msg);
    if (msg) kameMessage.error(msg); // 龟酱播报错误
  });
}

export function dispose(): void {
  unlistenState?.();
  unlistenProgress?.();
  unlistenError?.();
  unlistenState = unlistenProgress = unlistenError = null;
}

/** 手动触发检查（Settings 按钮）。busy 时后端 no-op。返回最新快照的 phase。 */
export async function checkNow(): Promise<UpdaterPhase | null> {
  if (disabled()) return null;
  const store = useUpdaterStore();
  try {
    const snap = await invoke<UpdaterState>("check_for_updates");
    store.applyState(snap);
    return snap.phase;
  } catch (e) {
    console.warn("[updater] check_for_updates failed:", e);
    return null;
  }
}

/** 开始下载某 release（仅 updateAvailable 可进入；下载/检查中后端拒绝）。 */
export async function downloadAndStage(r: ReleaseInfo): Promise<void> {
  if (disabled()) return;
  await invoke("download_update", {
    tag: r.tag,
    assetUrl: r.assetUrl,
    assetName: r.assetName,
  });
}

/** 取消进行中的下载。 */
export async function cancelDownload(): Promise<void> {
  if (disabled()) return;
  await invoke("cancel_download");
}

/** 应用已下载更新并重启（restartable 下调用）。 */
export async function applyUpdateAndRestart(): Promise<void> {
  if (disabled()) return;
  await invoke("apply_update_and_restart");
}
