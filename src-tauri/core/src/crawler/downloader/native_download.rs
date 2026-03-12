use super::ActiveDownloadInfo;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone)]
pub struct NativeDownloadEntry {
    pub destination: PathBuf,
    pub task_id: Option<String>,
    pub surf_record_id: Option<String>,
    pub plugin_id: String,
    pub output_album_id: Option<String>,
    pub download_start_time: u64,
}

#[derive(Debug, Default)]
pub struct NativeDownloadState {
    pending: Mutex<HashMap<String, NativeDownloadEntry>>,
}

impl NativeDownloadState {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceLock<NativeDownloadState> = OnceLock::new();
        INSTANCE.get_or_init(NativeDownloadState::default)
    }

    pub fn register(&self, url: &str, entry: NativeDownloadEntry) -> Result<(), String> {
        if url.trim().is_empty() {
            return Err("native download url is empty".to_string());
        }
        let mut pending = self
            .pending
            .lock()
            .map_err(|e| format!("NativeDownloadState lock failed: {e}"))?;
        pending.insert(url.to_string(), entry);
        Ok(())
    }

    pub fn take(&self, url: &str) -> Option<NativeDownloadEntry> {
        let mut pending = self.pending.lock().ok()?;
        pending.remove(url)
    }

    pub fn get_active_downloads(&self) -> Vec<ActiveDownloadInfo> {
        let Ok(pending) = self.pending.lock() else {
            return Vec::new();
        };
        pending
            .iter()
            .map(|(url, entry)| ActiveDownloadInfo {
                url: url.clone(),
                plugin_id: entry.plugin_id.clone(),
                start_time: entry.download_start_time,
                task_id: entry
                    .task_id
                    .clone()
                    .or_else(|| entry.surf_record_id.clone())
                    .unwrap_or_default(),
                state: "downloading".to_string(),
                native: true,
            })
            .collect()
    }
}

pub fn compute_native_download_destination(url: &str, images_dir: &Path) -> Result<PathBuf, String> {
    super::compute_image_download_path(url, images_dir)
}
