import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { invoke } from "@/api/rpc";
import { usePluginStore, type Plugin } from "@/stores/plugins";

export interface UsePluginDetailLoaderOptions {
  pluginId: Ref<string | null>;
  mode: Ref<"local" | "remote">;
  sourceId: Ref<string | null>;
  /** 商店内存缓存的版本校验 */
  expectedVersion: Ref<string | null>;
  /** 仅在 true 时才会拉取/响应变化（弹窗未打开、路由未激活时不拉取） */
  active: Ref<boolean>;
  /** 加载失败（本地未找到 / 远程拉取失败）时的回调，如关闭弹窗、返回上一页 */
  onLoadFailure?: () => void;
}

/** 已安装详情直读 store，商店详情按来源和版本缓存于内存。 */
export function usePluginDetailLoader(options: UsePluginDetailLoaderOptions) {
  const { pluginId, mode, sourceId, expectedVersion, active, onLoadFailure } = options;
  const pluginStore = usePluginStore();

  const plugin = ref<Plugin | null>(null) as Ref<Plugin | null>;
  const loading = ref(false);
  const showSkeleton = ref(false);
  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;

  const isInstalled = computed(() => {
    if (!plugin.value) return false;
    return pluginStore.plugins.some((p) => p.id === plugin.value!.id);
  });

  const clearSkeletonTimer = () => {
    if (skeletonTimer) {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
    }
  };

  let generation = 0;
  onScopeDispose(() => {
    generation++;
    clearSkeletonTimer();
  });

  const load = async () => {
    const current = ++generation;
    const id = pluginId.value;
    if (!id) return;

    if (mode.value !== "remote") {
      const found = pluginStore.plugins.find((p) => p.id === id);
      plugin.value = found ?? null;
      loading.value = false;
      showSkeleton.value = false;
      if (!found) onLoadFailure?.();
      return;
    }

    const cacheKey = `${id}::${sourceId.value}`;
    const cached = pluginStore.getCachedPluginDetail(cacheKey);
    if (cached && (!expectedVersion.value || cached.version === expectedVersion.value)) {
      plugin.value = cached;
      loading.value = false;
      showSkeleton.value = false;
      return;
    }

    plugin.value = null;
    loading.value = true;
    showSkeleton.value = false;
    clearSkeletonTimer();
    skeletonTimer = setTimeout(() => {
      if (loading.value) showSkeleton.value = true;
    }, 300);
    try {
      const result = await invoke<Plugin>("get_plugin_detail", {
        pluginId: id,
        sourceId: sourceId.value ?? undefined,
      });
      if (current !== generation) return;
      plugin.value = result;
      pluginStore.setCachedPluginDetail(cacheKey, result);
    } catch {
      if (current === generation) onLoadFailure?.();
    } finally {
      if (current !== generation) return;
      loading.value = false;
      showSkeleton.value = false;
      clearSkeletonTimer();
    }
  };

  watch(
    [
      pluginId,
      mode,
      sourceId,
      active,
      expectedVersion,
      () => (mode.value === "local" ? pluginStore.plugins.find((p) => p.id === pluginId.value) : null),
    ],
    ([, , , isActive]) => {
      if (!isActive || !pluginId.value) {
        generation++;
        clearSkeletonTimer();
        return;
      }
      void load();
    },
    { immediate: true },
  );

  return { plugin, loading, showSkeleton, isInstalled, reload: load };
}
