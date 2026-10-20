import { invoke } from "@/api";
import { onScopeDispose, ref } from "vue";
import { subscribeRunConfigEvents } from "@/services/runConfigs";
import type { PluginRecommendedPreset } from "@/stores/crawler";

type ImportedPresetRow = { pluginId: string; filename: string; configIds: string[] };
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

export function useImportedPresets() {
  const imported = ref(new Map<string, string[]>());
  const loading = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function refresh() {
    loading.value = true;
    try {
      const rows = await invoke<ImportedPresetRow[]>("list_imported_recommended_presets");
      imported.value = new Map(
        (Array.isArray(rows) ? rows : []).map((row) => [`${row.pluginId}/${row.filename}`, row.configIds ?? []]),
      );
    } finally {
      loading.value = false;
    }
  }

  const unsubscribe = subscribeRunConfigEvents(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 200);
  });
  onScopeDispose(() => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  });
  return { imported, loading, refresh };
}

export function filterRecommendedPresets(
  presets: PluginRecommendedPreset[],
  query: RecommendedPresetQuery,
  imported: Map<string, string[]>,
  title: (preset: PluginRecommendedPreset) => string,
  description: (preset: PluginRecommendedPreset) => string,
) {
  const search = query.search.trim().toLocaleLowerCase();
  const sign = query.dir === "asc" ? 1 : -1;
  return presets
    .filter((preset) => {
      const importedState = (imported.get(presetKey(preset))?.length ?? 0) > 0 ? "yes" : "no";
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
  imported: Map<string, string[]>,
  title: (preset: PluginRecommendedPreset) => string,
  description: (preset: PluginRecommendedPreset) => string,
) {
  const relaxed = { ...query, [dimension]: null };
  const counts: Record<string, number> = {};
  for (const preset of filterRecommendedPresets(presets, relaxed, imported, title, description)) {
    const value =
      dimension === "plugin"
        ? preset.pluginId
        : dimension === "mode"
          ? (preset.scheduleSpec?.mode ?? "none")
          : (imported.get(presetKey(preset))?.length ?? 0) > 0
            ? "yes"
            : "no";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
