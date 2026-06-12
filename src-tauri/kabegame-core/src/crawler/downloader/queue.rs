use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, RwLock};
use url::Url;

use super::postprocess_downloaded_image;
use super::NativeDownloadState;
use super::{download_with_retry, emit_task_log, wait_after_pool_download_if_needed};

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
            Preparing => matches!(next, Downloading | Processing | Canceled | Failed),
            // Downloading → Downloading 为 browser 流幂等重发
            Downloading => {
                matches!(
                    next,
                    Downloading | Processing | Completed | Canceled | Failed
                )
            }
            Processing => matches!(next, Completed | Canceled | Failed),
            Completed | Canceled | Failed => false,
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
    // 请求url，由schema+path
    pub url: Url,
    // 下载目录
    pub images_dir: PathBuf,
    // 插件id，当schema为file时忽略（本地文件）
    pub plugin_id: String,
    // 任务id
    pub task_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
    pub failed_image_id: Option<i64>,
    /// 脚本/爬虫指定的展示名；为空则沿用文件名或 URL 推断。
    pub custom_display_name: Option<String>,
    /// 已写入 `image_metadata` 的 id。
    pub metadata_id: Option<i64>,
}

#[derive(Debug)]
pub struct DownloadPoolState {
    pub in_flight: u32,
    pub queue: VecDeque<DownloadRequest>,
}

impl DownloadPoolState {
    fn has_capacity(&self, desired: u32) -> bool {
        self.in_flight < desired
    }

    fn start_download(&mut self, request: DownloadRequest) {
        self.queue.push_back(request);
        self.in_flight = self.in_flight.saturating_add(1);
    }

    fn finish_download(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}

#[derive(Debug)]
pub struct DownloadPool {
    /// 当前存在的 worker 数量，由 worker 退出时减 1
    pub total_workers: Mutex<u32>,
    pub state: Mutex<DownloadPoolState>,
    /// 有新的 job 时 notify，worker 在 loop 开头 select 等此信号
    pub job_notify: Notify,
    /// 需要缩减 worker 时 notify_one，worker 被唤醒后从设置取 desired，若 total > desired 则减 1 并退出
    pub exit_notify: Notify,
    /// 当 worker 完成时 notify_waiters，唤醒等待入队的 download() 调用者
    pub capacity_notify: Notify,
}

impl DownloadPool {
    pub fn new(_initial_workers: u32) -> Self {
        Self {
            total_workers: Mutex::new(0),
            state: Mutex::new(DownloadPoolState {
                in_flight: 0,
                queue: VecDeque::new(),
            }),
            job_notify: Notify::new(),
            exit_notify: Notify::new(),
            capacity_notify: Notify::new(),
        }
    }

    async fn finish_one_download(&self) {
        let mut state = self.state.lock().await;
        state.finish_download();
        self.capacity_notify.notify_waiters(); // 唤醒所有等待入队的 download() 调用
    }
}

#[derive(Clone)]
pub struct DownloadQueue {
    pub pool: Arc<DownloadPool>,
    pub active_downloads: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    pub canceled_downloads: Arc<RwLock<HashSet<String>>>,
}

impl DownloadQueue {
    // new 的时候先只创建一个下载线程，等 init 阶段完成之后，再手动扩容（用 set_desired_concurrency_from_settings）
    pub fn new() -> Self {
        let pool = Arc::new(DownloadPool::new(1));
        Self {
            pool: Arc::clone(&pool),
            active_downloads: Arc::new(Mutex::new(Vec::new())),
            canceled_downloads: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub async fn start_download_workers(&self, count: u32) {
        let n = count.max(1);
        {
            let mut total = self.pool.total_workers.lock().await;
            *total += n;
        }
        for _ in 0..n {
            let dq = Arc::new(self.clone());
            tokio::spawn(async move { download_worker_loop(dq).await });
        }
    }

    pub async fn set_desired_concurrency_from_settings(&self) {
        let desired = Settings::global().get_max_concurrent_downloads().max(1);
        let mut total = self.pool.total_workers.lock().await;
        if *total < desired {
            let add = desired - *total;
            *total = desired;
            drop(total);
            for _ in 0..add {
                let dq = Arc::new(self.clone());
                tokio::spawn(async move { download_worker_loop(dq).await });
            }
            self.pool.job_notify.notify_waiters();
            self.pool.capacity_notify.notify_waiters(); // 增加并发上限后，唤醒等待中的 download() 调用
        } else if *total > desired {
            let exit_count = *total - desired;
            drop(total);
            for _ in 0..exit_count {
                self.pool.exit_notify.notify_one();
            }
        }
    }

    pub fn notify_all_waiting(&self) {
        self.pool.job_notify.notify_waiters();
    }

    pub async fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let tasks = self.active_downloads.lock().await;
        let mut all = tasks.clone();
        drop(tasks);
        all.extend(NativeDownloadState::global().get_active_downloads());
        Ok(all)
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
    ) -> Result<(), String> {
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
        )
        .await
    }

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
    ) -> Result<(), String> {
        // 检查下载是否取消
        if self.is_download_canceled(&task_id).await {
            return Err("Task canceled".to_string());
        }

        // 如果这是一个失败重试，且当前已经在重试中了，则跳过
        if let Some(fid) = failed_image_id {
            let active = self.active_downloads.lock().await;
            if active.iter().any(|t| t.retried_for == Some(fid)) {
                drop(active);
                emit_task_log(
                    &task_id,
                    "info",
                    format!(
                        "Retry for failed image {} is already in progress, skipping",
                        fid
                    ),
                );
                return Ok(());
            }
        }

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
        };

