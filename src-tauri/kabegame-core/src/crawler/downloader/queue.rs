use crate::crawler::TaskScheduler;
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex, Notify, RwLock};
use url::Url;

use super::{
    download_with_retry, emit_task_log, wait_after_download_if_needed,
    wait_after_non_pool_download_if_needed,
};
use super::{media_upload, postprocess_downloaded_image};

static DOWNLOAD_ID_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn next_download_id() -> u64 {
    DOWNLOAD_ID_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 下载状态枚举。serde `rename_all = "lowercase"` 产出现有线上小写字符串。
/// 状态机校验在 `DownloadQueue::switch_state` 中执行。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    #[default]
    Preparing,
    Downloading,
    Processing,
    Completed,
    Canceled,
    Failed,
}

impl DownloadState {
    /// 终态：completed / canceled / failed。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            DownloadState::Completed | DownloadState::Canceled | DownloadState::Failed
        )
    }

    /// 合法跳转表（覆盖 worker 实际出现的全部跳转；终态不可再切）。
    pub fn can_transition_to(self, next: DownloadState) -> bool {
        use DownloadState::*;
        match self {
            Preparing => matches!(
                next,
                Preparing | Downloading | Processing | Completed | Canceled | Failed
            ),
            // Downloading → Downloading 为 browser 流幂等重发
            Downloading => {
                matches!(
                    next,
                    Downloading | Processing | Completed | Canceled | Failed
                )
            }
            Processing => matches!(next, Processing | Completed | Canceled | Failed),
            Completed => matches!(next, Completed),
            Canceled => matches!(next, Canceled),
            Failed => matches!(next, Failed),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDownloadInfo {
    pub id: u64,
    pub url: String,
    pub plugin_id: String,
    pub start_time: u64,
    pub task_id: String,
    #[serde(default)]
    pub state: DownloadState,
    #[serde(default)]
    pub native: bool,
    pub retried_for: Option<i64>,
    /// 已接收字节数（由 writer 经 `report_progress` 持续上报）。
    #[serde(default)]
    pub received_bytes: u64,
    /// 总字节数（HTTP Content-Length / content 已知大小）；未知时为 None → 不确定进度。
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(skip)]
    pub surf_record_id: Option<String>,
    #[serde(skip)]
    pub http_headers: HashMap<String, String>,
    #[serde(skip)]
    pub output_album_id: Option<String>,
    #[serde(skip)]
    pub custom_display_name: Option<String>,
    #[serde(skip)]
    pub metadata_id: Option<i64>,
    #[serde(skip)]
    pub post_url: Option<String>,
}

pub(super) fn emit_task_image_counts_snapshot(task_id: &str) {
    if let Ok(Some(t)) = Storage::global().get_task(task_id) {
        GlobalEmitter::global().emit_task_image_counts(
            task_id,
            Some(t.success_count),
            Some(t.deleted_count),
            Some(t.failed_count),
            Some(t.dedup_count),
        );
    }
}

pub(super) fn clear_failed_image_after_success(failed_image_id: Option<i64>) {
    if let Some(fid) = failed_image_id {
        let task_id = Storage::get_task_failed_image_by_id(fid)
            .ok()
            .flatten()
            .map(|item| item.task_id);
        let _ = Storage::global().delete_task_failed_image(fid);
        if let Some(ref tid) = task_id {
            GlobalEmitter::global().emit_failed_image_removed(tid, fid);
            emit_task_image_counts_snapshot(tid);
        }
    }
}

pub(super) fn upsert_failed_image_on_failure(
    failed_image_id: Option<i64>,
    task_id: &str,
    plugin_id: &str,
    url: &str,
    order: i64,
    error: &str,
    http_headers: &HashMap<String, String>,
    metadata_id: Option<i64>,
    custom_display_name: Option<&str>,
) {
    if let Some(fid) = failed_image_id {
        let _ = Storage::global().update_task_failed_image_attempt(fid, error);
        let _ = Storage::global().update_task_failed_image_header_snapshot(fid, http_headers);
        if let Ok(Some(failed_image)) = Storage::get_task_failed_image_by_id(fid) {
            GlobalEmitter::global().emit_failed_image_updated(task_id, &failed_image);
        }
        return;
    }
    if let Ok(failed_image) = Storage::global().add_task_failed_image(
        task_id,
        plugin_id,
        url,
        order,
        Some(error),
        Some(http_headers),
        metadata_id,
        custom_display_name,
    ) {
        GlobalEmitter::global().emit_failed_image_added(task_id, &failed_image);
        emit_task_image_counts_snapshot(task_id);
    }
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub id: u64,
    pub url: Url,
    pub images_dir: PathBuf,
    pub plugin_id: String,
    pub task_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
    pub failed_image_id: Option<i64>,
    /// 脚本/爬虫指定的展示名；为空则沿用文件名或 URL 推断。
    pub custom_display_name: Option<String>,
    /// 已写入 `image_metadata` 的 id。
    pub metadata_id: Option<i64>,
    /// 帖子/页面地址（与下载 URL 分开）；爬虫传入时为当前页面 URL。
    pub post_url: Option<String>,
}

#[derive(Clone)]
pub struct DownloadQueue {
    /// 等待被 worker 取走的下载请求
    pub pending_queue: Arc<Mutex<VecDeque<DownloadRequest>>>,
    /// worker 正在处理的下载
    pub active_downloads: Arc<StdMutex<Vec<ActiveDownloadInfo>>>,
    /// 待取消的 download_id
    pub canceled_downloads: Arc<RwLock<HashSet<u64>>>,
    /// 当前存在的 worker 数量，由 worker 退出时减 1
    pub total_workers: Arc<Mutex<u32>>,
    /// 有新的 job 时 notify，worker 在 loop 开头 select 等此信号
    pub job_notify: Arc<Notify>,
    /// 需要缩减 worker 时 notify_one，worker 被唤醒后检查 desired，若 total > desired 则减 1 并退出
    pub exit_notify: Arc<Notify>,
    /// 下载完成时 notify_waiters，唤醒等待容量的阻塞 download() 调用
    pub capacity_notify: Arc<Notify>,
}

impl DownloadQueue {
    pub fn new() -> Self {
        Self {
            pending_queue: Arc::new(Mutex::new(VecDeque::new())),
            active_downloads: Arc::new(StdMutex::new(Vec::new())),
            canceled_downloads: Arc::new(RwLock::new(HashSet::new())),
            total_workers: Arc::new(Mutex::new(0)),
            job_notify: Arc::new(Notify::new()),
            exit_notify: Arc::new(Notify::new()),
            capacity_notify: Arc::new(Notify::new()),
        }
    }

    pub async fn cancel_retried_download(&self, failed_image_id: i64) -> bool {
        let did = {
            self.active_downloads
                .lock()
                .unwrap()
                .iter()
                .find(|d| matches!(d.retried_for, Some(fid) if fid == failed_image_id))
                .map(|d| d.id)
        };
        if let Some(did) = did {
            self.canceled_downloads.write().await.insert(did)
        } else {
            false
        }
    }

    pub async fn start_download_workers(&self, count: u32) {
        let n = count.max(1);
        {
            let mut total = self.total_workers.lock().await;
            *total += n;
        }
        for _ in 0..n {
            let dq = Arc::new(self.clone());
            tokio::spawn(async move { download_worker_loop(dq).await });
        }
    }

    pub async fn set_desired_concurrency_from_settings(&self) {
        let desired = Settings::global().get_max_concurrent_downloads().max(1);
        let mut total = self.total_workers.lock().await;
        if *total < desired {
            let add = desired - *total;
            *total = desired;
            drop(total);
            for _ in 0..add {
                let dq = Arc::new(self.clone());
                tokio::spawn(async move { download_worker_loop(dq).await });
            }
            self.job_notify.notify_waiters();
            self.capacity_notify.notify_waiters();
        } else if *total > desired {
            let exit_count = *total - desired;
            drop(total);
            for _ in 0..exit_count {
                self.exit_notify.notify_one();
            }
        }
    }

    pub fn notify_all_waiting(&self) {
        self.job_notify.notify_waiters();
    }

    pub async fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        Ok(self
            .active_downloads
            .lock()
            .map_err(|e| format!("active_downloads lock failed: {e}"))?
            .clone())
    }

    pub fn register_native(&self, info: ActiveDownloadInfo) -> Result<(), String> {
        if info.url.trim().is_empty() {
            return Err("native download url is empty".to_string());
        }
        self.active_downloads
            .lock()
            .map_err(|e| format!("active_downloads lock failed: {e}"))?
            .push(info.clone());

        eprintln!("register {:?}", info);
        GlobalEmitter::global().emit_download_state(
            info.id,
            info.url.as_str(),
            info.start_time,
            info.plugin_id.as_str(),
            info.state,
            None,
            None,
            true,
        );

        Ok(())
    }

    pub fn get_native(&self, url: &str) -> Option<ActiveDownloadInfo> {
        self.active_downloads
            .lock()
            .ok()?
            .iter()
            .find(|download| download.native && download.url == url)
            .cloned()
    }

    pub fn contains_native(&self, url: &str) -> bool {
        self.active_downloads
            .lock()
            .map(|downloads| {
                downloads
                    .iter()
                    .any(|download| download.native && download.url == url)
            })
            .unwrap_or(false)
    }

    pub fn take_native(&self, url: &str) -> Option<ActiveDownloadInfo> {
        let mut downloads = self.active_downloads.lock().ok()?;
        let index = downloads
            .iter()
            .position(|download| download.native && download.url == url)?;
        let info = downloads.remove(index);
        Some(info)
    }

    pub fn update_native_state(&self, url: &str, state: DownloadState) {
        if let Ok(mut downloads) = self.active_downloads.lock() {
            if let Some(download) = downloads
                .iter_mut()
                .find(|download| download.native && download.url == url)
            {
                download.state = state;
            }
        }
    }

    pub async fn is_active_downloading(&self, download_id: u64) -> bool {
        self.active_downloads
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.id == download_id)
    }

    pub async fn is_active_task_downloading(&self, task_id: &str) -> bool {
        self.active_downloads
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.task_id == task_id)
    }

    async fn is_pending_task_downloads(&self, task_id: &str) -> bool {
        self.pending_queue
            .lock()
            .await
            .iter()
            .any(|d| d.task_id == task_id)
    }

    async fn is_pending_download(&self, download_id: u64) -> bool {
        self.pending_queue
            .lock()
            .await
            .iter()
            .any(|d| d.id == download_id)
    }

    // 是否正在重试下载
    async fn is_retrying(&self, failed_image_id: i64) -> bool {
        self.active_downloads
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.retried_for.is_some_and(|id| id == failed_image_id))
            || self
                .pending_queue
                .lock()
                .await
                .iter()
                .any(|d| d.failed_image_id.is_some_and(|id| id == failed_image_id))
    }

    async fn get_pending_task_download_ids(&self, task_id: &str) -> Vec<u64> {
        self.pending_queue
            .lock()
            .await
            .iter()
            .filter_map(|d| (d.task_id == task_id).then_some(d.id))
            .collect()
    }

    /// 由 writer 在写路径上发送任务日志（warn/info/error）。
    /// 非阻塞：用 `try_lock` 查找 task_id；拿不到锁则静默丢弃。
    pub fn emit_log_by_download_id(
        &self,
        download_id: u64,
        level: &str,
        message: impl Into<String>,
    ) {
        if let Ok(list) = self.active_downloads.try_lock() {
            if let Some(t) = list.iter().find(|t| t.id == download_id) {
                GlobalEmitter::global().emit_task_log(&t.task_id, level, &message.into());
            }
        }
    }

    /// 由 writer 在写路径（`poll_write` / `set_total`）中调用上报进度。
    /// 非阻塞：用 `try_lock`；拿不到锁就跳过（进度尽力上报，偶发跳过无碍）。
    pub fn report_progress(&self, download_id: u64, received: u64, total: Option<u64>) {
        if let Ok(mut list) = self.active_downloads.try_lock() {
            if let Some(t) = list.iter_mut().find(|t| t.id == download_id) {
                t.received_bytes = received;
                t.total_bytes = total;
            }
        }
        GlobalEmitter::global().emit_download_progress(download_id, received, total);
    }

    pub async fn download_image(
        &self,
        url: Url,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        custom_display_name: Option<String>,
        metadata_id: Option<i64>,
        post_url: Option<String>,
    ) -> Result<(), String> {
        self.download(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            None,
            custom_display_name,
            metadata_id,
            true,
            post_url,
        )
        .await
    }

    pub async fn download_image_retry(
        &self,
        failed_image_id: i64,
        url: Url,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        metadata_id: Option<i64>,
        custom_display_name: Option<String>,
        post_url: Option<String>,
    ) -> Result<(), String> {
        if self.is_retrying(failed_image_id).await {
            return Err("Has been restarted".to_string());
        }
        self.download(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            Some(failed_image_id),
            custom_display_name,
            metadata_id,
            false,
            post_url,
        )
        .await
    }

    /// `blocking=true`：等到并发槽位空闲再入队（普通下载）。
    /// `blocking=false`：直接入队不等待（失败重试等后台补偿场景）。
    pub async fn download(
        &self,
        url: Url,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        failed_image_id: Option<i64>,
        custom_display_name: Option<String>,
        metadata_id: Option<i64>,
        blocking: bool,
        post_url: Option<String>,
    ) -> Result<(), String> {
        let download_id = next_download_id();

        let request = DownloadRequest {
            id: download_id,
            url,
            images_dir,
            plugin_id,
            task_id: task_id.clone(),
            download_start_time,
            output_album_id,
            http_headers,
            failed_image_id,
            custom_display_name,
            metadata_id,
            post_url,
        };

        if !blocking {
            if TaskScheduler::global().is_task_canceled(&task_id) {
                return Err("Task canceled".into());
            }
            self.pending_queue.lock().await.push_back(request);
            self.job_notify.notify_one();
            return Ok(());
        }

        loop {
            let notified = self.capacity_notify.notified();
            tokio::pin!(notified);
            // 先订阅通知再检查容量，避免在检查和等待之间错过通知
            notified.as_mut().enable();

            let desired = Settings::global().get_max_concurrent_downloads().max(1) as usize;
            let active_pool = self
                .active_downloads
                .lock()
                .unwrap()
                .iter()
                .filter(|d| !d.native)
                .count();
            if active_pool < desired {
                if TaskScheduler::global().is_task_canceled(&task_id) {
                    return Err("Task canceled".into());
                }
                self.pending_queue.lock().await.push_back(request);
                self.job_notify.notify_one();
                return Ok(());
            }
            notified.await;
        }
    }

    pub async fn is_download_canceled(&self, download_id: u64) -> bool {
        self.canceled_downloads.read().await.contains(&download_id)
    }

    /// 同步检查取消状态，供 AsyncWrite::poll_write 等同步上下文使用。
    /// 使用 try_read 非阻塞尝试：锁被占用时返回 false（尽力检查，下次 poll 再查）。
    pub fn is_download_canceled_sync(&self, download_id: u64) -> bool {
        self.canceled_downloads
            .try_read()
            .map(|set| set.contains(&download_id))
            .unwrap_or(false)
    }

    /// 将 job 加入 active_downloads 并发送 Preparing 事件。
    pub async fn add_active_then_prepare(&self, job: &DownloadRequest) {
        let info = ActiveDownloadInfo {
            id: job.id,
            url: job.url.to_string(),
            plugin_id: job.plugin_id.clone(),
            start_time: job.download_start_time,
            task_id: job.task_id.clone(),
            state: DownloadState::Preparing,
            native: false,
            retried_for: job.failed_image_id,
            received_bytes: 0,
            total_bytes: None,
            surf_record_id: None,
            http_headers: job.http_headers.clone(),
            output_album_id: job.output_album_id.clone(),
            custom_display_name: job.custom_display_name.clone(),
            metadata_id: job.metadata_id,
            post_url: job.post_url.clone(),
        };
        self.active_downloads.lock().unwrap().push(info);

        GlobalEmitter::global().emit_download_state(
            job.id,
            job.url.as_str(),
            job.download_start_time,
            &job.plugin_id,
            DownloadState::Preparing,
            None,
            job.failed_image_id,
            false,
        );
    }

    pub async fn cancel_download(&self, download_id: u64) -> Result<bool, String> {
        if self.is_download_canceled(download_id).await {
            return Ok(false);
        }
        let in_pending = self.is_pending_download(download_id).await;
        let is_active = self.is_active_downloading(download_id).await;
        if in_pending || is_active {
            Ok(self.canceled_downloads.write().await.insert(download_id))
        } else {
            Err("No such download".into())
        }
    }

    pub async fn cancel_task_downloads(&self, task_id: &str) -> bool {
        let upload_ids = media_upload::abort_task_sessions(task_id);
        let (active_ids, native_entries): (Vec<u64>, Vec<ActiveDownloadInfo>) = {
            let mut downloads = self.active_downloads.lock().unwrap();
            let mut pool_ids = Vec::new();
            let mut native = Vec::new();
            let mut i = 0;
            while i < downloads.len() {
                if downloads[i].task_id == task_id {
                    if downloads[i].native {
                        native.push(downloads.remove(i));
                        continue;
                    }
                    pool_ids.push(downloads[i].id);
                }
                i += 1;
            }
            (pool_ids, native)
        };
        let pending_ids = self.get_pending_task_download_ids(task_id).await;

        if active_ids.is_empty()
            && pending_ids.is_empty()
            && native_entries.is_empty()
            && upload_ids.is_empty()
        {
            return false;
        }
        let pool_canceled = {
            let mut canceled = self.canceled_downloads.write().await;
            active_ids
                .iter()
                .chain(pending_ids.iter())
                .all(|&id| canceled.insert(id))
        };
        for entry in &native_entries {
            self.emit_state(
                entry.id,
                &entry.url,
                entry.start_time,
                &entry.plugin_id,
                DownloadState::Canceled,
                None,
                None,
                true,
            );
            GlobalEmitter::global().emit_download_removed(entry.id);
        }
        pool_canceled || !native_entries.is_empty() || !upload_ids.is_empty()
    }

    /// 按 id 切换 active_downloads 状态 + 发事件。状态机非法跳转直接拒绝（不改不发，stderr 日志）。
    /// 返回 true 表示已切换并发送事件。
    pub async fn switch_state(&self, id: u64, next: DownloadState, error: Option<&str>) -> bool {
        let Some((url, start_time, plugin_id, retried_for, native)) = ({
            let mut downloads = self.active_downloads.lock().unwrap();
            let Some(download) = downloads.iter_mut().find(|t| t.id == id) else {
                return false;
            };
            let current = download.state;
            if !current.can_transition_to(next) {
                eprintln!(
                    "[DownloadQueue] Illegal state transition: {:?} -> {:?} (id={})",
                    current, next, id
                );
                return false;
            }
            download.state = next;
            Some((
                download.url.clone(),
                download.start_time,
                download.plugin_id.clone(),
                download.retried_for,
                download.native,
            ))
        }) else {
            return false;
        };

        if matches!(next, DownloadState::Canceled) {
            self.canceled_downloads.write().await.retain(|&d| d != id);
        }

        GlobalEmitter::global().emit_download_state(
            id,
            &url,
            start_time,
            &plugin_id,
            next,
            error,
            retried_for,
            native,
        );

        true
    }

    pub fn get_active_download(&self, id: u64) -> Option<ActiveDownloadInfo> {
        self.active_downloads
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id == id)
            .cloned()
    }

    /// 等待一段时间后，从 active_downloads 中移除 id 对应的条目，并发送事件。
    pub async fn wait_then_finish_download(&self, id: u64, notify_exit: bool) {
        let exit_notify = notify_exit.then_some(self.exit_notify.as_ref());
        wait_after_download_if_needed(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            exit_notify,
        )
        .await;
        self.finish_download(id).await;
    }

    async fn finish_download(&self, id: u64) {
        let mut downloads = self.active_downloads.lock().unwrap();
        downloads.retain(|t| t.id != id);
        drop(downloads);
        self.capacity_notify.notify_waiters();
        GlobalEmitter::global().emit_download_removed(id);
    }

    /// 直接发送 download-state 事件（不过状态机，用于无 active_downloads 条目的终态发送）。
    pub fn emit_state(
        &self,
        id: u64,
        url: &str,
        download_start_time: u64,
        plugin_id: &str,
        state: DownloadState,
        error: Option<&str>,
        failed_image_id: Option<i64>,
        native: bool,
    ) {
        GlobalEmitter::global().emit_download_state(
            id,
            url,
            download_start_time,
            plugin_id,
            state,
            error,
            failed_image_id,
            native,
        );
    }

    pub fn emitter_arc(&self) -> &'static GlobalEmitter {
        GlobalEmitter::global()
    }

    pub fn settings_arc(&self) -> &'static crate::settings::Settings {
        Settings::global()
    }

    pub fn storage(&self) -> &'static crate::storage::Storage {
        Storage::global()
    }
}

