import { invoke } from "@/api/rpc";
import { useSnapshotPoller } from "@/composables/useSnapshotPoller";
import { useFolderSyncStore, type FolderSyncTask } from "@/stores/folderSync";
import { useHiddenCleanupStore, type HiddenCleanupRunState } from "@/stores/hiddenCleanup";
import { useMetadataMigrationStore, type MetadataMigrationTask } from "@/stores/metadataMigration";
import { useOrganizeStore, type OrganizeRunState } from "@/stores/organize";

export interface BusyTasksSnapshot {
  organize: OrganizeRunState;
  hiddenCleanup: HiddenCleanupRunState;
  folderSync: FolderSyncTask[];
  metadataMigrations: MetadataMigrationTask[];
}

export const busyPoller = useSnapshotPoller<BusyTasksSnapshot>({
  key: "busy-tasks",
  fetch: () => invoke<BusyTasksSnapshot>("get_busy_tasks_snapshot"),
  apply: (snapshot) => {
    useOrganizeStore().applyRunState(snapshot.organize);
    useHiddenCleanupStore().applyRunState(snapshot.hiddenCleanup);
    useFolderSyncStore().applyRunState({ tasks: snapshot.folderSync });
    useMetadataMigrationStore().applyRunState(snapshot.metadataMigrations);
  },
  isActive: (snapshot) =>
    snapshot.organize.running ||
    snapshot.hiddenCleanup.running ||
    snapshot.folderSync.length > 0 ||
    snapshot.metadataMigrations.length > 0,
  wakeEvents: ["busy-tasks-change"],
});
