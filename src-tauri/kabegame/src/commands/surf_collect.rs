//! 畅游「一键下载」：Rust 是运行状态的唯一权威。
//!
//! - 内容页脚本（`webview_js/surf_collect.js`，封闭 IIFE、不挂 window 全局）在页面加载时经
//!   `surf_collect_attach` 交来一条 Tauri `Channel`；Rust 只经它向页面发 `start` / `cancel`。
//!   不给 remote 站点开 `core:event:*`（否则任意站点可监听应用全局广播）。
//! - 导航栏只调 `surf_collect_toggle`：空闲则开跑，运行中则取消；转圈状态由 Rust 经
//!   `surf-collect-state` 事件定向推给导航栏。
//! - 取消后 `surf_download_image(collectRunId)` 在 Rust 侧直接拒绝，Channel 消息迟到也不会多下。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use kabegame_core::media::image_type::{supported_image_extensions, supported_video_extensions};
use kabegame_core::settings::Settings;
use kabegame_core::storage::page_snapshot::{PAGE_SNAPSHOT_KIND, SURF_METADATA_VERSION};
use kabegame_core::storage::Storage;
use kabegame_i18n::t;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime, Webview};

use super::surf::{host_from_surf_label, is_surf_content_label, normalize_surf_host, surf_label};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectTexts {
    detecting: String,
    none: String,
    found: String,
    canceled: String,
    done: String,
    snapshot_failed: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CollectMsg {
    #[serde(rename_all = "camelCase")]
    Start {
        run_id: u64,
        freeze: bool,
        image_extensions: Vec<String>,
        video_extensions: Vec<String>,
        texts: CollectTexts,
    },
    #[serde(rename_all = "camelCase")]
    Cancel { run_id: u64 },
}

#[derive(Default)]
struct Slot {
    channel: Option<Channel<CollectMsg>>,
    active_run: Option<u64>,
}

/// key 为内容 webview label（`surf-<host>`）。
static SLOTS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(Default::default);
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

fn navbar_label(content_label: &str) -> String {
    format!("{content_label}-navbar")
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, content_label: &str, running: bool) {
    let _ = app.emit_to(
        navbar_label(content_label).as_str(),
        "surf-collect-state",
        json!({ "running": running }),
    );
}

fn content_label_of<R: Runtime>(webview: &Webview<R>) -> Result<String, String> {
    let label = webview.label().to_string();
    if !is_surf_content_label(&label) {
        return Err(format!("Not a surf content webview: {label}"));
    }
    Ok(label)
}

fn collect_texts() -> CollectTexts {
    CollectTexts {
        detecting: t!("surf.collect.detecting"),
        none: t!("surf.collect.none"),
        found: t!("surf.collect.found"),
        canceled: t!("surf.collect.canceled"),
        done: t!("surf.collect.done"),
        snapshot_failed: t!("surf.collect.snapshotFailed"),
    }
}

/// `surf_download_image` / `surf_save_page_snapshot` 用：该 run 是否仍在进行（未取消、未结束）。
pub(crate) fn is_run_active(content_label: &str, run_id: u64) -> bool {
    SLOTS
        .lock()
        .map(|slots| {
            slots
                .get(content_label)
                .is_some_and(|slot| slot.active_run == Some(run_id))
        })
        .unwrap_or(false)
}

/// 内容页整页导航开始：旧页脚本即将销毁，结束其 run 并让导航栏停止转圈。
/// 不清 channel——新页脚本的 attach 可能先于本回调到达，由 attach 覆盖即可。
pub fn on_content_page_started<R: Runtime>(app: &AppHandle<R>, content_label: &str) {
    let had_run = SLOTS
        .lock()
        .ok()
        .and_then(|mut slots| slots.get_mut(content_label).and_then(|s| s.active_run.take()))
        .is_some();
    if had_run {
        emit_state(app, content_label, false);
    }
}

/// surf 窗口销毁时移除状态。
pub fn drop_slot(content_label: &str) {
    if let Ok(mut slots) = SLOTS.lock() {
        slots.remove(content_label);
    }
}

/// 内容页脚本在每次页面加载时调用，登记接收 start/cancel 的 Channel。
#[tauri::command]
pub async fn surf_collect_attach<R: Runtime>(
    webview: Webview<R>,
    on_event: Channel<CollectMsg>,
) -> Result<(), String> {
    let label = content_label_of(&webview)?;
    let mut slots = SLOTS.lock().map_err(|e| format!("Lock error: {e}"))?;
    slots.entry(label).or_default().channel = Some(on_event);
    Ok(())
}

/// 导航栏按钮：空闲时开始一键下载，运行中则取消。
#[tauri::command]
pub async fn surf_collect_toggle<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let label = surf_label(&normalize_surf_host(&host));
    let mut slots = SLOTS.lock().map_err(|e| format!("Lock error: {e}"))?;
    let slot = slots.entry(label.clone()).or_default();

    if let Some(run_id) = slot.active_run.take() {
        // 先停转圈再通知页面：取消的反馈不等页面往返。
        emit_state(&app, &label, false);
        if let Some(channel) = slot.channel.as_ref() {
            let _ = channel.send(CollectMsg::Cancel { run_id });
        }
        return Ok(());
    }

    let Some(channel) = slot.channel.as_ref() else {
        return Err(t!("surf.collect.notReady"));
    };
    let run_id = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
    channel
        .send(CollectMsg::Start {
            run_id,
            freeze: Settings::global().get_surf_freeze_page(),
            image_extensions: supported_image_extensions(),
            video_extensions: supported_video_extensions(),
            texts: collect_texts(),
        })
        .map_err(|e| format!("{}: {e}", t!("surf.collect.notReady")))?;
    slot.active_run = Some(run_id);
    emit_state(&app, &label, true);
    Ok(())
}

