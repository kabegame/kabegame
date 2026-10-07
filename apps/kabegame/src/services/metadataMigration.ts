import { listen, type UnlistenFn } from "@/api/rpc";
import { busyPoller } from "@/services/busyTasks";
import { useMetadataMigrationStore, type MetadataMigrationFinished } from "@/stores/metadataMigration";
import { usePluginStore } from "@/stores/plugins";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";

let unlistenFinished: UnlistenFn | null = null;

export async function init(): Promise<void> {
  const store = useMetadataMigrationStore();
  unlistenFinished = await listen<MetadataMigrationFinished>("metadata-migration-finished", (event) => {
    busyPoller.invalidate();
    store.applyFinished(event.payload);
    if (!event.payload.error) return;
    const pluginName = usePluginStore().pluginLabel(event.payload.pluginId);
    ElMessage.error(i18n.global.t("plugins.metadataMigrationFailed", { name: pluginName }));
  });
}

export function dispose(): void {
  unlistenFinished?.();
  unlistenFinished = null;
}