        loop {
            let notified = self.pool.capacity_notify.notified();
            tokio::pin!(notified);

            {
                let mut pool_st = self.pool.state.lock().await;
                let desired = Settings::global().get_max_concurrent_downloads().max(1);
                if pool_st.has_capacity(desired) {
                    pool_st.start_download(request);
                    drop(pool_st);
                    self.pool.job_notify.notify_one();
                    return Ok(());
                }
                notified.as_mut().enable(); // 注册等待（在持锁期间），防止错过通知
            }
            // 锁已释放，安全 await
            notified.await;

            if self.is_download_canceled(&task_id).await {
                return Err("Task canceled".to_string());
            }
        }
    }

    pub async fn cancel_download(&self, task_id: &str) {
        let mut canceled = self.canceled_downloads.write().await;
        canceled.insert(task_id.to_string());
        drop(canceled);
        self.pool.capacity_notify.notify_waiters(); // 唤醒被阻塞的 download() 调用，让它们检查取消状态
    }

    pub async fn is_download_canceled(&self, task_id: &str) -> bool {
        let c = self.canceled_downloads.read().await;
        c.contains(task_id)
    }

    /// 同步版本，供非 async 上下文调用（内部 block_on）。
    pub fn is_download_canceled_blocking(&self, task_id: &str) -> bool {
        tokio::runtime::Handle::current().block_on(self.is_download_canceled(task_id))
    }

    /// 将 job 加入 active_downloads 并发送 Preparing 事件。
    pub async fn begin_active(&self, job: &DownloadRequest) {
        let info = ActiveDownloadInfo {
            id: job.id,
            url: job.url.to_string(),
            plugin_id: job.plugin_id.clone(),
            start_time: job.download_start_time,
            task_id: job.task_id.clone(),
            state: DownloadState::Preparing,
            native: false,
            retried_for: job.failed_image_id,
        };
        {
            let mut tasks = self.active_downloads.lock().await;
            tasks.push(info);
        }
        GlobalEmitter::global().emit_download_state(
            &job.task_id,
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

    /// 按 id 切换 active_downloads 状态 + 发事件。状态机非法跳转直接拒绝（不改不发，warn 日志）。
    /// 返回 true 表示已切换并发送事件。
    pub async fn switch_state(&self, id: u64, next: DownloadState, error: Option<&str>) -> bool {
        let mut downloads = self.active_downloads.lock().await;
        if let Some(t) = downloads.iter_mut().find(|t| t.id == id) {
            let current = t.state;
            if !current.can_transition_to(next) {
                eprintln!(
                    "[DownloadQueue] Illegal state transition: {:?} -> {:?} (id={})",
                    current, next, id
                );
                return false;
            }
            t.state = next;
            let task_id = t.task_id.clone();
            let url = t.url.clone();
            let start_time = t.start_time;
            let plugin_id = t.plugin_id.clone();
            let retried_for = t.retried_for;
            let native = t.native;

            drop(downloads);
            GlobalEmitter::global().emit_download_state(
                &task_id,
                id,
                &url,
                start_time,
                &plugin_id,
                next,
                error,
                retried_for,
                native,
            );

            return true;
        }
        false
    }

    /// 等待一段时间后，从 active_downloads 中移除 id 对应的条目，并发送事件
    pub async fn wait_then_finish_download(&self, id: u64) {
        // 等待一段事件
        wait_after_pool_download_if_needed(&self.pool).await;

        self.finish_download(id).await;
    }

    /// 减少一个下载空位，从 active_downloads 中移除 id 对应的条目。
    pub async fn finish_download(&self, id: u64) {
        self.pool.finish_one_download().await;
        let mut tasks = self.active_downloads.lock().await;

        let task_id = tasks.iter().find(|t| t.id == id).map(|t| t.task_id.clone());

        tasks.retain(|t| t.id != id);

        if let Some(task_id) = task_id {
            GlobalEmitter::global().emit_download_removed(&task_id, id);
        }
    }

    /// 直接发送 download-state 事件（不过状态机，用于无 active_downloads 条目的终态发送）。
    pub fn emit_state(
        &self,
        event_task_id: &str,
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
            event_task_id,
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

async fn download_worker_loop(dq: Arc<DownloadQueue>) {
    let pool = Arc::clone(&dq.pool);
    loop {
        // 取下载任务
        let job = tokio::select! {
            _ = pool.exit_notify.notified() => {
                let desired = Settings::global()
                    .get_max_concurrent_downloads()
                    .max(1);
                let mut total = pool.total_workers.lock().await;
                if *total > desired {
                    *total -= 1;
                    return;
                }
                continue;
            }
            _ = pool.job_notify.notified() => {
                let mut st = pool.state.lock().await;

                if let Some(job) = st.queue.pop_front() {
                    job
                } else {
                    continue;
                }
            }
        };

        // 取出任务后，添加到 active_downloads 并发送 Preparing 事件（实际上没有必要，一瞬间就转变成下载中了）
        dq.begin_active(&job).await;

        let job_url = job.url.clone();
        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let download_start_time = job.download_start_time;
        let auto_deduplicate = Settings::global().get_auto_deduplicate();

        dq.switch_state(job.id, DownloadState::Downloading, None)
            .await;

        // 图片且开启去重时：若 URL 已在库中且源文件存在于本机，则跳过下载，仅入画册+发事件
        // 前去重校验：url，下载完成之后还有一个哈希的后去重校验
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
            // 检查任务是否取消，决定是否执行 入画册+任务去重字段+1
            if !dq.is_download_canceled(&task_id_clone).await {
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
            // 结束下载
            dq.wait_then_finish_download(job.id).await;
            continue;
        }

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
                // 后处理：processing 状态、去重逻辑、缩略图、入库、入画册、发事件
                if dq.is_download_canceled(&task_id_clone).await {
                    dq.switch_state(job.id, DownloadState::Canceled, None).await;
                } else {
                    dq.switch_state(job.id, DownloadState::Processing, None)
                        .await;

                    #[cfg(target_os = "android")]
                    let postprocess_dir = crate::app_paths::AppPaths::global()
                        .cache_dir
                        .join("image-download");
                    #[cfg(not(target_os = "android"))]
                    let postprocess_dir = job.images_dir.clone();

                    let (source, delete_soruce) = match &outcome {
                        super::DownloadOutcome::Bytes(b) => (super::PostprocessSource::Bytes {
                            output_dir: &postprocess_dir,
                            bytes: b,
                        }, false),
                        super::DownloadOutcome::Path(p) => {
                            #[cfg(not(target_os = "android"))]
                            {( super::PostprocessSource::Path { path: p, relocate_to: Some(&job.images_dir) } , true)}
                            #[cfg(target_os = "android")]
                            {( super::PostprocessSource::Path { path: p, relocate_to: None } , true)}
                        }
                    };

                    let _ = postprocess_downloaded_image(
                        &*dq,
                        job.id,
                        source,
                        delete_soruce,
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
                    )
                    .await;
                }
            }
            Err(e) => {
                if !e.contains("Task canceled") {
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
                }
                if !e.contains("Task canceled") {
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
                }
                let state = if e.contains("Task canceled") {
                    DownloadState::Canceled
                } else {
                    DownloadState::Failed
                };
                dq.switch_state(job.id, state, Some(&e)).await;
                if !e.contains("Task canceled") {
                    GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                }
            }
        }

        // 两个分支的公共收尾：扣减 in_flight、通知
        dq.wait_then_finish_download(job.id).await;
    }
}
