//! Daemon 启动管理模块
//!
//! 提供统一的 daemon 启动和等待逻辑，支持：
//! - 自动查找 daemon 可执行文件
//! - 启动 daemon（如果未运行）
//! - 等待 daemon 就绪（10 秒超时）
//! - 支持 Tauri AppHandle 和普通路径查找两种模式

use crate::bin_finder::{find_binary, BinaryType};
use crate::ipc::{ConnectionStatus, IpcClient};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
// debug 断言
#[cfg(debug_assertions)]
use std::backtrace::Backtrace;

pub static IPC_CLIENT: OnceLock<IpcClient> = OnceLock::new();

/// 获取 IPC 客户端实例（单例）
pub fn get_ipc_client() -> &'static IpcClient {
    IPC_CLIENT.get_or_init(|| IpcClient::new())
}

/// 检查 daemon 是否可用
pub async fn is_daemon_available() -> bool {
    match get_ipc_client().status().await {
        Ok(_) => true,
        Err(e) => {
            eprintln!("daemon 不可用: {}", e);
            // eprintln!("backtrace: {:?}", std::backtrace::Backtrace::capture());
            false
        }
    }
}

/// 查找 daemon 可执行文件路径（基础版本，不依赖 tauri）
///
/// 查找顺序：
/// 1. (Linux 生产环境) 从 PATH 中查找 `kabegame-daemon`
/// 2. 当前可执行文件同目录下的 `kabegame-daemon` / `kabegame-daemon.exe`
pub fn find_daemon_executable() -> Result<PathBuf, String> {
    find_binary(BinaryType::Daemon)
}

/// 确保 daemon 已启动并可用（如果不可用则自动启动）（基础版本，不依赖 tauri）
///
/// 查找 daemon 可执行文件的顺序：
/// 1. 当前可执行文件同目录下的 `kabegame-daemon` / `kabegame-daemon.exe`
///
/// 超时时间：10 秒
pub async fn ensure_daemon_ready_basic() -> Result<PathBuf, String> {
    use std::sync::Mutex;

    // 使用静态互斥锁避免并发重复启动
    static STARTING: Mutex<bool> = Mutex::new(false);

    // 先快速检查 daemon 是否已可用
    if is_daemon_available().await {
        // 返回找到的 daemon 路径（用于错误提示）
        return find_daemon_executable();
    }

    // 尝试获取锁，如果正在启动则等待
    let should_wait = {
        let mut starting = STARTING.lock().unwrap();
        if *starting {
            // 其他线程正在启动，需要等待
            true
        } else {
            // 标记为正在启动
            *starting = true;
            false
        }
    };

    if should_wait {
        // 其他线程正在启动，等待最多 10 秒
        let timeout = Duration::from_secs(10);
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            if is_daemon_available().await {
                let mut starting = STARTING.lock().unwrap();
                *starting = false;
                return find_daemon_executable();
            }
        }
        let mut starting = STARTING.lock().unwrap();
        *starting = false;
        let daemon_path = find_daemon_executable()?;
        return Err(format!(
            "等待 daemon 启动超时（10 秒）\n请检查 {} 能否正常启动",
            daemon_path.display()
        ));
    }

    // 查找 daemon 可执行文件
    let daemon_exe = find_daemon_executable()?;

    use crate::bin_finder::{execute_binary_at_path, BinaryType, ExecuteOptions};
    let mut exec_opts = ExecuteOptions {
        args: Vec::new(),
        background: true,
        wait: false,
        ..Default::default()
    };
    execute_binary_at_path(&daemon_exe, BinaryType::Daemon, &mut exec_opts)?;

    // 等待 daemon 就绪（最多 10 秒）
    let timeout = Duration::from_secs(10);
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        // 尝试连接 daemon
        if let Ok(_) = get_ipc_client().connect().await {
            // 连接成功，验证状态
            if is_daemon_available().await {
                let mut starting = STARTING.lock().unwrap();
                *starting = false;
                return Ok(daemon_exe);
            }
        }
    }

    let mut starting = STARTING.lock().unwrap();
    *starting = false;
    Err(format!(
        "daemon 启动后未能在 10 秒内就绪\n请检查 {} 能否正常启动",
        daemon_exe.display()
    ))
}

