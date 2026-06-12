import { defineStore } from "pinia";
import { reactive } from "vue";
import { invoke, listen, type UnlistenFn } from "@/api/rpc";

/** 单条进行中下载的状态 */
export type DownloadEntry = {
  id: number;
  url: string;
  /** 仅存储进行中的状态：preparing | downloading | processing */
  state: string;
  /** 0–100；当总大小未知时为 undefined（前端按不确定进度处理） */
  progress?: number;
  taskId?: string;
  pluginId?: string;
  /** 关联的 FailedImage 记录 ID */
  retriedFor?: number;
};

/** 后端上报的 camelCase 原始负载类型 */
export type DownloadStatePayload = {
  id: number;
  url: string;
  state: string;
  taskId?: string;
  pluginId?: string;
  retriedFor?: number;
};

export type DownloadProgressPayload = {
  id: number;
  receivedBytes: number;
  totalBytes?: number;
};

/** 进行中（需要展示进度/状态）的下载状态集合 */
const ACTIVE_STATES = ["preparing", "downloading", "processing"];

/**
 * 全局下载状态 store：启动时从后端 `get_active_downloads` 拉取一次快照，
 * 之后由 `download-state` / `download-progress` 事件驱动增量更新。
 * 仅保留进行中的条目；终态（completed/failed/canceled）从 map 中移除。
 */
export const useDownloadStateStore = defineStore("downloadState", () => {
  // 以 ID 为键（同一 URL 可能有并发尝试，通过 ID 隔离）
  const map = reactive<Record<number, DownloadEntry>>({});

  let inited = false;
  let unlistenState: UnlistenFn | null = null;
  let unlistenProgress: UnlistenFn | null = null;

  const applyState = (p: DownloadStatePayload) => {
    const id = p.id;
    if (id == null) return;
    const state = String(p.state ?? "").trim();
    if (ACTIVE_STATES.includes(state)) {
      map[id] = {
        ...(map[id] || {}),
        id,
        url: p.url,
        state,
        taskId: p.taskId,
        pluginId: p.pluginId,
        retriedFor: p.retriedFor,
      };
    } else {
      // 终态：completed / failed / canceled —— 从进行中集合移除
      delete map[id];
    }
  };

  const applyProgress = (p: DownloadProgressPayload) => {
    const id = p.id;
    if (id == null || !map[id]) return;
    const received = p.receivedBytes ?? 0;
    const total = p.totalBytes;
    const progress =
      total != null && total > 0
        ? Math.min(100, Math.round((received / total) * 100))
        : undefined;
    map[id] = { ...map[id], state: "downloading", progress };
  };

  /** 启动初始化：拉取快照 + 订阅事件（幂等，重复调用无副作用） */
  const init = async () => {
    if (inited) return;
    inited = true;
    // 1. 快照水合：恢复进程内仍在进行中的下载（含 HTTP 与 native）
    try {
      const rows = await invoke<DownloadStatePayload[]>("get_active_downloads");
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.id != null && ACTIVE_STATES.includes(r.state)) {
          applyState(r);
        }
      }
    } catch (e) {
      console.error("初始化进行中下载快照失败:", e);
    }
    // 2. 事件驱动增量更新
    unlistenState = await listen<DownloadStatePayload>("download-state", (event) =>
      applyState(event.payload)
    );
    unlistenProgress = await listen<DownloadProgressPayload>("download-progress", (event) =>
      applyProgress(event.payload)
    );
  };

  const getByUrl = (url: string): DownloadEntry | undefined =>
    Object.values(map).find((e) => e.url === url);

  const getByFailedImageId = (failedImageId: number): DownloadEntry | undefined =>
    Object.values(map).find((e) => e.retriedFor === failedImageId);

  const isActive = (url: string) => {
    const e = getByUrl(url);
    return !!e && ACTIVE_STATES.includes(e.state);
  };

  const dispose = () => {
    unlistenState?.();
    unlistenProgress?.();
    unlistenState = null;
    unlistenProgress = null;
    inited = false;
  };

  return { map, init, getByUrl, getByFailedImageId, isActive, dispose };
});
