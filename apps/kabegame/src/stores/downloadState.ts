import { defineStore } from "pinia";
import { computed, reactive } from "vue";
import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { useSnapshotPoller } from "@/composables/useSnapshotPoller";

export type ActiveDownloadInfo = {
  id: number;
  url: string;
  pluginId: string;
  startTime: number;
  taskId: string;
  state: string;
  retriedFor: number | null;
  receivedBytes: number;
  totalBytes: number | null;
  progress?: number;
  error?: string | null;
};

export type DownloadStatePayload = Partial<ActiveDownloadInfo> & Pick<ActiveDownloadInfo, "id" | "url" | "state">;

const isTerminal = (state: string) => state === "completed" || state === "failed" || state === "canceled";

export const downloadPoller = useSnapshotPoller<ActiveDownloadInfo[]>({
  key: "active-downloads",
  fetch: () => invoke<ActiveDownloadInfo[]>("get_active_downloads"),
  apply: (snapshot) => useDownloadStateStore().applySnapshot(snapshot),
  isActive: (snapshot) => snapshot.some((download) => !isTerminal(download.state)),
  wakeEvents: ["download-state"],
});

/** 下载数据的唯一前端镜像：状态事件即时更新，字节进度与整表生命周期由快照轮询校准。 */
export const useDownloadStateStore = defineStore("downloadState", () => {
  const map = reactive<Record<number, ActiveDownloadInfo>>({});

  let inited = false;
  let unlistenState: UnlistenFn | null = null;
  let unlistenRemoved: UnlistenFn | null = null;

  const entries = computed(() => Object.values(map));

  const applyState = (payload: DownloadStatePayload) => {
    const id = Number(payload.id);
    if (!Number.isFinite(id)) return;
    const previous = map[id];
    const receivedBytes = payload.receivedBytes ?? previous?.receivedBytes ?? 0;
    const totalBytes = payload.totalBytes === undefined ? (previous?.totalBytes ?? null) : payload.totalBytes;
    map[id] = {
      id,
      url: payload.url ?? previous?.url ?? "",
      pluginId: payload.pluginId ?? previous?.pluginId ?? "",
      startTime: payload.startTime ?? previous?.startTime ?? 0,
      taskId: payload.taskId ?? previous?.taskId ?? "",
      state: String(payload.state ?? previous?.state ?? "").trim(),
      retriedFor: payload.retriedFor ?? previous?.retriedFor ?? null,
      receivedBytes,
      totalBytes,
      progress:
        totalBytes != null && totalBytes > 0
          ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
          : undefined,
      error: payload.error ?? previous?.error ?? null,
    };
  };

  const applySnapshot = (snapshot: ActiveDownloadInfo[]) => {
    // 后端会短暂保留终态条目供事件消费者观察；对前端镜像而言，终态快照就是权威收尾。
    // 这样即使 download-removed 丢失，条目也会在下一次快照中消失。
    const rows = (Array.isArray(snapshot) ? snapshot : []).filter((row) => !isTerminal(row.state));
    const alive = new Set(rows.map((row) => Number(row.id)));
    for (const id of Object.keys(map)) {
      if (!alive.has(Number(id))) delete map[Number(id)];
    }
    for (const row of rows) applyState(row);
  };

  const init = async () => {
    if (inited) return;
    inited = true;
    unlistenState = await listen<DownloadStatePayload>("download-state", (event) => {
      applyState(event.payload);
    });
    unlistenRemoved = await listen<{ id: number }>("download-removed", (event) => {
      downloadPoller.invalidate();
      delete map[Number(event.payload.id)];
    });
    await downloadPoller.start();
  };

  const getByUrl = (url: string): ActiveDownloadInfo | undefined => entries.value.find((entry) => entry.url === url);

  const getByFailedImageId = (failedImageId: number): ActiveDownloadInfo | undefined =>
    entries.value.find((entry) => entry.retriedFor === failedImageId);

  const dispose = () => {
    unlistenState?.();
    unlistenRemoved?.();
    unlistenState = null;
    unlistenRemoved = null;
    downloadPoller.dispose();
    inited = false;
  };

  return { entries, init, applySnapshot, getByUrl, getByFailedImageId, dispose };
});
