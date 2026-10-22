import { invoke } from "@/api";
import { emptyBatch, holdRunConfigEvents, publishLocal, type RunConfigChange } from "./dataChangeHub";
import type { RowsSnapshot } from "./liveQuery";

interface WriteResult {
  config: Record<string, unknown> | null;
  configId: string;
  reason: RunConfigChange["reason"];
  seq: number;
  view?: RowsSnapshot | null;
}
type ViewTarget = { key: () => string | null; apply: (snapshot: RowsSnapshot) => Promise<void> | void };
const views = new Set<ViewTarget>();
export function registerRunConfigView(target: ViewTarget): () => void {
  views.add(target);
  return () => {
    views.delete(target);
  };
}
/** 自身写操作统一出口；响应中的行快照先落地，再释放异步补位。 */
export async function writeRunConfig(
  method: "add_run_config" | "update_run_config" | "delete_run_config" | "copy_run_config",
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const target = [...views].reverse().find((view) => view.key());
  const view = target?.key() ?? null;
  const release = holdRunConfigEvents();
  try {
    const result = await invoke<WriteResult>(method, { ...params, view });
    if (result.view && view && target && views.has(target) && target.key() === view) await target.apply(result.view);
    const batch = emptyBatch(result.seq);
    batch.runConfigs.set(result.configId, { reason: result.reason, config: result.config });
    publishLocal(batch);
    return result.config;
  } finally {
    release();
  }
}
