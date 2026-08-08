import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { listen } from "@/api/rpc";
import { useTrailingThrottleFn } from "@/composables/useTrailingThrottle";

/**
 * 树级刷新事件枢纽：集中订阅 N 个后端事件（监听哪些事件由消费者决定——
 * 这是「刷新事件参数化」的落点），节点/分支把刷新回调注册进来，
 * 按「每注册项独立 trailing-throttle + 项级 filter + when 门控」分发。
 *
 * 节流粒度与旧实现的 per-node useImagesChangeRefresh 完全等价，
 * 但监听器数量从 O(挂载节点数) 降到 O(事件数/树)。
 * 基座不认识任何具体事件名或业务 ID。
 */
export interface TreeRefreshSource {
  event: string;
  /** source 级过滤（如 album-images-change 只认隐藏画册的增删）。 */
  filter?: (payload: unknown) => boolean;
}

export interface TreeRefreshEntry {
  /** 默认 3000ms（旧实现的 debounce 默认值）。 */
  waitMs?: number;
  /** 项级门控：false 时丢弃本次事件（等价旧实现 enabled 翻 false 时退订）。 */
  when?: () => boolean;
  /** 项级过滤；event 参数让同一注册项区分不同事件。 */
  filter?: (event: string, payload: unknown) => boolean;
  onRefresh: () => void | Promise<void>;
}

export interface TreeRefreshHub {
  register(entry: TreeRefreshEntry): () => void;
}

type UnlistenFn = () => void;

export function useTreeRefreshHub(options: {
  /** 枢纽总开关：false 时事件被丢弃（不退订，行为等价）。 */
  enabled?: Ref<boolean>;
  sources: TreeRefreshSource[];
}): TreeRefreshHub {
  interface InternalEntry extends TreeRefreshEntry {
    throttled: ReturnType<typeof useTrailingThrottleFn>;
  }

  const entries = new Set<InternalEntry>();
  let unlistens: UnlistenFn[] = [];
  let started = false;

  function dispatch(source: TreeRefreshSource, payload: unknown) {
    if (options.enabled && !options.enabled.value) return;
    if (source.filter && !source.filter(payload)) return;
    for (const entry of entries) {
      if (entry.when && !entry.when()) continue;
      if (entry.filter && !entry.filter(source.event, payload)) continue;
      void entry.throttled.trigger();
    }
  }

  async function start() {
    if (started) return;
    started = true;
    for (const source of options.sources) {
      const unlisten = await listen<unknown>(source.event, (event) => {
        dispatch(source, (event as { payload?: unknown } | undefined)?.payload ?? {});
      });
      unlistens.push(unlisten);
    }
  }

  function stop() {
    started = false;
    for (const unlisten of unlistens.splice(0)) unlisten();
    for (const entry of entries) entry.throttled.cancel();
  }

  onMounted(() => void start());
  if (options.enabled) {
    // enabled 只做丢弃门控即可，但翻 false 时取消挂起的 trailing，
    // 与旧实现 stop() 的 cancel 语义对齐。
    watch(options.enabled, (v) => {
      if (!v) for (const entry of entries) entry.throttled.cancel();
    });
  }
  onBeforeUnmount(() => stop());

  return {
    register(entry: TreeRefreshEntry) {
      const internal: InternalEntry = {
        ...entry,
        throttled: useTrailingThrottleFn(async () => {
          await entry.onRefresh();
        }, entry.waitMs ?? 3000),
      };
      entries.add(internal);
      return () => {
        internal.throttled.cancel();
        entries.delete(internal);
      };
    },
  };
}
