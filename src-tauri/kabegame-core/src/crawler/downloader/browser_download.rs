use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

#[derive(Debug)]
pub struct BrowserDownloadResult {
    pub path: Option<PathBuf>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug)]
struct PendingEntry {
    destination: PathBuf,
    task_id: String,
    completion_tx: Option<oneshot::Sender<BrowserDownloadResult>>,
}

#[derive(Debug, Default)]
struct BrowserDownloadStateInner {
    pending: HashMap<String, PendingEntry>,
    blob_to_id: HashMap<String, String>,
    id_to_blob: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct BrowserDownloadState {
    inner: Mutex<BrowserDownloadStateInner>,
}

impl BrowserDownloadState {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceLock<BrowserDownloadState> = OnceLock::new();
        INSTANCE.get_or_init(BrowserDownloadState::default)
    }

    pub fn register(
        &self,
        download_id: String,
        destination: PathBuf,
        task_id: String,
        completion_tx: oneshot::Sender<BrowserDownloadResult>,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("BrowserDownloadState lock failed: {e}"))?;
        inner.pending.insert(
            download_id,
            PendingEntry {
                destination,
                task_id,
                completion_tx: Some(completion_tx),
            },
        );
        Ok(())
    }

    pub fn register_blob_url(&self, download_id: &str, blob_url: &str) -> Result<(), String> {
        if download_id.trim().is_empty() {
            return Err("download_id is empty".to_string());
        }
        if blob_url.trim().is_empty() {
            return Err("blob_url is empty".to_string());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("BrowserDownloadState lock failed: {e}"))?;
        if !inner.pending.contains_key(download_id) {
            return Err(format!("Pending browser download not found: {download_id}"));
        }
        if let Some(old_blob) = inner
            .id_to_blob
            .insert(download_id.to_string(), blob_url.to_string())
        {
            inner.blob_to_id.remove(&old_blob);
        }
        inner
            .blob_to_id
            .insert(blob_url.to_string(), download_id.to_string());
        Ok(())
    }

    pub fn resolve_destination_by_blob_url(&self, blob_url: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().ok()?;
        let download_id = inner.blob_to_id.get(blob_url)?;
        let pending = inner.pending.get(download_id)?;
        Some(pending.destination.clone())
    }

    pub fn signal_completion_by_blob_url(
        &self,
        blob_url: &str,
        path: Option<PathBuf>,
        success: bool,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("BrowserDownloadState lock failed: {e}"))?;
        let Some(download_id) = inner.blob_to_id.remove(blob_url) else {
            return Err(format!("Blob URL not registered: {blob_url}"));
        };
        inner.id_to_blob.remove(&download_id);
        let Some(mut entry) = inner.pending.remove(&download_id) else {
            return Err(format!("Pending browser download not found: {download_id}"));
        };
        if let Some(tx) = entry.completion_tx.take() {
            let _ = tx.send(BrowserDownloadResult {
                path,
                success,
                error: if success {
                    None
                } else {
                    Some("Browser download finished with failure".to_string())
                },
            });
        }
        Ok(())
    }

    pub fn signal_failure(&self, download_id: &str, error: String) -> Result<(), String> {
        if download_id.trim().is_empty() {
            return Err("download_id is empty".to_string());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("BrowserDownloadState lock failed: {e}"))?;
        if let Some(blob) = inner.id_to_blob.remove(download_id) {
            inner.blob_to_id.remove(&blob);
        }
        let Some(mut entry) = inner.pending.remove(download_id) else {
            return Err(format!("Pending browser download not found: {download_id}"));
        };
        if let Some(tx) = entry.completion_tx.take() {
            let _ = tx.send(BrowserDownloadResult {
                path: None,
                success: false,
                error: Some(error),
            });
        }
        Ok(())
    }

    pub fn is_pending_for_task(&self, download_id: &str, task_id: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        inner
            .pending
            .get(download_id)
            .map(|entry| entry.task_id == task_id)
            .unwrap_or(false)
    }
}
