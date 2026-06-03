//! `UpdaterService`：后端权威的自动更新状态机（仿 `OrganizeService`）。
//!
//! 全局单例持有 `UpdaterState`；前端启动期 `get_updater_state` hydrate、之后靠
//! `updater-state-change` / `update-download-progress` / `update-download-error`
//! 事件被动刷新。`checking` 与 `downloading` 为独占、不可重入的过程态。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kabegame_core::emitter::GlobalEmitter;
use serde::Serialize;

use super::{check_updates, norm_tag, ReleaseInfo};

/// 状态机阶段，对齐用户 FSM 图（2026-06-03）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdaterPhase {
    /// 瞬时锚点：进入即自动 `run_check`，不驻留。
    Unchecked,
    /// 检查中（独占过程态：出口 success/fail）。
    Checking,
    /// 已检查、无新版（resting）。
    Checked,
    /// 有新版（resting；下载失败/取消也回到这里）。
    UpdateAvailable,
    /// 下载中（独占过程态：出口 success/fail/cancel）。
    Downloading,
    /// 已就绪，可重启安装（resting）。
    Restartable,
}

impl Default for UpdaterPhase {
    fn default() -> Self {
        UpdaterPhase::Unchecked
    }
}

/// 对前端暴露的完整状态快照。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    pub phase: UpdaterPhase,
    pub current_version: String,
    pub platform: String,
    pub mode: String,
    pub arch: String,
    pub downloadable: bool,
    pub releases: Vec<ReleaseInfo>,
    /// restartable：已下载那一版（带 v）。
    pub downloaded_tag: Option<String>,
    /// downloading：正在下载那一版（带 v）。
    pub download_tag: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// 最近一次下载错误（下载开始时清空；取消不算错误）。
    pub last_download_error: Option<String>,
}

