import { listen, type UnlistenFn } from "@/api/rpc";
import { busyPoller } from "@/services/busyTasks";
import { useBackfillStore, type BackfillFinished } from "@/stores/backfill";
import { backfillName } from "@/utils/backfillName";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";

let unlistenFinished: UnlistenFn | null = null;

export async function init(): Promise<void> {
  const store = useBackfillStore();
  unlistenFinished = await listen<BackfillFinished>("backfill-finished", (event) => {
    busyPoller.invalidate();
    store.applyFinished(event.payload);
    if (!event.payload.error) return;
    ElMessage.error(i18n.global.t("header.backfillFailed", { name: backfillName(event.payload.id) }));
  });
}

export function dispose(): void {
  unlistenFinished?.();
  unlistenFinished = null;
}
