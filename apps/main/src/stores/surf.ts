import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ImageInfo } from "@kabegame/core/types/image";

export interface SurfRecord {
  id: string;
  host: string;
  name: string;
  rootUrl: string;
  cookie: string;
  icon?: number[] | null;
  lastVisitAt: number;
  /** 累计成功下载次数（入库计次） */
  downloadCount: number;
  /** 累计删除张数 */
  deletedCount: number;
  /** 当前 `images` 表中关联条数 */
  imageCount: number;
  createdAt: number;
  lastImage?: ImageInfo | null;
}

export interface SurfSessionStatus {
  active: boolean;
  surfRecordId?: string | null;
  host?: string | null;
}

interface SurfRecordsResult {
  records: SurfRecord[];
  total: number;
  offset: number;
  limit: number;
}

interface RangedImages {
  images: ImageInfo[];
  total: number;
  offset: number;
  limit: number;
}

function normalizeSurfRecord(raw: unknown): SurfRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!id) return null;
  return {
    id,
    host: String(r.host ?? ""),
    name: String(r.name ?? ""),
    rootUrl: String(r.rootUrl ?? r.root_url ?? ""),
    cookie: String(r.cookie ?? ""),
    icon: Array.isArray(r.icon) ? (r.icon as number[]) : null,
    lastVisitAt: Number(r.lastVisitAt ?? r.last_visit_at ?? 0) || 0,
    downloadCount: Number(r.downloadCount ?? r.download_count ?? 0) || 0,
    deletedCount: Number(r.deletedCount ?? r.deleted_count ?? 0) || 0,
    imageCount: Number(r.imageCount ?? r.image_count ?? 0) || 0,
    createdAt: Number(r.createdAt ?? r.created_at ?? 0) || 0,
    lastImage: (r.lastImage ?? r.last_image) as ImageInfo | null | undefined,
  };
}

export const useSurfStore = defineStore("surf", () => {
  const records = ref<SurfRecord[]>([]);
  const hasMore = ref(false);
  const total = ref(0);
  const sessionActive = ref(false);
  const activeRecordId = ref<string | null>(null);
  const activeHost = ref<string | null>(null);
  const loading = ref(false);
  const offset = ref(0);
  const pageSize = ref(10);

  let inited = false;
  let unlistenRecords: UnlistenFn | null = null;
  let unlistenSession: UnlistenFn | null = null;

  const getRecord = async (id: string) => {
    return invoke<SurfRecord | null>("surf_get_record", { id });
  };

  const applySurfRecordAdded = (recordRaw: unknown) => {
    const r = normalizeSurfRecord(recordRaw);
    if (!r) return;
    if (records.value.some((x) => x.id === r.id)) return;
    records.value.unshift(r);
    total.value += 1;
  };

  const applySurfRecordDeleted = (surfRecordId: string) => {
    const id = String(surfRecordId ?? "").trim();
    if (!id) return;
    const before = records.value.length;
    records.value = records.value.filter((rec) => rec.id !== id);
    if (records.value.length < before) {
      total.value = Math.max(0, total.value - 1);
    }
    offset.value = records.value.length;
    hasMore.value = records.value.length < total.value;
  };

  const applySurfRecordChanged = async (id: string, diff: Record<string, unknown>) => {
    const rec = records.value.find((x) => x.id === id);
    if (!rec) return;
    const d = diff;
    const n = (k: string) => {
      const v = d[k];
      return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    const ni = n("imageCount");
    if (ni !== undefined) rec.imageCount = ni;
    const nd = n("deletedCount");
    if (nd !== undefined) rec.deletedCount = nd;
    const nc = n("downloadCount");
    if (nc !== undefined) rec.downloadCount = nc;
    const nv = n("lastVisitAt");
    if (nv !== undefined) rec.lastVisitAt = nv;
    if (typeof d.name === "string") rec.name = d.name;
    if (typeof d.rootUrl === "string") rec.rootUrl = d.rootUrl;
    if (typeof d.cookie === "string") rec.cookie = d.cookie;
    if (d.iconChanged === true) {
      const fresh = await getRecord(id);
      if (fresh) {
        rec.icon = fresh.icon;
        rec.lastImage = fresh.lastImage;
      }
    }
  };

  const initListeners = async () => {
    if (inited) return;
    inited = true;

    unlistenRecords = await listen<Record<string, unknown>>("surf-records-change", async (event) => {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "SurfRecordAdded") {
        applySurfRecordAdded(p.record);
      } else if (type === "SurfRecordDeleted") {
        applySurfRecordDeleted(String(p.surfRecordId ?? ""));
      } else if (type === "SurfRecordChanged") {
        const id = String(p.surfRecordId ?? "").trim();
        const diff = p.diff;
        if (id && diff && typeof diff === "object" && !Array.isArray(diff)) {
          await applySurfRecordChanged(id, diff as Record<string, unknown>);
        }
      }
    });

    unlistenSession = await listen<{ active?: boolean; surfRecordId?: string | null; host?: string | null }>(
      "surf-session-changed",
      (event) => {
        const payload = event.payload ?? {};
        sessionActive.value = !!payload.active;
        activeRecordId.value = payload.surfRecordId ?? null;
        activeHost.value = payload.host ?? activeHost.value;
      },
    );
  };

  const loadRecords = async () => {
    await initListeners();
    loading.value = true;
    offset.value = 0;
    const result = await invoke<SurfRecordsResult>("surf_list_records", {
      offset: 0,
      limit: pageSize.value,
    });
    records.value = result.records;
    total.value = result.total;
    hasMore.value = records.value.length < result.total;
    offset.value = records.value.length;
    loading.value = false;
  };

  const loadMore = async () => {
    if (!hasMore.value || loading.value) return;
    loading.value = true;
    const result = await invoke<SurfRecordsResult>("surf_list_records", {
      offset: offset.value,
      limit: pageSize.value,
    });
    records.value.push(...result.records);
    total.value = result.total;
    hasMore.value = records.value.length < result.total;
    offset.value = records.value.length;
    loading.value = false;
  };

  const startSession = async (url: string) => {
    const record = await invoke<SurfRecord>("surf_start_session", { url });
    sessionActive.value = true;
    activeRecordId.value = record.id;
    activeHost.value = record.host;
    await loadRecords();
    return record;
  };

  const closeSession = async () => {
    await invoke("surf_close_session");
    sessionActive.value = false;
    activeRecordId.value = null;
    activeHost.value = null;
  };

  const checkSession = async () => {
    const status = await invoke<SurfSessionStatus>("surf_get_session_status");
    sessionActive.value = !!status.active;
    activeRecordId.value = status.surfRecordId ?? null;
    activeHost.value = status.host ?? null;
  };

  const getRecordImages = async (id: string, localOffset: number, limit: number) => {
    return invoke<RangedImages>("surf_get_record_images", { id, offset: localOffset, limit });
  };

  const deleteRecord = async (id: string) => {
    await invoke("surf_delete_record", { id });
  };

  const updateName = async (id: string, name: string) => {
    await invoke("surf_update_name", { id, name });
  };

  const updateRootUrl = async (id: string, rootUrl: string) => {
    await invoke("surf_update_root_url", { id, rootUrl });
  };

  return {
    records,
    hasMore,
    total,
    sessionActive,
    activeRecordId,
    activeHost,
    loading,
    loadRecords,
    loadMore,
    startSession,
    closeSession,
    checkSession,
    getRecord,
    getRecordImages,
    deleteRecord,
    updateName,
    updateRootUrl,
  };
});