pub struct UpdaterService {
    state: Mutex<UpdaterState>,
    /// 已下载文件路径，供 Phase 6 安装读取，不序列化给前端。
    downloaded_path: Mutex<Option<PathBuf>>,
    /// 进入 `Checking` 前的 resting phase：供 fail 回退 / restartable 保留判定。
    pre_check_phase: Mutex<UpdaterPhase>,
    /// downloading 的取消信号（仿 OrganizeService.cancel_flag）。
    download_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

static GLOBAL: OnceLock<Arc<UpdaterService>> = OnceLock::new();

impl UpdaterService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(UpdaterState::default()),
            downloaded_path: Mutex::new(None),
            pre_check_phase: Mutex::new(UpdaterPhase::Unchecked),
            download_cancel: Mutex::new(None),
        }
    }

    pub fn init_global(svc: Arc<UpdaterService>) -> Result<(), String> {
        GLOBAL
            .set(svc)
            .map_err(|_| "UpdaterService already initialized".to_string())
    }

    pub fn global() -> Arc<UpdaterService> {
        GLOBAL
            .get()
            .expect("UpdaterService not initialized")
            .clone()
    }

    /// 当前状态快照（前端 hydrate）。
    pub fn snapshot(&self) -> UpdaterState {
        self.state.lock().unwrap().clone()
    }

    fn emit_state(&self) {
        let snap = self.snapshot();
        if let Ok(value) = serde_json::to_value(&snap) {
            GlobalEmitter::global().emit("updater-state-change", value);
        }
    }

    /// 检查更新（checking 过程态）。独占、不可重入；出口 success/fail。
    pub async fn run_check(&self) {
        // 守卫：checking / downloading 期间不重入、不打断
        {
            let mut s = self.state.lock().unwrap();
            if matches!(s.phase, UpdaterPhase::Checking | UpdaterPhase::Downloading) {
                return;
            }
            *self.pre_check_phase.lock().unwrap() = s.phase.clone();
            s.phase = UpdaterPhase::Checking;
        }
        self.emit_state();

        match check_updates().await {
            Err(e) => {
                // fail 出口：回退到进入前的 resting phase，状态不丢
                eprintln!("[updater] check failed: {e}");
                {
                    let pre = self.pre_check_phase.lock().unwrap().clone();
                    self.state.lock().unwrap().phase = pre;
                }
                self.emit_state();
            }
            Ok(result) => {
                // success 出口
                let pre = self.pre_check_phase.lock().unwrap().clone();
                let mut s = self.state.lock().unwrap();
                s.current_version = result.current_version;
                s.platform = result.platform;
                s.mode = result.mode;
                s.arch = result.arch;
                s.downloadable = result.downloadable;
                s.releases = result.releases;

                let current_norm = norm_tag(&s.current_version).to_string();
                if matches!(pre, UpdaterPhase::Restartable) {
                    // restartable 保留逻辑（D4/规则5，按用户 2026-06-03 修正）
                    let remote_latest = if s.releases.is_empty() {
                        current_norm.clone()
                    } else {
                        norm_tag(&s.releases[0].tag).to_string()
                    };
                    let downloaded = s
                        .downloaded_tag
                        .as_deref()
                        .map(|t| norm_tag(t).to_string())
                        .unwrap_or_default();
                    if remote_latest == downloaded || remote_latest == current_norm {
                        s.phase = UpdaterPhase::Restartable; // 已下载仍是最新 / 远端回退 → 保留
                    } else {
                        // 出现更新版本 → 降级 + 弃旧临时包（TODO 清理）
                        s.phase = UpdaterPhase::UpdateAvailable;
                        s.downloaded_tag = None;
                    }
                } else {
                    s.phase = if s.releases.is_empty() {
                        UpdaterPhase::Checked
                    } else {
                        UpdaterPhase::UpdateAvailable
                    };
                }
                drop(s);
                self.emit_state();
            }
        }
    }

    /// 进入下载态（原子）。仅允许从 `UpdateAvailable` 进入；返回取消信号。
    pub fn try_begin_download(&self, tag: &str) -> Result<Arc<AtomicBool>, String> {
        let mut s = self.state.lock().unwrap();
        if !matches!(s.phase, UpdaterPhase::UpdateAvailable) {
            return Err(format!("updater busy: {:?}", s.phase));
        }
        s.phase = UpdaterPhase::Downloading;
        s.download_tag = Some(tag.to_string());
        s.downloaded_bytes = 0;
        s.total_bytes = None;
        s.last_download_error = None; // 下载开始时清错误
        let flag = Arc::new(AtomicBool::new(false));
        *self.download_cancel.lock().unwrap() = Some(flag.clone());
        drop(s);
        self.emit_state();
        Ok(flag)
    }

    /// 仅更新进度字段（供 hydrate 反映；不广播整快照，进度走独立事件）。
    pub fn update_progress(&self, downloaded: u64, total: Option<u64>) {
        if let Ok(mut s) = self.state.lock() {
            s.downloaded_bytes = downloaded;
            s.total_bytes = total;
        }
    }

    /// success 出口 → Restartable。
    pub fn finish_download_success(&self, tag: &str, path: PathBuf) {
        {
            let mut s = self.state.lock().unwrap();
            s.phase = UpdaterPhase::Restartable;
            s.downloaded_tag = Some(tag.to_string());
            s.download_tag = None;
        }
        *self.downloaded_path.lock().unwrap() = Some(path);
        *self.download_cancel.lock().unwrap() = None;
        self.emit_state();
    }

    /// fail 出口 → UpdateAvailable + 记错误 + 发 `update-download-error`。
    pub fn finish_download_fail(&self, msg: &str) {
        {
            let mut s = self.state.lock().unwrap();
            s.phase = UpdaterPhase::UpdateAvailable;
            s.download_tag = None;
            s.last_download_error = Some(msg.to_string());
        }
        *self.download_cancel.lock().unwrap() = None;
        self.emit_state();
        GlobalEmitter::global().emit(
            "update-download-error",
            serde_json::json!({ "message": msg }),
        );
    }

    /// cancel 出口 → UpdateAvailable（无 error）。
    pub fn finish_download_cancel(&self) {
        {
            let mut s = self.state.lock().unwrap();
            s.phase = UpdaterPhase::UpdateAvailable;
            s.download_tag = None;
            s.last_download_error = None;
        }
        *self.download_cancel.lock().unwrap() = None;
        self.emit_state();
    }

    /// 置取消信号；仅 downloading 有效。返回是否真的发起了取消。
    pub fn cancel_download(&self) -> bool {
        if let Some(flag) = self.download_cancel.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    /// 供 Phase 6 安装读取：已下载的 (tag, 临时文件路径)。
    pub fn downloaded_package(&self) -> Option<(String, PathBuf)> {
        let tag = self.state.lock().unwrap().downloaded_tag.clone()?;
        let path = self.downloaded_path.lock().unwrap().clone()?;
        Some((tag, path))
    }
}

impl Default for UpdaterService {
    fn default() -> Self {
        Self::new()
    }
}

/// 启动期调度：首检 + 24h 周期（搬离前端）。`run_check` 自带 busy 守卫。
pub fn spawn_schedule() {
    tauri::async_runtime::spawn(async {
        UpdaterService::global().run_check().await;
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        tick.tick().await; // interval 首 tick 立即触发，消费掉（首检已手动做过）
        loop {
            tick.tick().await;
            UpdaterService::global().run_check().await;
        }
    });
}
