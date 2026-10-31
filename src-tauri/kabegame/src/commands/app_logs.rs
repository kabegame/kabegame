//! 应用日志命令：读取最近日志、查看器打开期间经 Channel 推送实时日志、打开日志目录。
//! 见 `cocs/debug/APP_LOGGING.md`。

use kabegame_core::ipc::events::{AppEvent, AppEventKind};
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::logging::{recent_logs, LogRecord, RECENT_CAPACITY};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
#[cfg(not(target_os = "android"))]
use tauri::{AppHandle, Runtime};

/// 一批最多条数与攒批窗口：日志突发时不逐条 emit。
const BATCH_MAX: usize = 200;
const BATCH_WINDOW: Duration = Duration::from_millis(200);

/// 当前推送任务及其 Channel id；同一时刻只有一个查看器。
static FORWARDER: Mutex<Option<(u32, tauri::async_runtime::JoinHandle<()>)>> = Mutex::new(None);

/// 环形缓冲里 `since_seq` 之后最新的至多 `limit` 条日志，按 seq 升序。
#[tauri::command]
pub fn get_app_logs(since_seq: Option<u64>, limit: Option<usize>) -> Vec<LogRecord> {
    recent_logs(since_seq, limit.unwrap_or(RECENT_CAPACITY))
}

/// 查看器打开时调用：替换掉之前的推送任务（页面重载后旧 Channel 已失效），日志每 200ms
/// 攒批经 `on_logs` 推回调用的页面。
///
/// 用 Channel 而不是全局事件：Channel 只回到开启查看器的那个页面，日志不会进入事件系统。
/// （tauri 补丁 14 起 `emit_to("main", ..)` 也只会送到主窗口；补丁 15 起其它窗口只能监听
/// capability 里列出的事件名。）
#[tauri::command]
pub fn start_app_log_stream(on_logs: Channel<Vec<LogRecord>>) {
    let mut forwarder = FORWARDER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, handle)) = forwarder.take() {
        handle.abort();
    }
    let id = on_logs.id();
    *forwarder = Some((id, tauri::async_runtime::spawn(forward_logs(on_logs))));
}

/// 查看器关闭时调用，`stream_id` 是开启时那个 Channel 的 id：只停自己开的推送，
/// 避免「关了又立刻开」时迟到的关闭请求把新任务停掉。
#[tauri::command]
pub fn stop_app_log_stream(stream_id: u32) {
    let mut forwarder = FORWARDER.lock().unwrap_or_else(|e| e.into_inner());
    if forwarder.as_ref().is_some_and(|(id, _)| *id == stream_id) {
        if let Some((_, handle)) = forwarder.take() {
            handle.abort();
        }
    }
}

/// 打开日志目录（桌面）。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn open_logs_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = kabegame_core::app_paths::AppPaths::global().logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    super::filesystem::open_with_default(&app, &dir.to_string_lossy())
}

/// 本函数处在日志管线上：不要在这里打 trace 以上的日志，否则每推一条就会再产生一条。
async fn forward_logs(channel: Channel<Vec<LogRecord>>) {
    let mut rx = EventBroadcaster::global().subscribe_filtered_stream(&[AppEventKind::Log]);
    let mut batch: Vec<LogRecord> = Vec::new();
    while let Some((_, event)) = rx.recv().await {
        push_record(&mut batch, &event);
        let window = tokio::time::sleep(BATCH_WINDOW);
        tokio::pin!(window);
        while batch.len() < BATCH_MAX {
            tokio::select! {
                _ = &mut window => break,
                next = rx.recv() => match next {
                    Some((_, event)) => push_record(&mut batch, &event),
                    None => break,
                },
            }
        }
        // 页面关闭或重载后 Channel 失效，任务随之结束。
        if channel.send(std::mem::take(&mut batch)).is_err() {
            break;
        }
    }
}

fn push_record(batch: &mut Vec<LogRecord>, event: &AppEvent) {
    if let AppEvent::Log { record } = event {
        batch.push(record.clone());
    }
}