/// 内容页一次运行结束（完成或取消）时调用。
/// `queued == 0` 时快照无人引用，立即回收，避免孤儿 metadata。
#[tauri::command]
pub async fn surf_collect_finished<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    run_id: u64,
    queued: u32,
    metadata_id: Option<i64>,
) -> Result<(), String> {
    let label = content_label_of(&webview)?;
    let was_active = {
        let mut slots = SLOTS.lock().map_err(|e| format!("Lock error: {e}"))?;
        match slots.get_mut(&label) {
            Some(slot) if slot.active_run == Some(run_id) => {
                slot.active_run = None;
                true
            }
            _ => false,
        }
    };
    if was_active {
        emit_state(&app, &label, false);
    }

    if let (0, Some(id)) = (queued, metadata_id) {
        let host = host_from_surf_label(&label).unwrap_or_default();
        let storage = Storage::global();
        if storage.metadata_plugin_id(id)?.as_deref() == Some(host.as_str()) {
            storage.gc_metadata(&[id])?;
        }
    }
    Ok(())
}

/// 冻结当前页：HTML+CSS 快照写入 metadata 表一次，返回 id 供同批下载共享。
#[tauri::command]
pub async fn surf_save_page_snapshot<R: Runtime>(
    webview: Webview<R>,
    run_id: u64,
    snapshot: Value,
) -> Result<i64, String> {
    let label = content_label_of(&webview)?;
    if !is_run_active(&label, run_id) {
        return Err(t!("surf.collect.canceled"));
    }
    let host = host_from_surf_label(&label).ok_or_else(|| format!("Invalid surf label: {label}"))?;

    let text = |key: &str| {
        snapshot
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let page_html = text("pageHtml");
    let value = json!({
        "kind": PAGE_SNAPSHOT_KIND,
        "schemaVersion": 1,
        "sourceUrl": text("sourceUrl"),
        "documentUrl": text("documentUrl"),
        "title": text("title"),
        "pageHtml": page_html,
        "capturedAt": super::crawler::now_ms(),
    });
    // 空 / 超限由 core 的 page_snapshot::validate 拒绝；search_text 只含标题与 URL 也由 core 统一处理。
    Storage::global().insert_metadata_row(&value, &host, SURF_METADATA_VERSION)
}
