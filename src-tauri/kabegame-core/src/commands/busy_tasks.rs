use crate::storage::hidden_cleanup::{HiddenCleanupRunState, HiddenCleanupService};
use crate::storage::organize::{OrganizeRunState, OrganizeService};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusyTasksSnapshot {
    pub organize: OrganizeRunState,
    pub hidden_cleanup: HiddenCleanupRunState,
    #[cfg(not(target_os = "android"))]
    pub folder_sync: Vec<crate::local_folder::FolderSyncTaskState>,
    #[cfg(target_os = "android")]
    pub folder_sync: Vec<Value>,
    #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
    pub metadata_migrations: Vec<crate::plugin::metadata_migration::MetadataMigrationTaskState>,
    #[cfg(not(all(not(target_os = "ios"), feature = "plugin-runtime")))]
    pub metadata_migrations: Vec<Value>,
}

pub fn get_busy_tasks_snapshot() -> Result<Value, String> {
    let snapshot = BusyTasksSnapshot {
        organize: OrganizeService::global().get_run_state(),
        hidden_cleanup: HiddenCleanupService::global().get_run_state(),
        #[cfg(not(target_os = "android"))]
        folder_sync: crate::local_folder::FolderSyncService::global().snapshot(),
        #[cfg(target_os = "android")]
        folder_sync: Vec::new(),
        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        metadata_migrations: crate::plugin::metadata_migration::MetadataMigrationService::global()
            .snapshot(),
        #[cfg(not(all(not(target_os = "ios"), feature = "plugin-runtime")))]
        metadata_migrations: Vec::new(),
    };
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}
