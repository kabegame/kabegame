/**
 * 提示消息（取代 ElMessage）。用法与 ElMessage 相同：
 *   toast.success("已保存")；toast.error(String(e))；toast({ type: "info", message, duration })；toast.closeAll()
 * 渲染在 Toaster.vue（App.vue 挂一份）；还没挂上时先排队，挂上后一起出现。
 *
 * 与 ElMessage 的差别：
 * - 同类型同文字的提示已经在显示时不再叠一条，旧的那条换成新的（计时重来）；
 * - 同时最多 4 条，多出来的先关最早的；
 * - duration 0 表示不自动关（与 ElMessage 相同），默认 3000ms。
 */
import { ref, shallowReactive } from "vue";
import { nextLayerZIndex } from "./compat";

export type ToastType = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  type?: ToastType;
  message?: unknown;
  duration?: number;
}

export interface ToastEntry {
  id: number;
  type: ToastType;
  text: string;
  /** 毫秒；Infinity 表示不自动关 */
  duration: number;
  open: boolean;
}

export interface ToastHandle {
  close: () => void;
}

const DEFAULT_DURATION = 3000;
const MAX_VISIBLE = 4;
/** 关闭动画播完再从列表里拿掉 */
const REMOVE_DELAY = 300;

export const toastEntries = shallowReactive<ToastEntry[]>([]);
/** 视口层级：每推一条取一次号，压在此刻所有弹层之上 */
export const toastZIndex = ref(3000);

let seq = 0;

function normalizeText(message: unknown): string {
  if (message && typeof message === "object" && "message" in message) {
    return normalizeText((message as { message?: unknown }).message);
  }
  if (message == null) return "";
  return typeof message === "string" ? message : String(message);
}

function replaceEntry(id: number, patch: Partial<ToastEntry>) {
  const index = toastEntries.findIndex((e) => e.id === id);
  if (index !== -1) toastEntries.splice(index, 1, { ...toastEntries[index], ...patch });
}

export function closeToast(id: number) {
  replaceEntry(id, { open: false });
  setTimeout(() => {
    const index = toastEntries.findIndex((e) => e.id === id);
    if (index !== -1 && !toastEntries[index].open) toastEntries.splice(index, 1);
  }, REMOVE_DELAY);
}

function push(type: ToastType, message: unknown, duration?: number): ToastHandle {
  const text = normalizeText(message);
  for (const e of toastEntries) {
    if (e.open && e.type === type && e.text === text) closeToast(e.id);
  }
  const open = toastEntries.filter((e) => e.open);
  for (const e of open.slice(0, Math.max(0, open.length - (MAX_VISIBLE - 1)))) closeToast(e.id);

  const id = ++seq;
  toastEntries.push({
    id,
    type,
    text,
    duration: duration === 0 ? Number.POSITIVE_INFINITY : (duration ?? DEFAULT_DURATION),
    open: true,
  });
  toastZIndex.value = nextLayerZIndex();
  return { close: () => closeToast(id) };
}

type ToastApi = {
  (opts: string | ToastOptions): ToastHandle;
  success: (message: unknown, duration?: number) => ToastHandle;
  info: (message: unknown, duration?: number) => ToastHandle;
  warning: (message: unknown, duration?: number) => ToastHandle;
  error: (message: unknown, duration?: number) => ToastHandle;
  closeAll: () => void;
};

export const toast = ((opts: string | ToastOptions) =>
  typeof opts === "string" ? push("info", opts) : push(opts.type ?? "info", opts.message, opts.duration)) as ToastApi;

toast.success = (message, duration) => push("success", message, duration);
toast.info = (message, duration) => push("info", message, duration);
toast.warning = (message, duration) => push("warning", message, duration);
toast.error = (message, duration) => push("error", message, duration);
toast.closeAll = () => {
  for (const e of toastEntries) if (e.open) closeToast(e.id);
};
