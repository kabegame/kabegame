import { computed, shallowReactive, watch, type Ref } from "vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import { parsePluginRecommendedPreset } from "@/stores/crawler";
import { pluginResourceBase, recommendedConfigPaths } from "./pluginFiles";
import { on, pathqlRequest$, usePathqlLookMany } from "./kbEvents";
import type { PluginRecommendedPreset } from "@/stores/crawler";

export type RecommendedPresetEntry = {
  key: string;
  pluginId: string;
  filename: string;
  preset: PluginRecommendedPreset | null;
};
export type RecommendedPresetQuery = {
  search: string;
  plugin: string | null;
  mode: "interval" | "hourly" | "daily" | "weekly" | "none" | null;
  imported: "yes" | "no" | null;
  sort: "plugin" | "name" | "schedule";
  dir: "asc" | "desc";
};

export function presetKey(preset: Pick<PluginRecommendedPreset, "pluginId" | "filename">) {
  return `${preset.pluginId}/${preset.filename}`;
}

/** 按插件观察推荐行；声明顺序占位，事件刷新由核心的统一窗口处理。 */
export function useRecommendedPresets(
  plugins: Readonly<Ref<readonly Plugin[]>> = computed(() => usePluginStore().visiblePlugins),
  enabled: Readonly<Ref<boolean>> = computed(() => true),
) {
  const pluginsByKey = computed(
    () =>
      new Map<string, Plugin>(
        enabled.value
          ? plugins.value
              .filter((plugin) => recommendedConfigPaths(plugin).length)
              .map((plugin) => [`${pluginResourceBase(plugin)}/recommended`, plugin] as const)
          : [],
      ),
  );
  const keys = computed(() => [...pluginsByKey.value.keys()]);
  const loaded = shallowReactive(new Map<string, RecommendedPresetEntry[]>());
  const entries = computed(() =>
    [...pluginsByKey.value].flatMap(
      ([key, plugin]) =>
        loaded.get(key) ??
        recommendedConfigPaths(plugin).map((path) => ({
          key: `${key}/${encodeURIComponent(path)}`,
          pluginId: plugin.id,
          filename: path.split("/").pop() ?? path,
          preset: null,
        })),
    ),
  );

  usePathqlLookMany({
    kind: "rows",
    keys: () => keys.value,
    refreshOn: (key) => [
      on(
        "plugin-changed",
        (payload) =>
          payload.pluginId === pluginsByKey.value.get(key)?.id &&
          (payload.changes?.version !== undefined || payload.changes?.recommendedConfigs !== undefined),
      ),
    ],
    onResult: (key, { rows }) => {
      const plugin = pluginsByKey.value.get(key);
      if (!plugin) return;
      const byPath = new Map(rows.map((row) => [row.path, row]));
      loaded.set(
        key,
        recommendedConfigPaths(plugin).flatMap((path) => {
          const preset = parsePluginRecommendedPreset(byPath.get(path), new Map([[plugin.id, plugin.baseUrl]]));
          return preset
            ? [{ key: `${key}/${encodeURIComponent(path)}`, pluginId: plugin.id, filename: preset.filename, preset }]
            : [];
        }),
      );
    },
    onError: (key, error) => {
      // 已有内容保留；首次失败则移除骨架，手动刷新仍可恢复。
      if (!loaded.has(key)) loaded.set(key, []);
      console.warn("推荐配置加载失败", error);
    },
  });
  watch(
    keys,
    (next, previous = []) => {
      const before = new Set(previous);
      for (const key of loaded.keys()) if (!pluginsByKey.value.has(key)) loaded.delete(key);
      // 观察方已同步注册；新增 key 是用户操作，只请求该 key。
      for (const key of next) if (!before.has(key)) pathqlRequest$.next(["rows", key]);
    },
    { immediate: true, flush: "sync" },
  );
  function refresh() {
    for (const key of keys.value) pathqlRequest$.next(["rows", key]);
  }
  const presets = computed(() => entries.value.flatMap((entry) => (entry.preset ? [entry.preset] : [])));
  return { entries, presets, refresh };
}

export function filterRecommendedPresets(
  presets: PluginRecommendedPreset[],
  query: RecommendedPresetQuery,
  title: (preset: PluginRecommendedPreset) => string,
  description: (preset: PluginRecommendedPreset) => string,
) {
  const search = query.search.trim().toLocaleLowerCase();
  const sign = query.dir === "asc" ? 1 : -1;
  return presets
    .filter((preset) => {
      const importedState = preset.isImported ? "yes" : "no";
      return (
        (!search || `${title(preset)} ${description(preset)}`.toLocaleLowerCase().includes(search)) &&
        (!query.plugin || preset.pluginId === query.plugin) &&
        (!query.mode || (preset.scheduleSpec?.mode ?? "none") === query.mode) &&
        (!query.imported || importedState === query.imported)
      );
    })
    .sort((a, b) => {
      let result = 0;
      if (query.sort === "plugin") result = a.pluginId.localeCompare(b.pluginId);
      else if (query.sort === "name") result = title(a).localeCompare(title(b));
      else result = Number(!a.scheduleSpec) - Number(!b.scheduleSpec);
      return result * sign || a.filename.localeCompare(b.filename);
    });
}

export function recommendedFacetCounts(
  presets: PluginRecommendedPreset[],
  query: RecommendedPresetQuery,
  dimension: "plugin" | "mode" | "imported",
  title: (preset: PluginRecommendedPreset) => string,
  description: (preset: PluginRecommendedPreset) => string,
) {
  const relaxed = { ...query, [dimension]: null };
  const counts: Record<string, number> = {};
  for (const preset of filterRecommendedPresets(presets, relaxed, title, description)) {
    const value =
      dimension === "plugin"
        ? preset.pluginId
        : dimension === "mode"
          ? (preset.scheduleSpec?.mode ?? "none")
          : preset.isImported
            ? "yes"
            : "no";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