pub async fn emit_removed_after_interval(info: &ActiveDownloadInfo) {
    wait_after_non_pool_download_if_needed(info.start_time).await;
    GlobalEmitter::global().emit_download_removed(info.id);
}

async fn download_worker_loop(dq: Arc<DownloadQueue>) {
    loop {
        // 持锁期间 enable，保证"队列为空"判断与 waiter 注册之间无窗口期，
        // 防止 notify_waiters 在 worker 完成任务回到 select! 之前丢失通知。
        let job_notified = dq.job_notify.notified();
        tokio::pin!(job_notified);
        let optimistic = {
            let mut queue = dq.pending_queue.lock().await;
            job_notified.as_mut().enable();
            queue.pop_front()
        };

        let job = if let Some(job) = optimistic {
            job
        } else {
            tokio::select! {
                _ = dq.exit_notify.notified() => {
                    let desired = Settings::global()
                        .get_max_concurrent_downloads()
                        .max(1);
                    let mut total = dq.total_workers.lock().await;
                    if *total > desired {
                        *total -= 1;
                        return;
                    }
                    continue;
                }
                _ = job_notified => {
                    let mut queue = dq.pending_queue.lock().await;
                    if let Some(job) = queue.pop_front() {
                        job
                    } else {
                        continue;
                    }
                }
            }
        };

        if TaskScheduler::global().is_task_canceled(&job.task_id) {
            continue;
        }
        dq.add_active_then_prepare(&job).await;
        if TaskScheduler::global().is_task_canceled(&job.task_id) {
            dq.switch_state(job.id, DownloadState::Canceled, None).await;
            dq.wait_then_finish_download(job.id, true).await;
            continue;
        }

        let job_url = job.url.clone();
        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let download_start_time = job.download_start_time;
        let auto_deduplicate = Settings::global().get_auto_deduplicate();

        // 前去重校验：url 已在库中且源文件存在于本机，则跳过下载
        let existing_by_url = auto_deduplicate
            .then(|| Storage::find_image_by_url(job.url.as_str()).ok().flatten())
            .flatten();
        if let Some(ref existing) = existing_by_url {
            emit_task_log(
                &task_id_clone,
                "warn",
                task_log_i18n(
                    "taskLogDedupByUrl",
                    json!({
                        "currentUrl": job_url.as_str(),
                        "existingId": &existing.id,
                        "existingUrl": existing.url.as_deref().unwrap_or(""),
                        "existingPath": &existing.local_path,
                    }),
                ),
            );
            if !dq.is_download_canceled(job.id).await {
                if let Some(ref album_id) = job.output_album_id {
                    if !album_id.trim().is_empty() {
                        let added = Storage::global()
                            .add_images_to_album_silent(album_id, &[existing.id.clone()]);
                        if added > 0 {
                            let ids = vec![existing.id.clone()];
                            let alb = vec![album_id.clone()];
                            GlobalEmitter::global().emit_album_images_change("add", &alb, &ids);
                        }
                    }
                }
                if let Ok(new_count) = Storage::global().increment_task_dedup_count(&task_id_clone)
                {
                    GlobalEmitter::global().emit_task_image_counts(
                        &task_id_clone,
                        None,
                        None,
                        None,
                        Some(new_count),
                    );
                }
                dq.switch_state(job.id, DownloadState::Completed, None)
                    .await;
                clear_failed_image_after_success(job.failed_image_id);
            } else {
                dq.switch_state(job.id, DownloadState::Canceled, None).await;
            }
            dq.wait_then_finish_download(job.id, true).await;
            continue;
        }

        // file:// 不走网络下载，直接用本地路径走 postprocess（含重试场景）
        if job_url.scheme() == "file" {
            match job_url.to_file_path() {
                Ok(file_path) => {
                    dq.switch_state(job.id, DownloadState::Processing, None)
                        .await;
                    let _ = postprocess_downloaded_image(
                        &*dq,
                        job.id,
                        super::PostprocessSource::Path {
                            path: &file_path,
                            relocate_to: None,
                        },
                        false,
                        &job_url,
                        &plugin_id_clone,
                        Some(&task_id_clone),
                        job.failed_image_id,
                        None,
                        download_start_time,
                        job.output_album_id.as_deref(),
                        &job.http_headers,
                        false,
                        job.custom_display_name.as_deref(),
                        job.metadata_id,
                        job.post_url.as_deref(),
                    )
                    .await;
                }
                Err(_) => {
                    let e = "Invalid file:// URL";
                    upsert_failed_image_on_failure(
                        job.failed_image_id,
                        &task_id_clone,
                        &plugin_id_clone,
                        job_url.as_str(),
                        download_start_time as i64,
                        e,
                        &job.http_headers,
                        job.metadata_id,
                        job.custom_display_name.as_deref(),
                    );
                    dq.switch_state(job.id, DownloadState::Failed, Some(e))
                        .await;
                }
            }
            dq.wait_then_finish_download(job.id, true).await;
            continue;
        }

        // Android content:// 不走网络下载，直接交由 postprocess 用 ContentIoProvider 处理
        #[cfg(target_os = "android")]
        if job_url.scheme() == "content" {
            dq.switch_state(job.id, DownloadState::Processing, None)
                .await;
            let _ = postprocess_downloaded_image(
                &*dq,
                job.id,
                super::PostprocessSource::ContentUri,
                false,
                &job_url,
                &plugin_id_clone,
                Some(&task_id_clone),
                job.failed_image_id,
                None,
                download_start_time,
                job.output_album_id.as_deref(),
                &job.http_headers,
                false,
                job.custom_display_name.as_deref(),
                job.metadata_id,
                job.post_url.as_deref(),
            )
            .await;
            dq.wait_then_finish_download(job.id, true).await;
            continue;
        }

        dq.switch_state(job.id, DownloadState::Downloading, None)
            .await;

        let download_result = download_with_retry(
            &dq,
            &job.task_id,
            job.url.as_str(),
            &job.http_headers,
            job.id,
        )
        .await;

        match download_result {
            Ok(outcome) => {
                if !dq.is_download_canceled(job.id).await {
                    dq.switch_state(job.id, DownloadState::Processing, None)
                        .await;

                    #[cfg(target_os = "android")]
                    let postprocess_dir = crate::app_paths::AppPaths::global()
                        .cache_dir
                        .join("image-download");
                    #[cfg(not(target_os = "android"))]
                    let postprocess_dir = job.images_dir.clone();

                    let (source, delete_source) = match &outcome {
                        super::DownloadOutcome::Bytes(b) => (
                            super::PostprocessSource::Bytes {
                                output_dir: &postprocess_dir,
                                bytes: b,
                            },
                            false,
                        ),
                        super::DownloadOutcome::Path(p) => {
                            #[cfg(not(target_os = "android"))]
                            {
                                (
                                    super::PostprocessSource::Path {
                                        path: p,
                                        relocate_to: Some(&job.images_dir),
                                    },
                                    true,
                                )
                            }
                            #[cfg(target_os = "android")]
                            {
                                (
                                    super::PostprocessSource::Path {
                                        path: p,
                                        relocate_to: None,
                                    },
                                    true,
                                )
                            }
                        }
                    };

                    let _ = postprocess_downloaded_image(
                        &*dq,
                        job.id,
                        source,
                        delete_source,
                        &job_url,
                        &plugin_id_clone,
                        Some(&task_id_clone),
                        job.failed_image_id,
                        None,
                        download_start_time,
                        job.output_album_id.as_deref(),
                        &job.http_headers,
                        false,
                        job.custom_display_name.as_deref(),
                        job.metadata_id,
                        job.post_url.as_deref(),
                    )
                    .await;
                } else {
                    dq.switch_state(job.id, DownloadState::Canceled, None).await;
                }
            }
            Err(e) => {
                if !dq.is_download_canceled(job.id).await {
                    emit_task_log(
                        &task_id_clone,
                        "error",
                        task_log_i18n(
                            "taskLogDownloadFailed",
                            json!({
                                "url": job_url.as_str(),
                                "detail": e.to_string(),
                            }),
                        ),
                    );
                    upsert_failed_image_on_failure(
                        job.failed_image_id,
                        &task_id_clone,
                        &plugin_id_clone,
                        job_url.as_str(),
                        download_start_time as i64,
                        e.as_str(),
                        &job.http_headers,
                        job.metadata_id,
                        job.custom_display_name.as_deref(),
                    );
                    dq.switch_state(job.id, DownloadState::Failed, Some(&e))
                        .await;
                } else {
                    dq.switch_state(job.id, DownloadState::Canceled, None).await;
                }
            }
        }

        dq.wait_then_finish_download(job.id, true).await;
    }
}
