import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { invoke, listen, type UnlistenFn } from "../api";
import type { ImageInfo } from "../types/image";
import { IS_ANDROID } from "../env";

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
  surfHost?: string | null;
}

interface RangedImages {
  images: ImageInfo[];
  total: number;
  offset: number;
  limit: number;
}

function normalizeHost(host: string) {
  return host.trim().toLowerCase();
}

function normalizeSurfRecord(raw: unknown): SurfRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    host: normalizeHost(String(r.host ?? "")),
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
  const recordsById = ref<Record<string, SurfRecord>>({});
  const idByHost = ref<Record<string, string>>({});
  const orderedIds = ref<string[]>([]);
  const sessionActive = ref(false);
  /** 当前畅游会话对应站点 host（与路由、Tauri 命令对外键一致） */
  const activeHost = ref<string | null>(null);
  const loading = ref(false);

  let inited = false;
  let initPromise: Promise<void> | null = null;
  let unlistenRecords: UnlistenFn | null = null;
  let unlistenSession: UnlistenFn | null = null;

  const records = computed(() =>
    orderedIds.value
      .map((id) => recordsById.value[id])
      .filter((record): record is SurfRecord => !!record),
  );
  const total = computed(() => orderedIds.value.length);

  function sortOrderedIds() {
    orderedIds.value = Object.values(recordsById.value)
      .sort((a, b) => b.lastVisitAt - a.lastVisitAt || a.host.localeCompare(b.host))
      .map((record) => record.id);
  }

  function upsertRecord(record: SurfRecord) {
    const old = recordsById.value[record.id];
    if (old?.host && old.host !== record.host) {
      const oldHost = normalizeHost(old.host);
      delete idByHost.value[oldHost];
    }
    recordsById.value[record.id] = record;
    if (record.host) {
      idByHost.value[normalizeHost(record.host)] = record.id;
    }
    sortOrderedIds();
  }

  function upsertRecordRaw(recordRaw: unknown) {
    const record = normalizeSurfRecord(recordRaw);
    if (record) upsertRecord(record);
    return record;
  }

  function removeRecord(id: string) {
    const record = recordsById.value[id];
    if (record?.host) delete idByHost.value[normalizeHost(record.host)];
    delete recordsById.value[id];
    orderedIds.value = orderedIds.value.filter((item) => item !== id);
  }

  function recordById(id: string): SurfRecord | undefined {
    return recordsById.value[String(id ?? "").trim()];
  }

  function recordByHost(host: string): SurfRecord | undefined {
    const id = idByHost.value[normalizeHost(host)];
    return id ? recordsById.value[id] : undefined;
  }

  function hostById(id: string): string | undefined {
    return recordById(id)?.host;
  }

  async function fetchRecordByHost(host: string): Promise<SurfRecord | null> {
    if (IS_ANDROID) return null;
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) return null;
    const record = await invoke<SurfRecord | null>("surf_get_record", { host: normalizedHost });
    return upsertRecordRaw(record);
  }

  async function ensureRecordsByIds(ids: string[]): Promise<SurfRecord[]> {
    if (IS_ANDROID) return [];
    const missingIds = Array.from(
      new Set(
        ids
          .map((id) => String(id ?? "").trim())
          .filter((id) => id && !recordsById.value[id]),
      ),
    );
    if (missingIds.length === 0) {
      return ids
        .map((id) => recordById(id))
        .filter((record): record is SurfRecord => !!record);
    }
    const fetched = await invoke<SurfRecord[]>("surf_get_records_by_ids", { ids: missingIds });
    for (const raw of fetched) upsertRecordRaw(raw);
    return ids
      .map((id) => recordById(id))
      .filter((record): record is SurfRecord => !!record);
  }

  async function ensureRecordByHost(host: string): Promise<SurfRecord | null> {
    const cached = recordByHost(host);
    if (cached) return cached;
    return fetchRecordByHost(host);
  }

  async function applySurfRecordChanged(id: string, diff: Record<string, unknown>) {
    let rec = recordsById.value[id];
    if (!rec) {
      await ensureRecordsByIds([id]);
      rec = recordsById.value[id];
      if (!rec) return;
    }
    const n = (k: string) => {
      const v = diff[k];
      return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    const patch: Partial<SurfRecord> = {};
    const ni = n("imageCount");
    if (ni !== undefined) patch.imageCount = ni;
    const nd = n("deletedCount");
    if (nd !== undefined) patch.deletedCount = nd;
    const nc = n("downloadCount");
    if (nc !== undefined) patch.downloadCount = nc;
    const nv = n("lastVisitAt");
    if (nv !== undefined) patch.lastVisitAt = nv;
    if (typeof diff.name === "string") patch.name = diff.name;
    if (typeof diff.rootUrl === "string") patch.rootUrl = diff.rootUrl;
    if (typeof diff.cookie === "string") patch.cookie = diff.cookie;
    if (diff.iconChanged === true) {
      const fresh = await fetchRecordByHost(rec.host);
      if (fresh) return;
    }
    upsertRecord({ ...rec, ...patch });
  }

  async function initListeners() {
    if (IS_ANDROID) return;
    if (unlistenRecords || unlistenSession) return;
    unlistenRecords = await listen<Record<string, unknown>>("surf-records-change", async (event) => {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "SurfRecordAdded") {
        upsertRecordRaw(p.record);
      } else if (type === "SurfRecordDeleted") {
        removeRecord(String(p.surfRecordId ?? "").trim());
      } else if (type === "SurfRecordChanged") {
        const id = String(p.surfRecordId ?? "").trim();
        const diff = p.diff;
        if (id && diff && typeof diff === "object" && !Array.isArray(diff)) {
          await applySurfRecordChanged(id, diff as Record<string, unknown>);
        }
      }
    });

    unlistenSession = await listen<{ active?: boolean; surfHost?: string | null }>(
      "surf-session-changed",
      (event) => {
        const payload = event.payload ?? {};
        sessionActive.value = !!payload.active;
        activeHost.value = payload.surfHost ? normalizeHost(payload.surfHost) : null;
      },
    );
  }

  async function checkSession() {
    if (IS_ANDROID) {
      sessionActive.value = false;
      activeHost.value = null;
      return;
    }
    const status = await invoke<SurfSessionStatus>("surf_get_session_status");
    sessionActive.value = !!status.active;
    activeHost.value = status.surfHost ? normalizeHost(status.surfHost) : null;
  }

  async function init(): Promise<void> {
    if (inited) return initPromise ?? Promise.resolve();
    if (initPromise) return initPromise;
    loading.value = true;
    initPromise = (async () => {
      if (IS_ANDROID) {
        inited = true;
        return;
      }
      await initListeners();
      const [allRecords] = await Promise.all([
        invoke<SurfRecord[]>("surf_get_all_records"),
        checkSession(),
      ]);
      recordsById.value = {};
      idByHost.value = {};
      for (const raw of allRecords) upsertRecordRaw(raw);
      sortOrderedIds();
      inited = true;
    })().finally(() => {
      loading.value = false;
      initPromise = null;
    });
    return initPromise;
  }

  async function startSession(url: string) {
    if (IS_ANDROID) throw new Error("Surf is not supported on Android");
    await init();
    const record = await invoke<SurfRecord>("surf_start_session", { url });
    sessionActive.value = true;
    activeHost.value = normalizeHost(record.host);
    upsertRecordRaw(record);
    return record;
  }

  async function closeSession() {
    if (IS_ANDROID) return;
    await invoke("surf_close_session");
    sessionActive.value = false;
    activeHost.value = null;
  }

  async function getRecord(host: string) {
    await init();
    return ensureRecordByHost(host);
  }

  async function getRecordImages(host: string, localOffset: number, limit: number) {
    if (IS_ANDROID) {
      return { images: [], total: 0, offset: localOffset, limit };
    }
    return invoke<RangedImages>("surf_get_record_images", { host, offset: localOffset, limit });
  }

  async function deleteRecord(host: string) {
    if (IS_ANDROID) return;
    await init();
    await invoke("surf_delete_record", { host: normalizeHost(host) });
  }

  async function updateName(host: string, name: string) {
    if (IS_ANDROID) return;
    await init();
    await invoke("surf_update_name", { host: normalizeHost(host), name });
    const cached = recordByHost(host);
    if (cached) upsertRecord({ ...cached, name });
  }

  async function updateRootUrl(host: string, rootUrl: string) {
    if (IS_ANDROID) return;
    await init();
    await invoke("surf_update_root_url", { host: normalizeHost(host), rootUrl });
    const cached = recordByHost(host);
    if (cached) upsertRecord({ ...cached, rootUrl });
  }

  return {
    records,
    recordsById,
    idByHost,
    orderedIds,
    total,
    sessionActive,
    activeHost,
    loading,
    init,
    checkSession,
    recordById,
    recordByHost,
    hostById,
    ensureRecordsByIds,
    ensureRecordByHost,
    getRecord,
    getRecordImages,
    startSession,
    closeSession,
    deleteRecord,
    updateName,
    updateRootUrl,
  };
});
