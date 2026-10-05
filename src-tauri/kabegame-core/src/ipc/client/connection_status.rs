//! IPC 连接状态管理模块。
//!
//! 避免并发连接失败时重复弹窗，并提示用户启动 Kabegame 主程序。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// 全局 IPC 连接状态管理器。
static IPC_CONNECTION_STATUS: OnceLock<IpcConnectionStatus> = OnceLock::new();

struct IpcConnectionStatus {
    /// 是否已经显示过连接失败的弹窗
    has_shown_error: AtomicBool,
}

impl IpcConnectionStatus {
    fn new() -> Self {
        Self {
            has_shown_error: AtomicBool::new(false),
        }
    }

    /// 获取全局实例
    fn global() -> &'static Self {
        IPC_CONNECTION_STATUS.get_or_init(|| Self::new())
    }

    /// 检查是否已经显示过错误弹窗
    fn has_shown_error(&self) -> bool {
        self.has_shown_error.load(Ordering::Relaxed)
    }

    /// 标记已经显示过错误弹窗
    fn mark_error_shown(&self) {
        self.has_shown_error.store(true, Ordering::Relaxed);
    }
}

/// 显示 IPC 连接失败的原生错误窗口。
fn show_ipc_error_dialog() {
    // 防止并发重复弹窗
    let status = IpcConnectionStatus::global();
    if status.has_shown_error() {
        return;
    }
    status.mark_error_shown();

    // 弹出原生错误窗口
    let message = "无法连接到 Kabegame 主程序的 IPC 服务。\n\n请先启动 Kabegame 主程序。";

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        // CREATE_NO_WINDOW:隐藏 PowerShell 控制台窗口,只弹出其中的 MessageBox。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("powershell")
            .args(&["-Command", &format!("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{}', '连接失败', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)", message.replace("'", "''"))])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let _ = Command::new("zenity")
            .args(&["--error", "--text", &message, "--title", "连接失败"])
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("osascript")
            .args(&["-e", &format!("display dialog \"{}\" with title \"连接失败\" buttons {{\"确定\"}} default button \"确定\" with icon stop", message.replace("\"", "\\\""))])
            .output();
    }
}

/// 处理 IPC 连接错误。
/// 如果是连接相关错误，显示弹窗并返回 true；否则返回 false
pub fn handle_ipc_connection_error(error: &str) -> bool {
    // 检查是否是连接相关错误
    let is_connection_error = error.contains("连接")
        || error.contains("connect")
        || error.contains("无法连接")
        || error.contains("Connection refused")
        || error.contains("No connection could be made");

    if is_connection_error {
        show_ipc_error_dialog();
        true
    } else {
        false
    }
}
