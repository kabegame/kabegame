import { computed, unref, type MaybeRefOrGetter } from "vue";
import type { Plugin } from "../stores/plugins";
import { usePluginStore } from "../stores/plugins";
import { isUpdateAvailable } from "../utils/version";

/**
 * 插件详情的按钮态：
 * - `installed`  看的就是已安装的插件本体 → 删除
 * - `install`    远程条目 / 待装包，store 里没有同 id → 安装
 * - `update`     远程版本比已安装的新 → 更新
 * - `reinstall`  已安装且远程版本不更新 → 再次安装
 *
 * 「是不是远程」是数据里没有的信息（同一个 Plugin 既可能是已装本体，也可能是商店条目或
 * .kgpg 预览），只有调用方知道，所以必须由外部传入；其余一律按 store 版本比较推导。
 */
export type PluginActionState = "installed" | "install" | "update" | "reinstall";

function toValue<T>(source: MaybeRefOrGetter<T>): T {
  return typeof source === "function" ? (source as () => T)() : unref(source as any);
}

export function usePluginActionState(
  plugin: MaybeRefOrGetter<Plugin | null | undefined>,
  isRemote: MaybeRefOrGetter<boolean>
) {
  const pluginStore = usePluginStore();

  /** store 里同 id 的已安装插件（plugin-added/updated/deleted 事件驱动保鲜） */
  const installedMatch = computed(() => {
    const id = toValue(plugin)?.id;
    return id ? pluginStore.plugins.find((p) => p.id === id) ?? null : null;
  });

  const actionState = computed<PluginActionState>(() => {
    if (!toValue(isRemote)) return "installed";
    const installed = installedMatch.value;
    const current = toValue(plugin);
    if (!installed || !current) return "install";
    return isUpdateAvailable(installed.version, current.version) ? "update" : "reinstall";
  });

  return { installedMatch, actionState };
}
