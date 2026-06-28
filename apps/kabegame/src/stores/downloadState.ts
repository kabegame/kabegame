import { defineStore } from "pinia";
import { reactive } from "vue";
import { invoke, listen, type UnlistenFn } from "@/api/rpc";

export type DownloadEntry = {
  id: number;
  url: string;
  state: string;
  progress?: number;
  pluginId?: string;
  retriedFor?: number;
  native?: boolean;
};

export type DownloadStatePayload = {
  id: number;
  url: string;
  state: string;
  pluginId?: string;
  retriedFor?: number;
  /** 仅 `get_active_downloads` 快照携带；用于初始化恢复进度 */
  receivedBytes?: number;
  totalBytes?: number | null;
  native?: boolean;
};

export type DownloadProgressPayload = {
  id: number;
  receivedBytes: number;
  totalBytes?: number;
};

/**
 * 全局下载状态 store。
 * 规则：
 * - `download-state` 事件到达 → upsert（任意状态，不过滤终态）
 * - `download-progress` 事件到达 → 更新 progress
 * - `download-removed` 事件到达 → 删除条目（唯一移除时机）
 */
export const useDownloadStateStore = defineStore("downloadState", () => {
  const map = reactive<Record<number, DownloadEntry>>({});

  let inited = false;
  let unlistenState: UnlistenFn | null = null;
  let unlistenProgress: UnlistenFn | null = null;
  let unlistenRemoved: UnlistenFn | null = null;

  const progressFromBytes = (received?: number, total?: number | null): number | undefined =>
    total != null && total > 0 && received != null
      ? Math.min(100, Math.round((received / total) * 100))
      : undefined;

  const applyState = (p: DownloadStatePayload) => {
    const id = p.id;
    if (id == null) return;
    const snapshotProgress = progressFromBytes(p.receivedBytes, p.totalBytes);
    map[id] = {
      ...(map[id] || {}),
      id,
      url: p.url,
      state: String(p.state ?? "").trim(),
      pluginId: p.pluginId,
      retriedFor: p.retriedFor,
      native: p.native,
      ...(snapshotProgress != null ? { progress: snapshotProgress } : {}),
    };
  };

  const applyProgress = (p: DownloadProgressPayload) => {
    const id = p.id;
    if (id == null || !map[id]) return;
    const progress = progressFromBytes(p.receivedBytes, p.totalBytes);
    map[id] = { ...map[id], progress };
  };

  const applyRemoved = (id: number) => {
    delete map[id];
  };

  const init = async () => {
    if (inited) return;
    inited = true;
    try {
      const rows = await invoke<DownloadStatePayload[]>("get_active_downloads");
      for (const r of Array.isArray(rows) ? rows : []) {
        applyState(r);
      }
    } catch (e) {
      console.error("初始化进行中下载快照失败:", e);
    }
    unlistenState = await listen<DownloadStatePayload>("download-state", (event) => {
      applyState(event.payload);
    });
    unlistenProgress = await listen<DownloadProgressPayload>("download-progress", (event) =>
      applyProgress(event.payload)
    );
    unlistenRemoved = await listen<{ id: number }>("download-removed", (event) =>
      applyRemoved(Number(event.payload.id))
    );
  };

  const getByUrl = (url: string): DownloadEntry | undefined =>
    Object.values(map).find((e) => e.url === url);

  const getByFailedImageId = (failedImageId: number): DownloadEntry | undefined =>
    Object.values(map).find((e) => e.retriedFor === failedImageId);

  const dispose = () => {
    unlistenState?.();
    unlistenProgress?.();
    unlistenRemoved?.();
    unlistenState = null;
    unlistenProgress = null;
    unlistenRemoved = null;
    inited = false;
  };

  return { init, getByUrl, getByFailedImageId, dispose };
});
