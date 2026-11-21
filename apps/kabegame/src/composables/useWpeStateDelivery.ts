import { onScopeDispose, watch } from "vue";
import { invoke } from "@/api";
import { kbEvent$ } from "@/services/kbEvents/eventSource";
import { logger } from "@/utils/logger";
import {
  fullStateMessage,
  readyStateMessage,
  stateDelta,
  type WpeStateMessage,
  type WpeWebState,
} from "@/components/wallpaper/wpeWebState";

export interface WpeStateDeliveryOptions {
  /** 这张网页 / 场景壁纸的图片 id；没有目标时为 null */
  imageId: () => string | null;
  /** 当前 iframe 的窗口（还没建出来时 null） */
  target: () => Window | null;
}

export interface WpeStateDelivery {
  /**
   * 当前 iframe 实例里一份文档加载完了（调用方只在真实文档的 load 上调，初始空文档、被拦的不算）。第一次：就绪标志置真，
   * 状态到了就推整份；之后（页面自己 reload、改地址、前进后退）：照 WPE 不重推，只发一条不带属性的「就绪」。
   */
  frameLoaded(): void;
  /** iframe 实例重建（换目标、重开宿主）：就绪标志与基线清掉，下一次 `frameLoaded` 重新推整份。 */
  reset(): void;
}

type Patch = { id?: unknown; metadataId?: unknown };

/**
 * 父页面向一个壁纸 iframe 推属性（照 WPE 由宿主推送，`.claude/plans/wpe-import/2-web/phase-9-parent-delivery.md`；协议见
 * `wpeWebState.ts`）。`WpeWallpaperContent`（网页壁纸）与 `WpeSceneView`（场景宿主）各用一份。
 *
 * - 取状态：`wpe_web_get_state`，请求编号递增，某次结果落地后丢弃更早发出、更晚返回的；图片 id 变了就重取。
 * - 重取触发：`setting-change` 带 `language`（界面语言）或 `wpeFps`（桌面帧率）；本张图片的 `metadataId` 补丁
 *   （`image-changed` / `images-change`；图片 metadata 按 id 不可变，属性、预览设置一改就换 `metadataId`）。
 * - 就绪标志与基线跟 iframe 实例走：就绪之前只记最新状态；就绪后第一次推整份，之后按「上次推给这个 iframe 的状态」算增量。
 *   基线跨页面自己的 reload 保留，正好对应 WPE 主程序那边的属性状态。
 */
export function useWpeStateDelivery(options: WpeStateDeliveryOptions): WpeStateDelivery {
  let latest: WpeWebState | null = null;
  /** 上次推给当前 iframe 实例的状态（增量的基线） */
  let delivered: WpeWebState | null = null;
  let armed = false;
  let issued = 0;
  let applied = 0;
  let disposed = false;

  function post(message: WpeStateMessage) {
    const target = options.target();
    if (!target) return;
    try {
      // 对方是跨源的 `file:` 文档；内容与页面自己能读到的属性相同，不限定 targetOrigin
      target.postMessage(message, "*");
    } catch (error) {
      logger.warn(`壁纸属性发送失败: ${error}`);
    }
  }

  function flush() {
    if (!armed || !latest) return;
    if (!delivered) {
      post(fullStateMessage(latest));
      delivered = latest;
      return;
    }
    const delta = stateDelta(delivered, latest);
    if (!delta) return;
    post(delta);
    delivered = latest;
  }

  async function fetchState() {
    const imageId = options.imageId();
    if (!imageId) return;
    const seq = ++issued;
    try {
      const state = await invoke<WpeWebState | null>("wpe_web_get_state", { imageId });
      if (disposed || seq <= applied || imageId !== options.imageId()) return;
      applied = seq;
      if (!state) return;
      latest = state;
      flush();
    } catch (error) {
      if (!disposed) logger.warn(`取壁纸 ${imageId} 的属性失败: ${error}`);
    }
  }

  function affects(patch: Patch | null | undefined): boolean {
    const imageId = options.imageId();
    return !!patch && !!imageId && String(patch.id) === imageId && patch.metadataId !== undefined;
  }

  const subscriptions = [
    kbEvent$<{ changes?: Record<string, unknown> } & Record<string, unknown>>("setting-change").subscribe((event) => {
      const changes =
        event.payload.changes && typeof event.payload.changes === "object" ? event.payload.changes : event.payload;
      // 语言与桌面帧率进 general；预览的帧率在 metadata 的 previewSettings 里，随 metadataId 补丁重取
      if (
        Object.prototype.hasOwnProperty.call(changes, "language") ||
        Object.prototype.hasOwnProperty.call(changes, "wpeFps")
      )
        void fetchState();
    }),
    kbEvent$<{ patch?: Patch }>("image-changed").subscribe((event) => {
      if (affects(event.payload.patch)) void fetchState();
    }),
    kbEvent$<{ patches?: Patch[] }>("images-change").subscribe((event) => {
      if (event.payload.patches?.some(affects)) void fetchState();
    }),
  ];

  watch(
    options.imageId,
    () => {
      latest = null;
      void fetchState();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    disposed = true;
    for (const subscription of subscriptions) subscription.unsubscribe();
  });

  return {
    frameLoaded() {
      if (!armed) {
        armed = true;
        flush();
        return;
      }
      post(readyStateMessage((delivered ?? latest)?.directories ?? {}));
    },
    reset() {
      armed = false;
      delivered = null;
    },
  };
}
