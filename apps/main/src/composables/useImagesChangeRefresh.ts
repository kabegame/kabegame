import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useTrailingThrottleFn } from "@/composables/useTrailingThrottle";

export type ImagesChangePayload = {
  reason?: string;
  imageIds?: string[];
  taskId?: string;
  albumId?: string;
};

type UnlistenFn = () => void;

/**
 * 统一的 images-change 监听 + “仅激活时刷新”封装。
 *
 * 设计目标：
 * - `images-change` 视为“数据可能变化”的失效信号（不保证命中当前 provider 视图）
 * - 页面在激活时收到信号 -> 刷新当前页数据（整体替换数组引用）
 * - 使用 250ms 节流（带 trailing）合并 burst，且不丢最后一个事件
 */
export function useImagesChangeRefresh(params: {
  enabled: Ref<boolean>;
  waitMs?: number;
  /**
   * 事件过滤：
   * - 返回 false 则忽略此次事件
   * - 默认不过滤（全部视为可能影响当前视图）
   */
  filter?: (payload: ImagesChangePayload) => boolean;
  onRefresh: (payload: ImagesChangePayload) => void | Promise<void>;
}) {
  const waitMs = params.waitMs ?? 250;

  let unlisten: UnlistenFn | null = null;
  const throttled = useTrailingThrottleFn(async (payload: ImagesChangePayload) => {
    await params.onRefresh(payload);
  }, waitMs);

  const stop = () => {
    throttled.cancel();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const start = async () => {
    if (unlisten) return;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<ImagesChangePayload>("images-change", async (event) => {
      const payload = (event?.payload ?? {}) as ImagesChangePayload;
      if (params.filter && !params.filter(payload)) return;
      await throttled.trigger(payload);
    });
  };

  const sync = async (enabled: boolean) => {
    if (enabled) {
      await start();
    } else {
      stop();
    }
  };

  onMounted(() => void sync(params.enabled.value));
  watch(
    () => params.enabled.value,
    (v) => void sync(v)
  );
  onBeforeUnmount(() => {
    stop();
  });
}

