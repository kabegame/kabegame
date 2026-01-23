//! Daemon 状态管理模块
//!
//! 提供全局 daemon 服务状态管理，避免并发情况下重复弹窗提示。
//! 在 daemon 连接失败时弹出原生错误窗口提示用户先启动 kabegame。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// 全局 daemon 状态管理器
static DAEMON_STATUS: OnceLock<DaemonStatus> = OnceLock::new();

/// Daemon 状态管理器
struct DaemonStatus {
    /// 是否已经显示过连接失败的弹窗
    has_shown_error: AtomicBool,
}

impl DaemonStatus {
    fn new() -> Self {
        Self {
            has_shown_error: AtomicBool::new(false),
        }
    }

    /// 获取全局实例
    fn global() -> &'static Self {
        DAEMON_STATUS.get_or_init(|| Self::new())
    }

    /// 检查是否已经显示过错误弹窗
    fn has_shown_error(&self) -> bool {
        self.has_shown_error.load(Ordering::Relaxed)
    }

    /// 标记已经显示过错误弹窗
    fn mark_error_shown(&self) {
        self.has_shown_error.store(true, Ordering::Relaxed);
    }

    /// 重置错误状态（用于重新连接时）
    fn reset_error(&self) {
        self.has_shown_error.store(false, Ordering::Relaxed);
    }
}

/// 显示 daemon 连接失败的原生错误窗口
fn show_daemon_error_dialog() {
    // 防止并发重复弹窗
    let status = DaemonStatus::global();
    if status.has_shown_error() {
        return;
    }
    status.mark_error_shown();

    // 获取 daemon 路径用于错误提示
    let daemon_path = super::daemon_startup::find_daemon_executable()
        .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));

    // 弹出原生错误窗口
    let message = format!(
        "无法连接到 Kabegame 后台服务。\n\n请先启动 Kabegame 主程序：\n{}\n\n需要 Kabegame 后台服务来运行插件。",
        daemon_path.display()
    );

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let _ = Command::new("powershell")
            .args(&["-Command", &format!("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{}', '连接失败', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)", message.replace("'", "''"))])
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

/// 处理 daemon 连接错误
/// 如果是连接相关错误，显示弹窗并返回 true；否则返回 false
pub fn handle_daemon_connection_error(error: &str) -> bool {
    // 检查是否是连接相关错误
    let is_connection_error = error.contains("连接")
        || error.contains("connect")
        || error.contains("无法连接")
        || error.contains("Connection refused")
        || error.contains("No connection could be made")
        || error.contains("daemon")
        || error.contains("Daemon");

    if is_connection_error {
        show_daemon_error_dialog();
        true
    } else {
        false
    }
}

/// 重置 daemon 状态（用于重新连接时清除弹窗标记）
pub fn reset_daemon_error_status() {
    DaemonStatus::global().reset_error();
}