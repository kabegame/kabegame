import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ImageInfo } from "@kabegame/core/types/image";

export interface SurfRecord {
  id: string;
  host: string;
  rootUrl: string;
  icon?: number[] | null;
  lastVisitAt: number;
  downloadCount: number;
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

  const initListeners = async () => {
    if (inited) return;
    inited = true;

    unlistenRecords = await listen<{ reason?: string; surfRecordId?: string }>(
      "surf-records-change",
      async () => {
        const loaded = records.value.length;
        if (loaded > 0) {
          const result = await invoke<SurfRecordsResult>("surf_list_records", {
            offset: 0,
            limit: loaded,
          });
          records.value = result.records;
          total.value = result.total;
          hasMore.value = loaded < result.total;
          offset.value = records.value.length;
        } else {
          await loadRecords();
        }
      },
    );

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

  const getRecord = async (id: string) => {
    return invoke<SurfRecord | null>("surf_get_record", { id });
  };

  const getRecordImages = async (id: string, localOffset: number, limit: number) => {
    return invoke<RangedImages>("surf_get_record_images", { id, offset: localOffset, limit });
  };

  const deleteRecord = async (id: string) => {
    await invoke("surf_delete_record", { id });
    const loaded = records.value.length;
    if (loaded > 0) {
      const result = await invoke<SurfRecordsResult>("surf_list_records", { offset: 0, limit: loaded });
      records.value = result.records;
      total.value = result.total;
      hasMore.value = loaded < result.total;
      offset.value = records.value.length;
    } else {
      await loadRecords();
    }
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
  };
});
