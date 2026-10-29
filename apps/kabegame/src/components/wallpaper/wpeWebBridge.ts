import { invoke } from "@/api/rpc";
import { useTauriProxy } from "@/composables/useTauriProxy";

/** 后端 `WpeWebState`：网页壁纸页面拉取的完整状态。 */
export interface WpeWebState {
  imageId: string;
  user: Record<string, { type?: string; value: unknown }>;
  general: { language: string };
}

/** 主窗口 `file:` 根目录命令的串行链（整个窗口只有一个根目录）。 */
let previewRootChain: Promise<unknown> = Promise.resolve();

/**
 * `imageId` 有值：把主窗口的 `file:` 根目录设成这张壁纸的目录，返回它的入口 `file://`，由调用方赋给预览 iframe 的
 * `src`（应用页能加载 `file:` iframe 靠 CEF 补丁 0005）；`null`：只清空根目录，返回 `null`。预览 iframe 的每个
 * `file:` 请求都按根目录拦截。
 * 按调用顺序串行执行——设置要读库与 `project.json`，比清空慢，并发时会「后发先至」，把根目录留在已撤下的壁纸上。
 */
export function setWpeWebPreview(imageId: string | null): Promise<string | null> {
  const run = previewRootChain.then(() => invoke<string | null>("set_wpe_web_preview", { imageId }));
  previewRootChain = run.catch(() => {});
  return run;
}

/**
 * 预览 iframe 的宿主端：替网页壁纸垫片（`webview_js/wpe_shim.js`）拉取状态、代为 listen。
 * - `pull { id }` → 用主窗口权限调 `get_wpe_web_state`，回 `state { id, state | error }`；
 * - `listen { events }` → `tauriProxy.listen`，事件逐条回 `event { name, payload }`。
 * 只认本 iframe（`event.source`）；回消息的目标源用 `"*"`：`file:` 源在 `postMessage` 的目标匹配上不可靠，
 * 而发出的只有本张壁纸的状态与转发的事件。外部页面不接触 IPC。
 */
export function attachWpeWebBridge(frame: HTMLIFrameElement, imageId: string) {
  let disposed = false;
  const post = (message: Record<string, unknown>) => {
    if (!disposed) frame.contentWindow?.postMessage({ kbWpe: 1, ...message }, "*");
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
