import { invoke } from "@/api/rpc";
import { useTauriProxy } from "@/composables/useTauriProxy";

/** 后端 `WpeWebState`：网页壁纸页面拉取的完整状态。 */
export interface WpeWebState {
  imageId: string;
  user: Record<string, { type?: string; value: unknown }>;
  general: { language: string };
}

/**
 * 预览 iframe 的宿主端：替网页壁纸垫片（`webview_js/wpe_shim.js`）拉取状态、代为 listen。
 * - `pull { id }` → 用主窗口权限调 `get_wpe_web_state`，回 `state { id, state | error }`；
 * - `listen { events }` → `tauriProxy.listen`，事件逐条回 `event { name, payload }`。
 * 只认本 iframe（`event.source`），只发往它加载时的源；外部页面不接触 IPC。
 */
export function attachWpeWebBridge(frame: HTMLIFrameElement, frameUrl: string, imageId: string) {
  const origin = new URL(frameUrl, location.href).origin;
  let disposed = false;
  const post = (message: Record<string, unknown>) => {
    if (!disposed) frame.contentWindow?.postMessage({ kbWpe: 1, ...message }, origin);
  };
  // 桥在 `enterWeb` 的 await 之后创建，那时已没有活动的 effect scope，由 dispose() 显式退订
  const tauriProxy = useTauriProxy((event) => post({ type: "event", name: event.name, payload: event.payload }));

  async function pull(id: number) {
    try {
      const state = await invoke<WpeWebState | null>("get_wpe_web_state", { imageId });
      post(state ? { type: "state", id, state } : { type: "state", id, error: "not a web wallpaper" });
    } catch (error) {
      post({ type: "state", id, error: String(error) });
    }
  }

  function onMessage(event: MessageEvent) {
    const data = event.data;
    if (event.source !== frame.contentWindow || data?.kbWpe !== 1) return;
    if (data.type === "pull" && typeof data.id === "number") void pull(data.id);
    else if (data.type === "listen" && Array.isArray(data.events)) {
      // 不限能登记的事件名，与桌面 `core:event:allow-listen` 一致（已接受的取舍）
      tauriProxy.listen(data.events.filter((name: unknown): name is string => typeof name === "string" && name !== ""));
    }
  }
  window.addEventListener("message", onMessage);

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      tauriProxy.dispose();
    },
  };
}
