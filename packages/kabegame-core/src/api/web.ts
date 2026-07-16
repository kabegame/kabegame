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
