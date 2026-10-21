import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import { parsePluginRecommendedPreset } from "@/stores/crawler";
import { fetchRecommendedConfig, recommendedConfigPaths } from "./pluginFiles";
import { recommendedConfigKey, registerRecommendedImportStates } from "./runConfigWrites";
import { subscribeRunConfigEvents } from "@/services/runConfigs";
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

/** 先发布声明顺序的占位项，各 JSON 独立到达后替换；配置变化刷新宿主计算的导入态。 */
export function useRecommendedPresets(
  plugins: Readonly<Ref<readonly Plugin[]>> = computed(() => usePluginStore().visiblePlugins),
  enabled: Readonly<Ref<boolean>> = computed(() => true),
) {
  const entries = ref<RecommendedPresetEntry[]>([]);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let appliedSeq = 0;
  let importRevision = 0;
  let pendingSeq = 0;
  const latestImported = new Map<string, boolean>();
  const workItems = () =>
    plugins.value.flatMap((plugin) => recommendedConfigPaths(plugin).map((path) => ({ plugin, path })));
  async function refresh(rebuild = false, seq = 0) {
    const current = ++generation;
    const revision = importRevision;
    const work = workItems();
    if (rebuild) {
      appliedSeq = 0;
      latestImported.clear();
      entries.value = work.map(({ plugin, path }) => ({
        key: recommendedConfigKey(plugin, path),
        pluginId: plugin.id,
        filename: path.split("/").pop() ?? path,
        preset: null,
      }));
    }
    if (!enabled.value) return;
    await Promise.all(
      work.map(async ({ plugin, path }) => {
        const key = recommendedConfigKey(plugin, path);
        try {
          const raw = await fetchRecommendedConfig(plugin, path);
          const preset = parsePluginRecommendedPreset(raw, new Map([[plugin.id, plugin.baseUrl]]));
          if (current !== generation) return;
          const entry = entries.value.find((entry) => entry.key === key);
          if (entry && preset) {
            // 写结果先到时，不能让此前发出的旧 HTTP 响应覆盖即时导入态。
            if (revision !== importRevision && latestImported.has(key)) preset.isImported = latestImported.get(key);
            entry.preset = preset;
          } else entries.value = entries.value.filter((entry) => entry.key !== key);
        } catch (error) {
          if (current === generation) entries.value = entries.value.filter((entry) => entry.key !== key);
          console.warn("推荐配置加载失败", error);
        }
      }),
    );
    if (current === generation) appliedSeq = Math.max(appliedSeq, seq);
  }
  const unregister = registerRecommendedImportStates({
    requests: () =>
      enabled.value
        ? workItems().map(({ plugin, path }) => ({
            key: recommendedConfigKey(plugin, path),
            pluginId: plugin.id,
            version: plugin.version,
            origin: plugin.fileOrigin,
            path,
          }))
        : [],
    apply: (states, seq) => {
      if (seq < appliedSeq) return;
      appliedSeq = seq;
      importRevision++;
      for (const state of states) {
        latestImported.set(state.key, state.isImported);
        const entry = entries.value.find((entry) => entry.key === state.key);
        if (entry?.preset) entry.preset.isImported = state.isImported;
      }
      if (pendingSeq <= seq) {
        clearTimeout(timer);
        pendingSeq = 0;
      }
    },
  });
  watch([plugins, enabled], () => void refresh(true), { immediate: true });
  const unsubscribe = subscribeRunConfigEvents((event) => {
    if (event.seq > 0 && event.seq <= appliedSeq) return;
    pendingSeq = Math.max(pendingSeq, event.seq);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const seq = pendingSeq;
      pendingSeq = 0;
      void refresh(false, seq);
    }, 200);
  });
  onScopeDispose(() => {
    generation++;
    unsubscribe();
    unregister();
    clearTimeout(timer);
  });
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