/// 确保 daemon 已启动并可用（如果不可用则自动启动）（完整版本，支持 Tauri resources）
///
/// 查找 daemon 可执行文件的顺序：
/// 1. 当前可执行文件同目录下的 `kabegame-daemon` / `kabegame-daemon.exe`
/// 2. Tauri resources 目录下的 `bin/kabegame-daemon` / `bin/kabegame-daemon.exe`（如果提供了 app_handle）
///
/// 超时时间：10 秒
pub async fn ensure_daemon_ready() -> Result<PathBuf, String> {
    // 先快速检查 daemon 是否已可用
    if is_daemon_available().await {
        // 返回找到的 daemon 路径（用于错误提示）
        return find_daemon_executable();
    }

    // 查找 daemon 可执行文件
    let daemon_exe = find_daemon_executable()?;

    eprintln!("查找 daemon 可执行文件: {}", daemon_exe.display());

    // 使用基础版本的启动逻辑（共享互斥锁）
    // 注意：这里我们需要确保只启动一次，所以复用基础版本的逻辑

    use std::sync::Mutex;
    static STARTING: Mutex<bool> = Mutex::new(false);

    let should_wait = {
        let mut starting = STARTING.lock().unwrap();
        if *starting {
            true
        } else {
            *starting = true;
            false
        }
    };

    if should_wait {
        // 其他线程正在启动，等待最多 10 秒
        let timeout = Duration::from_secs(10);
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            if is_daemon_available().await {
                let mut starting = STARTING.lock().unwrap();
                *starting = false;
                return Ok(daemon_exe.clone());
            }
        }
        let mut starting = STARTING.lock().unwrap();
        *starting = false;
        return Err(format!(
            "等待 daemon 启动超时（10 秒）\n请检查 {} 能否正常启动",
            daemon_exe.display()
        ));
    }

    use crate::bin_finder::{execute_binary_at_path, BinaryType, ExecuteOptions};
    let mut exec_opts = ExecuteOptions {
        args: Vec::new(),
        background: true,
        wait: false,
        ..Default::default()
    };
    execute_binary_at_path(&daemon_exe, BinaryType::Daemon, &mut exec_opts)?;

    // 等待 daemon 就绪（最多 10 秒）
    let timeout = Duration::from_secs(10);
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        // 尝试连接 daemon
        if let Ok(_) = get_ipc_client().connect().await {
            // 连接成功，验证状态
            if is_daemon_available().await {
                let mut starting = STARTING.lock().unwrap();
                *starting = false;
                return Ok(daemon_exe);
            }
        }
    }

    let mut starting = STARTING.lock().unwrap();
    *starting = false;
    Err(format!(
        "daemon 启动后未能在 10 秒内就绪\n请检查 {} 能否正常启动",
        daemon_exe.display()
    ))
}

/// 启动连接状态监听任务（Tauri 版本）
///
/// 监听 IPC 连接状态变化，并在状态变化时发送 Tauri 事件。
///
/// - `app`: Tauri AppHandle，用于发送事件
/// - `connected_event`: 连接建立时发送的事件名（例如 "daemon-ready"）
/// - `disconnected_event`: 连接断开时发送的事件名（例如 "daemon-offline"）
#[cfg(any(feature = "custom-protocol", feature = "tauri-runtime"))]
pub fn spawn_connection_status_watcher(
    app: tauri::AppHandle,
    connected_event: &'static str,
    disconnected_event: &'static str,
) {
    use tauri::Emitter;

    let mut status_rx = get_ipc_client().subscribe_connection_status();
    let app_for_connected = app.clone();
    let app_for_disconnected = app.clone();

    // 使用 tauri::async_runtime::spawn 避免在 setup 时没有 tokio runtime 的问题
    tauri::async_runtime::spawn(async move {
        // 跳过初始值，只监听变化
        let mut last_status = *status_rx.borrow();

        loop {
            if status_rx.changed().await.is_err() {
                eprintln!("[connection_status_watcher] 状态通道已关闭");
                break;
            }

            let current_status = *status_rx.borrow();

            // 只在状态从非 Connected -> Connected 或非 Disconnected -> Disconnected 时发送事件
            match (last_status, current_status) {
                (
                    ConnectionStatus::Disconnected | ConnectionStatus::Connecting,
                    ConnectionStatus::Connected,
                ) => {
                    eprintln!(
                        "[connection_status_watcher] 连接已建立，发送 {}",
                        connected_event
                    );
                    let _ = app_for_connected.emit(connected_event, serde_json::json!({}));
                }
                (
                    ConnectionStatus::Connected | ConnectionStatus::Connecting,
                    ConnectionStatus::Disconnected,
                ) => {
                    eprintln!(
                        "[connection_status_watcher] 连接已断开，发送 {}",
                        disconnected_event
                    );
                    let _ = app_for_disconnected.emit(disconnected_event, serde_json::json!({}));
                }
                _ => {
                    // Connecting 状态不发送事件
                }
            }

            last_status = current_status;
        }
    });
}
