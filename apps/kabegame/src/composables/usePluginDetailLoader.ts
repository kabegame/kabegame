import { computed, ref, watch, type Ref } from "vue";
import { invoke } from "@/api/rpc";
import { IS_WEB } from "@kabegame/core/env";
import { storePluginCacheDb } from "@kabegame/core/cache/storePluginCache";
import { usePluginStore, type Plugin } from "@/stores/plugins";

export interface UsePluginDetailLoaderOptions {
  pluginId: Ref<string | null>;
  mode: Ref<"local" | "remote">;
  sourceId: Ref<string | null>;
  /** 仅用于 web 模式下 Dexie 持久缓存的版本校验，不参与"何时重新加载"的判断 */
  expectedVersion: Ref<string | null>;
  /** 仅在 true 时才会拉取/响应变化（弹窗未打开、路由未激活时不拉取） */
  active: Ref<boolean>;
  /** 加载失败（本地未找到 / 远程拉取失败）时的回调，如关闭弹窗、返回上一页 */
  onLoadFailure?: () => void;
}

/**
 * 插件详情的加载/缓存逻辑：已安装走内存直读，远程先查内存缓存、再查 Dexie（web 版本校验命中才用）、
 * 最后落到 get_plugin_detail。供 PluginDetailDialog.vue 使用。
 */
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

  const load = async () => {
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
    if (cached) {
      plugin.value = cached;
      loading.value = false;
      showSkeleton.value = false;
      return;
    }

    if (IS_WEB && sourceId.value) {
      const dexieKey = `${sourceId.value}:${id}`;
      const dexieCached = await storePluginCacheDb.details.get(dexieKey);
      if (dexieCached && (!expectedVersion.value || dexieCached.version === expectedVersion.value)) {
        plugin.value = dexieCached.data;
        pluginStore.setCachedPluginDetail(cacheKey, dexieCached.data);
        loading.value = false;
        showSkeleton.value = false;
        return;
      }
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
      plugin.value = result;
      pluginStore.setCachedPluginDetail(cacheKey, result);
      if (IS_WEB && sourceId.value) {
        const dexieKey = `${sourceId.value}:${id}`;
        void storePluginCacheDb.details.put({
          key: dexieKey,
          version: result.version,
          data: result,
          cachedAt: Date.now(),
        });
      }
    } catch {
      onLoadFailure?.();
    } finally {
      loading.value = false;
      showSkeleton.value = false;
      clearSkeletonTimer();
    }
  };

  watch(
    [pluginId, mode, sourceId, active],
    ([, , , isActive]) => {
      if (!isActive || !pluginId.value) return;
      void load();
    },
    { immediate: true }
  );

  return { plugin, loading, showSkeleton, isInstalled, reload: load };
}
