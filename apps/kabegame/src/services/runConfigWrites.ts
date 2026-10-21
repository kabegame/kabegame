import { invoke } from "@/api";
import type { Plugin } from "@/stores/plugins";
import { emptyBatch, holdRunConfigEvents, publishLocal, type RunConfigChange } from "./dataChangeHub";
import type { RowsSnapshot } from "./liveQuery";

export interface RecommendedConfigRequest {
  key: string;
  pluginId: string;
  version: string;
  origin?: Plugin["fileOrigin"];
  path: string;
}
export interface RecommendedImportState {
  key: string;
  isImported: boolean;
}
interface WriteResult {
  config: Record<string, unknown> | null;
  configId: string;
  reason: RunConfigChange["reason"];
  seq: number;
  view?: RowsSnapshot | null;
  recommended: RecommendedImportState[];
  recommendedSeq: number;
}
type ViewTarget = { key: () => string | null; apply: (snapshot: RowsSnapshot) => Promise<void> | void };
type PresetTarget = {
  requests: () => RecommendedConfigRequest[];
  apply: (states: RecommendedImportState[], seq: number) => void;
};
const views = new Set<ViewTarget>();
const presets = new Set<PresetTarget>();
export function registerRunConfigView(target: ViewTarget): () => void {
  views.add(target);
  return () => {
    views.delete(target);
  };
}
export function registerRecommendedImportStates(target: PresetTarget): () => void {
  presets.add(target);
  return () => {
    presets.delete(target);
  };
}
export function recommendedConfigKey(plugin: Plugin, path: string): string {
  return JSON.stringify([plugin.id, plugin.version, plugin.fileOrigin ?? { kind: "installed" }, path]);
}

/** 自身写操作统一出口；响应中的行快照和导入态先落地，再释放异步补位。 */
export async function writeRunConfig(
  method: "add_run_config" | "update_run_config" | "delete_run_config" | "copy_run_config",
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const target = [...views].reverse().find((view) => view.key());
  const view = target?.key() ?? null;
  const presetTargets = [...presets].map((target) => ({ target, requests: target.requests() }));
  const requests = new Map(presetTargets.flatMap(({ requests }) => requests).map((request) => [request.key, request]));
  const release = holdRunConfigEvents();
  try {
    const result = await invoke<WriteResult>(method, { ...params, view, recommended: [...requests.values()] });
    if (result.view && view && target && views.has(target) && target.key() === view) await target.apply(result.view);
    for (const { target, requests } of presetTargets) {
      // 页面或插件来源已切换时，旧响应不能声称覆盖新一组推荐项的事件。
      if (presets.has(target) && JSON.stringify(target.requests()) === JSON.stringify(requests)) {
        target.apply(result.recommended, result.recommendedSeq);
      }
    }
    const batch = emptyBatch(result.seq);
    batch.runConfigs.set(result.configId, { reason: result.reason, config: result.config });
    publishLocal(batch);
    return result.config;
  } finally {
    release();
  }
}
