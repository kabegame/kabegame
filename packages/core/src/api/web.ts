import { watch } from "vue";
import { getIsSuper } from "../state/superState";

export type UnlistenFn = () => void;

export interface TauriLikeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: TauriLikeEvent<T>) => void;

const API_ROOT = (import.meta.env.VITE_API_ROOT as string | undefined) ?? "/";

function qsSuper(): string {
  return getIsSuper() ? "?super=1" : "";
}

function rpcUrl(): string {
  return `${API_ROOT}rpc${qsSuper()}`;
}

function sseUrl(): string {
  return `${API_ROOT}events${qsSuper()}`;
}

const UPLOAD_URL = `${API_ROOT}api/import`;

let rpcIdCounter = 0;

export async function invoke<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const id = ++rpcIdCounter;
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? null }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message ?? "RPC error");
    (err as { code?: number }).code = data.error.code;
    throw err;
  }
  return data.result as T;
}

let eventSource: EventSource | null = null;
const eventListeners = new Map<string, Set<EventCallback<unknown>>>();
let sseWatcherInitialized = false;
let sseFallbackId = 0;

function attachSseListener(es: EventSource, eventName: string) {
  es.addEventListener(eventName, (raw) => {
    const ev = raw as MessageEvent;
    const set = eventListeners.get(eventName);
    if (!set) return;
    let payload: unknown = null;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      payload = ev.data;
    }
    const id = Number(ev.lastEventId) || ++sseFallbackId;
    const tauriLike: TauriLikeEvent<unknown> = { event: eventName, id, payload };
    for (const cb of set) {
      try {
        cb(tauriLike);
      } catch (e) {
        console.error("[web-api] listen callback error", e);
      }
    }
  });
}

function openEventSource() {
  const es = new EventSource(sseUrl());
  eventSource = es;
  for (const name of eventListeners.keys()) {
    attachSseListener(es, name);
  }
}

function ensureEventSource() {
  if (eventSource) return;
  openEventSource();
  if (!sseWatcherInitialized) {
    sseWatcherInitialized = true;
    watch(() => getIsSuper(), () => reconnectSse());
  }
}

function reconnectSse() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
  openEventSource();
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  // Web mode has no bidirectional frontend→backend event bus; no-op.
}

export async function listen<T>(
  event: string,
  cb: EventCallback<T>,
): Promise<UnlistenFn> {
  let set = eventListeners.get(event);
  if (!set) {
    set = new Set();
    eventListeners.set(event, set);
    if (eventSource) attachSseListener(eventSource, event);
  }
  set.add(cb as EventCallback<unknown>);
  ensureEventSource();
  return () => {
    const s = eventListeners.get(event);
    if (!s) return;
    s.delete(cb as EventCallback<unknown>);
    if (s.size === 0) eventListeners.delete(event);
  };
}

export interface ImportUploadParams {
  outputAlbumId?: string;
  recursive: boolean;
  includeArchive: boolean;
}

export interface ImportUploadResult {
  task_id: string;
}

export async function uploadImport(
  files: File[],
  params: ImportUploadParams,
): Promise<ImportUploadResult> {
  const form = new FormData();
  for (const f of files) {
    const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    form.append("files", f, relPath);
  }
  const qs = new URLSearchParams();
  if (params.outputAlbumId) qs.set("output_album_id", params.outputAlbumId);
  qs.set("recursive", params.recursive ? "1" : "0");
  qs.set("include_archive", params.includeArchive ? "1" : "0");
  if (getIsSuper()) qs.set("super", "1");
  const res = await fetch(`${UPLOAD_URL}?${qs.toString()}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upload HTTP ${res.status}`);
  }
  return res.json();
}
