import { onScopeDispose, ref, shallowRef } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import {
  fetchRunConfig,
  fetchRunConfigPage,
  fetchRunConfigTotal,
  RUN_CONFIG_PAGE_SIZE,
  subscribeRunConfigEvents,
  type RunConfigEvent,
} from "@/services/runConfigs";
import type { RunConfig } from "@/stores/crawler";

function newer(a: RunConfig, b: RunConfig): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

export function usePagedRunConfigs(options: {
  basePath: () => string;
  matches: (config: RunConfig) => boolean;
}) {
  const items = shallowRef<RunConfig[]>([]);
  const total = ref(0);
  // 真实加载态 loading 只做并发守卫与空态判断；showLoading 超过延迟才为真，供 v-loading 转圈，避免快速返回时闪烁
  const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();
  const hasMore = ref(false);
  let generation = 0;
  let unsubscribe: (() => void) | null = null;

  async function applyEvent(event: RunConfigEvent, activeGeneration: number) {
    if (activeGeneration !== generation) return;
    if (event.reason === "configdelete") {
      remove(event.configId);
      return;
    }
    const config = await fetchRunConfig(event.configId);
    if (activeGeneration !== generation || !config) return;
    upsert(config);
  }

  function remove(id: string) {
    const exists = items.value.some((config) => config.id === id);
    if (!exists) return false;
    items.value = items.value.filter((config) => config.id !== id);
    total.value = Math.max(0, total.value - 1);
    hasMore.value = items.value.length < total.value;
    return true;
  }

  function upsert(config: RunConfig) {
    const index = items.value.findIndex((item) => item.id === config.id);
    if (!options.matches(config)) {
      if (index !== -1) remove(config.id);
      return;
    }
    if (index !== -1) {
      const next = items.value.slice();
      next[index] = config;
      next.sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
      items.value = next;
      return;
    }
    // 已加载完时，比末行更旧的行也属于当前结果集；否则留给后续游标翻页取回
    const last = items.value.at(-1);
    if (!last || !hasMore.value || newer(config, last)) {
      items.value = [config, ...items.value].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
      total.value++;
      hasMore.value = items.value.length < total.value;
    }
  }

  async function start() {
    unsubscribe?.();
    const activeGeneration = ++generation;
    const buffered: RunConfigEvent[] = [];
    let ready = false;
    startLoading();
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    unsubscribe = subscribeRunConfigEvents((event) => {
      if (!ready) buffered.push(event);
      else void applyEvent(event, activeGeneration);
    });
    const base = options.basePath();
    try {
      const [page, count] = await Promise.all([fetchRunConfigPage(base), fetchRunConfigTotal(base)]);
      if (activeGeneration !== generation) return;
      items.value = page;
      total.value = count;
      // 先按首页判定是否还有下一页，缓冲事件里比末行旧的配置才不会被误插
      hasMore.value = page.length === RUN_CONFIG_PAGE_SIZE;
      ready = true;
      for (const event of buffered) await applyEvent(event, activeGeneration);
      hasMore.value = page.length === RUN_CONFIG_PAGE_SIZE && items.value.length < total.value;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  async function loadMore() {
    if (loading.value || !hasMore.value || items.value.length === 0) return;
    const activeGeneration = generation;
    startLoading();
    try {
      const page = await fetchRunConfigPage(options.basePath(), items.value.at(-1));
      if (activeGeneration !== generation) return;
      const known = new Set(items.value.map((config) => config.id));
      items.value = [...items.value, ...page.filter((config) => !known.has(config.id))];
      hasMore.value = page.length === RUN_CONFIG_PAGE_SIZE && items.value.length < total.value;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  function stop() {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    items.value = [];
    total.value = 0;
    finishLoading();
    hasMore.value = false;
  }

  onScopeDispose(stop);
  return { items, total, loading, showLoading, hasMore, start, loadMore, stop, upsert, remove };
}
